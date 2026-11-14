import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type { ApiDef, ApiMethodDef, HttpMethod } from "./types.ts";
import type { AnyPaginationMeta } from "../pagination/types.ts";
import { readModuleApi } from "./module_api.ts";
import {
  apiPathToTemplate,
  deriveOperationId,
  filePathToApiPath,
  fileUrlOf,
  HTTP_METHODS,
  listRouteFiles,
  type RouteConvention,
  routeOfFile,
} from "./routes.ts";

/** Extended method def that may include pagination metadata */
interface MethodDefWithPagination extends
  ApiMethodDef<
    z.ZodType | undefined,
    z.ZodType | undefined,
    z.ZodType | undefined
  > {
  readonly __pagination?: AnyPaginationMeta;
}

extendZodWithOpenApi(z);

/** The `info` object of the generated spec. */
export interface OpenApiInfo {
  /** API title. Default: `"API"`. */
  readonly title?: string;
  /** API version. Default: `"1.0.0"`. */
  readonly version?: string;
  /** API description. */
  readonly description?: string;
}

/** An entry of the `servers` list of the generated spec. */
export interface OpenApiServer {
  /** Server URL. */
  readonly url: string;
  /** Server description. */
  readonly description?: string;
  /** Specification extensions (`x-...`), copied as given. */
  readonly [key: `x-${string}`]: unknown;
}

/** Options of `generateOpenApiSpec()`. */
export interface GeneratorOptions {
  /** Directory that holds the route files. Default: `"routes/api"`. */
  readonly routesDir?: string;
  /**
   * The framework whose route file layout `routesDir` follows. Default:
   * `"fresh"`. See `RouteConvention`.
   */
  readonly convention?: RouteConvention;
  /** Contents of the `info` object. */
  readonly info?: OpenApiInfo;
  /** Contents of the `servers` list. Left out of the spec when empty. */
  readonly servers?: readonly OpenApiServer[];
  /**
   * Fail when a route cannot be described. Default: false.
   *
   * - `false`: a route file that cannot be imported is logged and left out
   *   of the spec; operations whose derived `operationId` collides are
   *   emitted without one.
   * - `true`: both cases throw, with a message that lists every problem.
   */
  readonly strict?: boolean;
}

/** What the generator reads from a route module: `handler.__apiDef`. */
export interface RouteModule {
  /** Handlers created by `createApiHandlers()`, which attaches `__apiDef`. */
  readonly handler?: { __apiDef?: ApiDef };
}

/**
 * Convert file-based route path to OpenAPI path format.
 * e.g. routes/api/users/[id].ts -> /api/users/{id}
 *
 * Everything up to and including the `routes` directory is dropped, so
 * `./routes/...`, `src/routes/...` and absolute paths give the same result.
 * Handles Windows backslashes and route groups like (auth). A catch-all
 * `[...rest]` is described as the single parameter `{rest}`.
 */
export function filePathToOpenApiPath(filePath: string): string {
  return apiPathToTemplate(filePathToApiPath(filePath));
}

