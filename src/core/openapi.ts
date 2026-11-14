import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { toFileUrl } from "@std/path";
import { z } from "zod";
import type { ApiDef, ApiMethodDef, HttpMethod } from "./types.ts";
import type { AnyPaginationMeta } from "../pagination/types.ts";
import {
  apiPathToTemplate,
  collectRouteFiles,
  deriveOperationId,
  filePathToApiPath,
  HTTP_METHODS,
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
  /** Contents of the `info` object. */
  readonly info?: OpenApiInfo;
  /** Contents of the `servers` list. Left out of the spec when empty. */
  readonly servers?: OpenApiServer[];
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
  } = options;

  const registry = new OpenAPIRegistry();

  const routeFiles: string[] = [];
  for await (const entry of Deno.readDir(routesDir)) {
    await collectRouteFiles(routesDir, entry, routeFiles);
  }

  // Cache-bust timestamp for fresh imports during build
  const cacheBuster = `?t=${Date.now()}`;

  const problems: string[] = [];
  const operations: Operation[] = [];

  for (const filePath of routeFiles) {
    let apiDef: ApiDef | undefined;
    try {
      const absolutePath = await Deno.realPath(filePath);
      const fileUrl = toFileUrl(absolutePath).href + cacheBuster;
      apiDef = ((await import(fileUrl)) as RouteModule).handler?.__apiDef;
    } catch (error) {
      if (!strict) console.warn(`Failed to process route ${filePath}:`, error);
      problems.push(
        `${filePath}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    if (!apiDef) continue;

    const apiPath = filePathToApiPath(filePath);
    for (const method of HTTP_METHODS) {
      const def = apiDef[method];
      if (!def?.public) continue;
      operations.push({
        filePath,
        path: apiPathToTemplate(apiPath),
        method,
        def,
        operationId: def.operationId ?? deriveOperationId(apiPath, method),
      });
    }
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
    servers: servers.length > 0 ? servers : undefined,
  });
}

/** A public endpoint method that goes into the spec. */
interface Operation {
  readonly filePath: string;
  /** Path template, e.g. `/api/users/{id}`. */
  readonly path: string;
  readonly method: HttpMethod;
  readonly def: MethodDefWithPagination;
  readonly operationId: string;
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

  if (def.body && ["POST", "PUT", "PATCH"].includes(method)) {
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
