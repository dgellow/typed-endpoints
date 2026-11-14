import { toFileUrl } from "@std/path";
import type { HttpMethod } from "@/core/types.ts";
import type { AnyPaginationMeta } from "@/pagination/types.ts";
import { collectRouteFiles } from "./files.ts";
import { filePathToApiPath, pathToTypeName } from "./path.ts";
import {
  type ExtractedMethod,
  type Extraction,
  extractRoutes,
  type RouteSource,
} from "./extract.ts";

const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

export interface TypeGenOptions {
  /** Directories containing route files. Defaults to ["routes/api"] */
  routesDirs?: string[];
  /** Output file path. If provided, writes generated types to this file */
  output?: string;
  /**
   * Path to deno.json config file. When provided, route files are imported
   * in a subprocess that uses the config's import map. This is needed when
   * running the CLI as an external package.
   */
  config?: string;
  /**
   * Output format. Defaults to "types" for backwards compatibility.
   * - "types": Flat type exports (UsersGetResponse, etc.)
   * - "client": Resource-based Api interface for use with createClient()
   * - "routes": Runtime route metadata for use with createHttpExecutor()
   */
  format?: "types" | "client" | "routes";
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
): Promise<Extraction> {
  const extractUrl = new URL("./extract.ts", import.meta.url).href;
  const script = `
    const { extractRoutes } = await import(${JSON.stringify(extractUrl)});
    try {
      const result = await extractRoutes(JSON.parse(Deno.args[0]));
      console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      Deno.exit(1);
    }
  `;

  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["eval", "--config", configPath, script, JSON.stringify(sources)],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr).trim());
  }

  const resultLine = new TextDecoder().decode(stdout).split("\n")
    .findLast((line) => line.startsWith(RESULT_MARKER));
  if (resultLine === undefined) {
    throw new Error("Route extraction subprocess produced no result");
  }
  return JSON.parse(resultLine.slice(RESULT_MARKER.length));
}

// =============================================================================
// Endpoints
// =============================================================================

