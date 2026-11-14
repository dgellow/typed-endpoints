import { writeFile } from "node:fs/promises";
import { denoEval, isDeno } from "../core/runtime.ts";
import type { AnyPaginationMeta } from "../pagination/types.ts";
import {
  apiPathToClientTemplate,
  apiPathToTemplate,
  capitalize,
  deriveOperationId,
  fileUrlOf,
  HTTP_METHODS,
  httpMethodToResourceMethod,
  listRouteFiles,
  pathToResourceSegments,
  type RouteConvention,
  routeOfFile,
} from "../core/routes.ts";
import { pathToTypeName } from "./path.ts";
import { isIdentifier } from "./zod.ts";
import {
  type ExtractedMethod,
  type Extraction,
  type ExtractOptions,
  extractRoutes,
  type MethodSchemas,
  type RouteSource,
} from "./extract.ts";

/** Options of `generateTypes()`. */
export interface TypeGenOptions {
  /** Directories containing route files. Defaults to ["routes/api"] */
  readonly routesDirs?: readonly string[];
  /** Output file path. If provided, writes generated types to this file */
  readonly output?: string;
  /**
   * Path to deno.json config file. When provided, route files are imported
   * in a subprocess that uses the config's import map. This is needed when
   * running the CLI as an external package.
   *
   * Deno only. Bun and Node resolve a route file's imports from the file
   * itself, so the option has no effect there.
   */
  readonly config?: string;
  /**
   * Output format. Defaults to "types" for backwards compatibility.
   * - "types": Flat type exports (UsersGetResponse, etc.)
   * - "client": Resource-based Api interface for use with createClient()
   * - "routes": Runtime route metadata for use with createHttpExecutor()
   */
  readonly format?: "types" | "client" | "routes";
  /**
   * The framework whose route file layout `routesDirs` follows. Defaults
   * to "fresh" (`routes/api/users/[id].ts`), which is also what the Bun,
   * Hono and fetch integrations read. See `RouteConvention`.
   */
  readonly convention?: RouteConvention;
  /**
   * Module the generated client types import their helper types from.
   * Only used by the "client" format, and only when an endpoint's response
   * type depends on the request (`projection()`, `expansion()`).
   * Defaults to "@dgellow/typed-endpoints/client".
   */
  readonly clientImport?: string;
}

// =============================================================================
// Extraction
// =============================================================================

/** Line prefix that marks the result in the subprocess output. */
const RESULT_MARKER = "__TYPED_ENDPOINTS_RESULT__";

/**
 * Run the extraction in a subprocess that uses the given config.
 *
 * One subprocess imports all route files. It loads `extract.ts` by URL, so
 * the same code runs here and there. Route modules may print while they are
 * imported; the result is the line that starts with the marker.
 */
async function extractWithConfig(
  sources: RouteSource[],
  configPath: string,
  extractOptions: ExtractOptions,
): Promise<Extraction> {
  const extractUrl = new URL("./extract.ts", import.meta.url).href;
  const script = `
    const { extractRoutes } = await import(${JSON.stringify(extractUrl)});
    try {
      const result = await extractRoutes(
        JSON.parse(Deno.args[0]),
        JSON.parse(Deno.args[1]),
      );
      console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      Deno.exit(1);
    }
  `;

  const { code, stdout, stderr } = await denoEval(configPath, script, [
    JSON.stringify(sources),
    JSON.stringify(extractOptions),
  ]);

  if (code !== 0) {
    throw new Error(stderr.trim());
  }

  const resultLine = stdout.split("\n")
    .findLast((line) => line.startsWith(RESULT_MARKER));
  if (resultLine === undefined) {
    throw new Error("Route extraction subprocess produced no result");
  }
  return JSON.parse(resultLine.slice(RESULT_MARKER.length));
}

// =============================================================================
// Endpoints
// =============================================================================