function extractPathParams(path: string): string[] {
  const matches = path.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * Generate OpenAPI spec by scanning route files.
 * Only includes routes with public: true.
 */
export async function generateOpenApiSpec(
  options: GeneratorOptions = {},
): Promise<ReturnType<OpenApiGeneratorV31["generateDocument"]>> {
  const {
    routesDir = "routes/api",
    info = {},
    servers = [],
    strict = false,
    convention = "fresh",
  } = options;

  const registry = new OpenAPIRegistry();

  const routeFiles = await listRouteFiles(routesDir);

  // Cache-bust timestamp for fresh imports during build
  const cacheBuster = `?t=${Date.now()}`;

  const problems: string[] = [];
  const operations: Operation[] = [];
  const methodsOfPath = new Map<string, HttpMethod[]>();

  for (const filePath of routeFiles) {
    // Not every file below the directory is a route in every convention.
    const route = routeOfFile(filePath, convention);
    if (!route) continue;

    let apiDef: ApiDef | undefined;
    try {
      const fileUrl = await fileUrlOf(filePath) + cacheBuster;
      apiDef = readModuleApi(await import(fileUrl), route.method) as
        | ApiDef
        | undefined;
    } catch (error) {
      if (!strict) console.warn(`Failed to process route ${filePath}:`, error);
      problems.push(
        `${filePath}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    if (!apiDef) continue;

    const apiPath = route.apiPath;
    for (const method of HTTP_METHODS) {
      const def = apiDef[method];
      if (!def) continue;
      // Every method counts for naming, public or not, so that an id is
      // the same here and in the generated route table.
      methodsOfPath.set(apiPath, [...methodsOfPath.get(apiPath) ?? [], method]);
      if (!def.public) continue;
      operations.push({
        filePath,
        apiPath,
        path: apiPathToTemplate(apiPath),
        method,
        def,
        operationId: def.operationId ?? "",
      });
    }
  }

  // A derived id depends on the other methods of the path (PUT is
  // "replace" next to PATCH), which may be defined in other files.
  for (const op of operations) {
    op.operationId ||= deriveOperationId(
      op.apiPath,
      op.method,
      methodsOfPath.get(op.apiPath),
    );
  }

  // operationId must be unique within a spec.
  const byId = Map.groupBy(operations, (op) => op.operationId);
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const where = group
      .map((op) => `${op.method} ${op.path} (${op.filePath})`)
      .join(" and ");
    const problem =
      `operationId "${id}" is used by ${where}; set a distinct \`operationId\` on one of them`;
    if (!strict) {
      console.warn(`${problem}. They are emitted without an operationId.`);
    }
    problems.push(problem);
  }

  if (strict && problems.length > 0) {
    throw new Error(
      `OpenAPI generation failed:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  for (const op of operations) {
    const unique = byId.get(op.operationId)!.length === 1;
    registerEndpoint(
      registry,
      op.path,
      op.method,
      op.def,
      extractPathParams(op.path),
      unique ? op.operationId : undefined,
    );
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: info.title ?? "API",
      version: info.version ?? "1.0.0",
      description: info.description,
    },
    servers: servers.length > 0 ? [...servers] : undefined,
  });
}

/** Body of the 400 answer to a request that failed validation. */
const InvalidRequest = z.object({
  error: z.string(),
  in: z.enum(["body", "query", "params", "json"]),
  issues: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
    code: z.string(),
  })),
});

const invalidRequestSchemas = new WeakMap<OpenAPIRegistry, z.ZodType>();

/** The `InvalidRequest` component, registered once per spec. */
function invalidRequestSchema(registry: OpenAPIRegistry): z.ZodType {
  let schema = invalidRequestSchemas.get(registry);
  if (!schema) {
    schema = registry.register("InvalidRequest", InvalidRequest);
    invalidRequestSchemas.set(registry, schema);
  }
  return schema;
}

/** A public endpoint method that goes into the spec. */
interface Operation {
  readonly filePath: string;
  /** Path in file-route notation, e.g. `/api/users/[id]`. */
  readonly apiPath: string;
  /** Path template, e.g. `/api/users/{id}`. */
  readonly path: string;
  readonly method: HttpMethod;
  readonly def: MethodDefWithPagination;
  /** Explicit, or derived once every method of the path is known. */
  operationId: string;
}

function registerEndpoint(
  registry: OpenAPIRegistry,
  path: string,
  method: HttpMethod,
  def: MethodDefWithPagination,
  pathParams: string[],
  operationId: string | undefined,
): void {
  const request: Record<string, unknown> = {};

  if (pathParams.length > 0) {
    if (def.params) {
      request.params = def.params;
    } else {
      const paramSchema: Record<string, z.ZodString> = {};
      for (const param of pathParams) {
        paramSchema[param] = z.string();
      }
      request.params = z.object(paramSchema);
    }
  }

  if (def.query) {
    request.query = def.query;
  }

  // A body is described for every method that declares one, as it is
  // validated for every method that declares one.
  if (def.body && method !== "GET" && method !== "HEAD") {
    let bodySchema = def.body;
    if (def.bodyName) {
      bodySchema = registry.register(def.bodyName, def.body);
    }
    request.body = {
      content: {
        "application/json": {
          schema: bodySchema,
        },
      },
    };
  }

  const responses: Record<
    string,
    { description: string; content?: Record<string, { schema: z.ZodType }> }
  > = {};

  if (def.response) {
    let responseSchema = def.response;
    if (def.responseName) {
      responseSchema = registry.register(def.responseName, def.response);
    }
    responses["200"] = {
      description: "Success",
      content: {
        "application/json": {
          schema: responseSchema,
        },
      },
    };
  }

  if (def.responses) {
    for (const [status, value] of Object.entries(def.responses)) {
      const isObjectWithSchema = value &&
        typeof value === "object" &&
        "schema" in value &&
        value.schema instanceof z.ZodType;
      const schema = isObjectWithSchema
        ? (value as { schema: z.ZodType; name?: string }).schema
        : (value as z.ZodType);
      const name = isObjectWithSchema
        ? (value as { schema: z.ZodType; name?: string }).name
        : undefined;

      let finalSchema = schema;
      if (name) {
        finalSchema = registry.register(name, schema);
      }

      responses[status] = {
        description: status === "200" ? "Success" : `Response ${status}`,
        content: {
          "application/json": {
            schema: finalSchema,
          },
        },
      };
    }
  }

  if (Object.keys(responses).length === 0) {
    responses["200"] = {
      description: "Success",
    };
  }

  // What the handlers answer when a request fails validation, for every
  // operation that validates something and does not declare its own 400.
  const validates = def.query || def.params ||
    (def.body && method !== "GET" && method !== "HEAD");
  if (validates && !responses["400"]) {
    responses["400"] = {
      description: "The request failed validation",
      content: {
        "application/json": { schema: invalidRequestSchema(registry) },
      },
    };
  }

  // Build the path registration object
  // deno-lint-ignore no-explicit-any
  const pathDef: any = {
    method: method.toLowerCase() as Lowercase<HttpMethod>,
    path,
    operationId,
    summary: def.summary,
    description: def.description,
    tags: def.tags,
    request: Object.keys(request).length > 0 ? request : undefined,
    responses,
  };

  // Add pagination extension if present
  if (def.__pagination) {
    pathDef["x-pagination"] = def.__pagination;
  }

  registry.registerPath(pathDef);
}