interface EndpointType {
  /** Base of the generated type names, e.g. `UsersByIdGet`. */
  name: string;
  /** URL path in file-route notation, e.g. `/api/users/[id]`. */
  path: string;
  method: string;
  filePath: string;
  request?: string;
  query?: string;
  params?: string;
  response?: string;
  events?: Readonly<Record<string, string>>;
  pagination?: AnyPaginationMeta;
  operationId?: string;
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

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildEndpoints(extraction: Extraction): EndpointType[] {
  const endpoints: EndpointType[] = [];

  for (const { filePath, methods } of extraction.routes) {
    const apiPath = filePathToApiPath(filePath);
    const baseName = pathToTypeName(apiPath);
    const defined = HTTP_METHODS.filter((m) => methods[m]);

    for (const method of defined) {
      const def: ExtractedMethod = methods[method];
      // Disambiguate if multiple methods on same endpoint
      const name = defined.length > 1
        ? `${baseName}${capitalize(method.toLowerCase())}`
        : baseName;

      endpoints.push({
        name,
        path: apiPath,
        method,
        filePath,
        request: def.body,
        query: def.query,
        params: def.params,
        response: def.response,
        events: def.events,
        pagination: def.pagination as AnyPaginationMeta | undefined,
        operationId: def.operationId,
      });
    }
  }

  return endpoints;
}

/**
 * Generate TypeScript types from API route Zod schemas.
 * Returns the generated types as a string.
 * If `output` is provided, also writes to that file.
 */
export async function generateTypes(
  options: TypeGenOptions = {},
): Promise<string> {
  const { routesDirs = ["routes/api"], output, config } = options;

  const routeFiles: string[] = [];
  for (const dir of routesDirs) {
    for await (const entry of Deno.readDir(dir)) {
      await collectRouteFiles(dir, entry, routeFiles);
    }
  }

  // Without a config the modules are imported into this process. The query
  // string makes each run import the current file, not a cached module.
  const cacheBuster = config ? "" : `?t=${Date.now()}`;
  const sources: RouteSource[] = await Promise.all(
    routeFiles.sort().map(async (filePath) => ({
      filePath,
      url: toFileUrl(await Deno.realPath(filePath)).href + cacheBuster,
    })),
  );

  const extraction = config
    ? await extractWithConfig(sources, config)
    : await extractRoutes(sources);

  const endpoints = buildEndpoints(extraction);

  const format = options.format ?? "types";
  let content: string;
  switch (format) {
    case "client":
      content = generateClientFormat(endpoints, extraction.declarations);
      break;
    case "routes":
      content = generateRoutesFormat(endpoints);
      break;
    default:
      content = generateTypesFormat(endpoints, extraction.declarations);
  }

  if (output) {
    await Deno.writeTextFile(output, content);
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

    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// "routes" format
// =============================================================================

/** Whether the last path segment is a parameter, e.g. `/users/[id]`. */
function endsWithParam(path: string): boolean {
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  return last.startsWith("[") || last.startsWith(":");
}

/**
 * Convert HTTP method + path pattern to resource method name.
 * - GET /users -> list
 * - GET /users/:id -> retrieve
 * - GET /users/:id/posts -> list
 * - POST /users -> create
 * - PUT/PATCH /users/:id -> update
 * - DELETE /users/:id -> delete
 */
function httpMethodToResourceMethod(method: string, path: string): string {
  switch (method) {
    case "GET":
      return endsWithParam(path) ? "retrieve" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

/**
 * Convert a path like /api/users/[id]/posts to resource segments.
 * Returns: ["users", "posts"] (strips /api prefix and param segments)
 */
function pathToResourceSegments(path: string): string[] {
  return path
    .replace(/^\/api\//, "") // Remove /api/ prefix
    .split("/")
    .filter((seg) => seg && !seg.startsWith("[") && !seg.startsWith(":"));
}

/**
 * Derive an operationId from path and method.
 * E.g., POST /api/auth/login -> authLoginCreate
 * E.g., GET /api/users/[id] -> usersRetrieve
 */
function deriveOperationId(path: string, method: string): string {
  const baseName = pathToResourceSegments(path)
    .map((seg, i) => (i === 0 ? seg : capitalize(seg)))
    .join("");
  return baseName + capitalize(httpMethodToResourceMethod(method, path));
}

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
        deriveOperationId(endpoint.path, endpoint.method),
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
    const httpPath = endpoint.path.replace(/\[(\w+)\]/g, "{$1}");
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
  endpoint: EndpointType;
}

interface ResourceNode {
  methods: Record<string, ResourceMethod>;
  children: Record<string, ResourceNode>;
}

/** Style-specific pagination fields, in output order. */
const PAGINATION_FIELDS: Record<AnyPaginationMeta["style"], string[]> = {
  cursor: ["cursor", "cursorParam"],
  cursorId: ["cursorIdParam", "idField"],
  offset: ["total", "offsetParam"],
  page: ["pageParam", "perPageParam", "total", "totalPages"],
  url: ["nextUrl", "prevUrl"],
};

function renderPagination(meta: AnyPaginationMeta, indent: string): string[] {
  const values = meta as unknown as Record<string, string | undefined>;
  const fields = [
    "style",
    "items",
    "limitParam",
    ...PAGINATION_FIELDS[meta.style],
  ];
  return [
    `${indent}pagination: {`,
    ...fields
      .filter((field) => values[field])
      .map((field) => `${indent}  ${field}: ${JSON.stringify(values[field])};`),
    `${indent}};`,
  ];
}

/**
 * Generate resource-based Api interface for use with createClient().
 */
function generateClientFormat(
  endpoints: EndpointType[],
  declarations: Extraction["declarations"],
): string {
  // Each endpoint becomes `<segments>.<method>` in the interface.
  const placed = endpoints.map((endpoint) => {
    const segments = pathToResourceSegments(endpoint.path);
    // SSE endpoints use "subscribe" method
    const methodName = endpoint.events
      ? "subscribe"
      : httpMethodToResourceMethod(endpoint.method, endpoint.path);
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
    ...renderDeclarations(declarations),
    "export interface Api {",
  ];

  function renderNode(node: ResourceNode, indent: string): void {
    for (const [methodName, { endpoint }] of Object.entries(node.methods)) {
      lines.push(`${indent}${methodName}: {`);
      if (endpoint.query) {
        lines.push(`${indent}  query: ${endpoint.query};`);
      }
      if (endpoint.request) {
        lines.push(`${indent}  body: ${endpoint.request};`);
      }
      if (endpoint.response) {
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

  return lines.join("\n");
}