/** One method of one route, as the generators see it. */
export interface EndpointType {
  /** Base of the generated type names, e.g. `UsersByIdGet`. */
  readonly name: string;
  /** URL path in file-route notation, e.g. `/api/users/[id]`. */
  readonly path: string;
  readonly method: string;
  /** Every method the path defines, across files. */
  readonly siblings: readonly string[];
  readonly filePath: string;
  readonly request?: string;
  readonly query?: string;
  readonly params?: string;
  readonly response?: string;
  /** The response with request-dependent places as `Dependent<...>`. */
  readonly dependentResponse?: string;
  readonly events?: Readonly<Record<string, string>>;
  /** Bodies of the declared error responses, by status. */
  readonly errors?: Readonly<Record<string, string>>;
  readonly pagination?: AnyPaginationMeta;
  readonly operationId?: string;
  /** The parts as JSON Schema, when the extraction was asked for them. */
  readonly schemas?: MethodSchemas;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

function describe(endpoint: EndpointType): string {
  return `${endpoint.method} ${endpoint.path} (${endpoint.filePath})`;
}

/**
 * Fail when two endpoints derive the same generated name.
 *
 * `entries` pairs each generated name with the endpoint it came from.
 */
function assertNoCollisions(
  what: string,
  entries: readonly (readonly [string, EndpointType])[],
  hint: string,
): void {
  const byName = new Map<string, EndpointType[]>();
  for (const [name, endpoint] of entries) {
    const list = byName.get(name);
    if (list) list.push(endpoint);
    else byName.set(name, [endpoint]);
  }

  const collisions = [...byName].filter(([, list]) => list.length > 1);
  if (collisions.length === 0) return;

  const lines = collisions.map(([name, list]) =>
    `  ${name}: ${list.map(describe).join(" and ")}`
  );
  throw new Error(
    `Several endpoints generate the same ${what}:\n${
      lines.join("\n")
    }\n${hint}`,
  );
}

function buildEndpoints(extraction: Extraction): EndpointType[] {
  const endpoints: EndpointType[] = [];

  // How many methods a path has, across files: one file per method is a
  // layout too (Nitro's `users.get.ts` next to `users.post.ts`).
  const methodsOfPath = new Map<string, string[]>();
  for (const { apiPath, methods } of extraction.routes) {
    const defined = HTTP_METHODS.filter((m) => methods[m]);
    methodsOfPath.set(apiPath, [
      ...methodsOfPath.get(apiPath) ?? [],
      ...defined,
    ]);
  }

  for (const { filePath, apiPath, methods } of extraction.routes) {
    const baseName = pathToTypeName(apiPath);
    const defined = HTTP_METHODS.filter((m) => methods[m]);

    for (const method of defined) {
      const def: ExtractedMethod = methods[method];
      // Disambiguate if multiple methods on same endpoint
      const name = methodsOfPath.get(apiPath)!.length > 1
        ? `${baseName}${capitalize(method.toLowerCase())}`
        : baseName;

      endpoints.push({
        name,
        path: apiPath,
        method,
        siblings: methodsOfPath.get(apiPath)!,
        filePath,
        request: def.body,
        query: def.query,
        params: def.params,
        response: def.response,
        dependentResponse: def.dependentResponse,
        events: def.events,
        errors: def.errors,
        pagination: def.pagination as AnyPaginationMeta | undefined,
        operationId: def.operationId,
        schemas: def.schemas,
        summary: def.summary,
        description: def.description,
        tags: def.tags,
      });
    }
  }

  return endpoints;
}

/** What every generator needs from the routes: which, and from where. */
export interface RouteOptions {
  /** Directories containing route files. Defaults to ["routes/api"] */
  readonly routesDirs?: readonly string[];
  /** Path to a deno.json whose import map the route files use (Deno). */
  readonly config?: string;
  /** The framework whose route file layout `routesDirs` follows. */
  readonly convention?: RouteConvention;
}

/**
 * Import the route files and describe their endpoints.
 *
 * Shared by the TypeScript generator and by the generators for other
 * languages, which ask for JSON Schema (`extractOptions.jsonSchema`).
 */
export async function loadEndpoints(
  options: RouteOptions,
  extractOptions: ExtractOptions = {},
): Promise<{ endpoints: EndpointType[]; extraction: Extraction }> {
  const {
    routesDirs = ["routes/api"],
    config,
    convention = "fresh",
  } = options;

  const routeFiles = (await Promise.all(routesDirs.map(listRouteFiles)))
    .flat();

  // On Deno, a config means the route files resolve their imports through
  // its import map, which takes a subprocess. Bun and Node resolve from the
  // importing file, so there the modules are imported into this process.
  const inSubprocess = config !== undefined && isDeno();

  // The query string makes each in-process run import the current file,
  // not a cached module.
  const cacheBuster = inSubprocess ? "" : `?t=${Date.now()}`;
  const sources: RouteSource[] = [];
  for (const filePath of routeFiles.sort()) {
    // Not every file below the directory is a route in every convention.
    const route = routeOfFile(filePath, convention);
    if (!route) continue;
    sources.push({
      filePath,
      url: await fileUrlOf(filePath) + cacheBuster,
      apiPath: route.apiPath,
      ...(route.method && { method: route.method }),
    });
  }

  const extraction = inSubprocess
    ? await extractWithConfig(sources, config, extractOptions)
    : await extractRoutes(sources, extractOptions);

  return { endpoints: buildEndpoints(extraction), extraction };
}

/**
 * Generate TypeScript types from API route Zod schemas.
 * Returns the generated types as a string.
 * If `output` is provided, also writes to that file.
 */
export async function generateTypes(
  options: TypeGenOptions = {},
): Promise<string> {
  const { output } = options;
  const { endpoints, extraction } = await loadEndpoints(options);

  // Named types that only the request-dependent response texts use
  // belong to the client format alone.
  const dependentOnly = new Set(extraction.dependentOnly);
  const plainDeclarations = extraction.declarations.filter(([name]) =>
    !dependentOnly.has(name)
  );

  const format = options.format ?? "types";
  let content: string;
  switch (format) {
    case "client":
      content = generateClientFormat(
        endpoints,
        extraction.declarations,
        extraction.helpers,
        options.clientImport ?? "@dgellow/typed-endpoints/client",
      );
      break;
    case "routes":
      content = generateRoutesFormat(endpoints);
      break;
    default:
      content = generateTypesFormat(endpoints, plainDeclarations);
  }

  if (output) {
    await writeFile(output, content);
  }

  return content;
}

// =============================================================================
// Shared rendering
// =============================================================================

/** Named types (recursive schemas) referenced by the generated type texts. */
function renderDeclarations(
  declarations: Extraction["declarations"],
): string[] {
  if (declarations.length === 0) return [];
  return [
    "// Named types",
    ...declarations.map(([name, text]) => `export type ${name} = ${text};`),
    "",
  ];
}

function renderEvents(events: Readonly<Record<string, string>>): string {
  const members = Object.entries(events).map(([name, type]) =>
    `${isIdentifier(name) ? name : JSON.stringify(name)}: ${type};`
  );
  return `{ ${members.join(" ")} }`;
}

// =============================================================================
// "types" format
// =============================================================================

/**
 * Generate flat type exports (legacy format).
 */
function generateTypesFormat(
  endpoints: EndpointType[],
  declarations: Extraction["declarations"],
): string {
  assertNoCollisions(
    "type name",
    endpoints.map((e) => [e.name, e] as const),
    "Type names are derived from the route path; rename one of the routes.",
  );

  const lines: string[] = [
    "// Auto-generated from API route Zod schemas",
    "// Do not edit manually",
    "",
    ...renderDeclarations(declarations),
  ];

  for (const endpoint of endpoints) {
    const { name } = endpoint;
    lines.push(`// ${endpoint.method} ${endpoint.path}`);

    if (endpoint.params) {
      lines.push(`export type ${name}Params = ${endpoint.params};`);
    }
    if (endpoint.query) {
      lines.push(`export type ${name}Query = ${endpoint.query};`);
    }
    if (endpoint.request) {
      lines.push(`export type ${name}Request = ${endpoint.request};`);
    }
    if (endpoint.response) {
      lines.push(`export type ${name}Response = ${endpoint.response};`);
    }
    if (endpoint.events) {
      lines.push(
        `export type ${name}Events = ${renderEvents(endpoint.events)};`,
      );
    }
    for (const [status, type] of Object.entries(endpoint.errors ?? {})) {
      lines.push(`export type ${name}Error${status} = ${type};`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// "routes" format
// =============================================================================

/**
 * Generate runtime route metadata for use with createHttpExecutor().
 *
 * Output example:
 * ```typescript
 * export const apiRoutes = {
 *   login: { method: "POST", path: "/api/auth/login" },
 *   usersRetrieve: { method: "GET", path: "/api/users/{id}" },
 * } as const;
 * export type ApiRoutes = typeof apiRoutes;
 * export type RouteId = keyof ApiRoutes;
 * ```
 */
function generateRoutesFormat(endpoints: EndpointType[]): string {
  // Use explicit operationId if available, otherwise derive from path/method
  const ids = endpoints.map((endpoint) =>
    [
      endpoint.operationId ??
        deriveOperationId(endpoint.path, endpoint.method, endpoint.siblings),
      endpoint,
    ] as const
  );

  assertNoCollisions(
    "route id",
    ids,
    "Set a distinct `operationId` on one endpoint of each pair.",
  );

  const lines: string[] = [
    "// Auto-generated route metadata for use with createHttpExecutor()",
    "// Do not edit manually",
    "",
    "export const apiRoutes = {",
  ];

  for (const [id, endpoint] of ids) {
    // Convert Fresh-style [param] to {param} for HTTP executor
    const httpPath = apiPathToTemplate(endpoint.path);
    const key = isIdentifier(id) ? id : JSON.stringify(id);

    lines.push(
      `  ${key}: { method: "${endpoint.method}", path: ${
        JSON.stringify(httpPath)
      } },`,
    );
  }

  lines.push("} as const;");
  lines.push("");
  lines.push("export type ApiRoutes = typeof apiRoutes;");
  lines.push("export type RouteId = keyof ApiRoutes;");
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// "client" format
// =============================================================================

interface ResourceMethod {
  readonly endpoint: EndpointType;
}

interface ResourceNode {
  readonly methods: Record<string, ResourceMethod>;
  readonly children: Record<string, ResourceNode>;
}

/** Style-specific pagination fields, in output order. */
const PAGINATION_FIELDS: Record<AnyPaginationMeta["style"], string[]> = {
  cursor: ["cursor", "cursorParam"],
  cursorId: ["cursorIdParam", "idField"],
  offset: ["total", "offsetParam"],
  page: ["pageParam", "perPageParam", "total", "totalPages"],
  url: ["nextUrl", "prevUrl"],
};

/** The fields of pagination metadata that have a value, in output order. */
function paginationEntries(meta: AnyPaginationMeta): [string, string][] {
  const values = meta as unknown as Record<string, string | undefined>;
  return ["style", "items", "limitParam", ...PAGINATION_FIELDS[meta.style]]
    .filter((field) => values[field])
    .map((field) => [field, values[field] as string]);
}

function renderPagination(meta: AnyPaginationMeta, indent: string): string[] {
  return [
    `${indent}pagination: {`,
    ...paginationEntries(meta).map(([field, value]) =>
      `${indent}  ${field}: ${JSON.stringify(value)};`
    ),
    `${indent}};`,
  ];
}

/** Pagination metadata as a value, for the route table. */
function paginationValue(meta: AnyPaginationMeta): string {
  return `{ ${
    paginationEntries(meta).map(([field, value]) =>
      `${field}: ${JSON.stringify(value)}`
    ).join(", ")
  } }`;
}

/**
 * Generate resource-based Api interface for use with createClient().
 */
function generateClientFormat(
  endpoints: EndpointType[],
  declarations: Extraction["declarations"],
  helpers: readonly string[],
  clientImport: string,
): string {
  // Each endpoint becomes `<segments>.<method>` in the interface.
  const placed = endpoints.map((endpoint) => {
    const segments = pathToResourceSegments(endpoint.path);
    // SSE endpoints use "subscribe" method
    const methodName = endpoint.events
      ? "subscribe"
      : httpMethodToResourceMethod(
        endpoint.method,
        endpoint.path,
        endpoint.siblings,
      );
    return { endpoint, segments, methodName };
  });

  assertNoCollisions(
    "client method",
    placed.map((p) => [[...p.segments, p.methodName].join("."), p.endpoint]),
    "The client names methods by HTTP method and path shape; these endpoints cannot both be in one generated client.",
  );

  // Build resource tree
  const root: ResourceNode = { methods: {}, children: {} };
  for (const { endpoint, segments, methodName } of placed) {
    let node = root;
    for (const segment of segments) {
      node = node.children[segment] ??= { methods: {}, children: {} };
    }
    node.methods[methodName] = { endpoint };
  }

  // A resource and a method of the same parent cannot share a name.
  const shadowed: [string, EndpointType][] = [];
  const findShadowed = (node: ResourceNode, path: string[]): void => {
    for (const [name, child] of Object.entries(node.children)) {
      const method = node.methods[name];
      if (method) shadowed.push([[...path, name].join("."), method.endpoint]);
      findShadowed(child, [...path, name]);
    }
  };
  findShadowed(root, []);
  if (shadowed.length > 0) {
    throw new Error(
      `A client method and a nested resource have the same name:\n${
        shadowed.map(([name, e]) => `  ${name}: ${describe(e)}`).join("\n")
      }`,
    );
  }

  // Generate TypeScript interface
  const lines: string[] = [
    "// Auto-generated API types for use with createClient()",
    "// Do not edit manually",
    "",
    // Types that compute a response type from the arguments of a call.
    ...(helpers.length > 0
      ? [
        `import type { ${helpers.join(", ")} } from ${
          JSON.stringify(clientImport)
        };`,
        "",
      ]
      : []),
    ...renderDeclarations(declarations),
    "export interface Api {",
  ];

  function renderNode(node: ResourceNode, indent: string): void {
    for (const [methodName, { endpoint }] of Object.entries(node.methods)) {
      lines.push(`${indent}${methodName}: {`);
      // The path template tells the client types which path parameters a
      // call supplies: the trailing one as `id`, the others in `params`.
      lines.push(
        `${indent}  path: ${
          JSON.stringify(apiPathToClientTemplate(endpoint.path))
        };`,
      );
      if (endpoint.params) {
        lines.push(`${indent}  params: ${endpoint.params};`);
      }
      if (endpoint.query) {
        lines.push(`${indent}  query: ${endpoint.query};`);
      }
      if (endpoint.request) {
        lines.push(`${indent}  body: ${endpoint.request};`);
      }
      if (endpoint.dependentResponse) {
        // The client applies the families in this type to each call.
        lines.push(`${indent}  response: ${endpoint.dependentResponse};`);
        lines.push(`${indent}  dependent: true;`);
      } else if (endpoint.response) {
        lines.push(`${indent}  response: ${endpoint.response};`);
      }
      if (endpoint.events) {
        lines.push(`${indent}  events: {`);
        for (const [eventName, eventType] of Object.entries(endpoint.events)) {
          const key = isIdentifier(eventName)
            ? eventName
            : JSON.stringify(eventName);
          lines.push(`${indent}    ${key}: ${eventType};`);
        }
        lines.push(`${indent}  };`);
      }
      if (endpoint.errors) {
        // What `method.result()` returns as a value, not an exception.
        lines.push(
          `${indent}  errors: { ${
            Object.entries(endpoint.errors).map(([status, type]) =>
              `${status}: ${type};`
            ).join(" ")
          } };`,
        );
      }
      if (endpoint.pagination) {
        lines.push(...renderPagination(endpoint.pagination, `${indent}  `));
      }
      lines.push(`${indent}};`);
    }

    for (const [name, child] of Object.entries(node.children)) {
      const key = isIdentifier(name) ? name : JSON.stringify(name);
      lines.push(`${indent}${key}: {`);
      renderNode(child, indent + "  ");
      lines.push(`${indent}};`);
    }
  }

  renderNode(root, "  ");

  lines.push("}");
  lines.push("");

  // The same routes as a value: how the client turns `users.posts.list`
  // into a method and a URL, and how it finds the next page of a paginated
  // endpoint. Types are erased, so it cannot read `Api`.
  lines.push("/** Pass to `createClient<Api>({ baseUrl, routes })`. */");
  lines.push("export const routes = {");
  for (const { endpoint, segments, methodName } of placed) {
    const pagination = endpoint.pagination
      ? `, pagination: ${paginationValue(endpoint.pagination)}`
      : "";
    const errors = endpoint.errors
      ? `, errors: [${Object.keys(endpoint.errors).join(", ")}]`
      : "";
    // A `delete` that carries a body: the method name does not say so.
    const body = methodName === "delete" && endpoint.request !== undefined
      ? ", body: true"
      : "";
    lines.push(
      `  ${JSON.stringify([...segments, methodName].join("."))}: { method: ${
        JSON.stringify(endpoint.method)
      }, path: ${
        JSON.stringify(apiPathToClientTemplate(endpoint.path))
      }${body}${errors}${pagination} },`,
    );
  }
  lines.push("} as const;");
  lines.push("");

  return lines.join("\n");
}
