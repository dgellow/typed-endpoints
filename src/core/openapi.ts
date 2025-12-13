import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { toFileUrl } from "@std/path";
import { z } from "zod";
import type { ApiDef, ApiMethodDef, HttpMethod } from "./types.ts";

extendZodWithOpenApi(z);

const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

export interface OpenApiInfo {
  title?: string;
  version?: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
  [key: `x-${string}`]: unknown;
}

export interface GeneratorOptions {
  routesDir?: string;
  info?: OpenApiInfo;
  servers?: OpenApiServer[];
}

export interface RouteModule {
  handler?: { __apiDef?: ApiDef };
}

/**
 * Convert file-based route path to OpenAPI path format.
 * e.g. routes/api/users/[id].ts -> /api/users/{id}
 * Handles Windows backslashes and route groups like (auth).
 */
export function filePathToOpenApiPath(filePath: string): string {
  // Normalize Windows backslashes to forward slashes
  let path = filePath.replace(/\\/g, "/");

  path = path
    .replace(/^routes\//, "/")
    .replace(/\.(ts|tsx)$/, "");

  if (path.endsWith("/index")) {
    path = path.slice(0, -6) || "/";
  }

  // Strip route groups like (auth), (admin), etc.
  path = path.replace(/\/\([^)]+\)/g, "");

  // Convert [param] to {param} and [...param] to {param}
  path = path.replace(/\[\.\.\.(\w+)\]/g, "{$1}");
  path = path.replace(/\[(\w+)\]/g, "{$1}");

  return path;
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
  } = options;

  const registry = new OpenAPIRegistry();

  const routeFiles: string[] = [];
  for await (const entry of Deno.readDir(routesDir)) {
    await collectRouteFiles(routesDir, entry, routeFiles);
  }

  // Cache-bust timestamp for fresh imports during build
  const cacheBuster = `?t=${Date.now()}`;

  for (const filePath of routeFiles) {
    try {
      const absolutePath = await Deno.realPath(filePath);
      const fileUrl = toFileUrl(absolutePath).href + cacheBuster;
      const mod = (await import(fileUrl)) as RouteModule;

      const apiDef = mod.handler?.__apiDef;
      if (!apiDef) continue;

      const openApiPath = filePathToOpenApiPath(filePath);
      const pathParams = extractPathParams(openApiPath);

      for (const method of HTTP_METHODS) {
        const methodDef = apiDef[method];
        if (!methodDef?.public) continue;

        registerEndpoint(registry, openApiPath, method, methodDef, pathParams);
      }
    } catch (error) {
      console.warn(`Failed to process route ${filePath}:`, error);
    }
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

/** Check if a file should be skipped (tests, private, dotfiles). */
function shouldSkipFile(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("_") ||
    name.includes("_test.") ||
    name.includes(".test.") ||
    name.endsWith("_test.ts") ||
    name.endsWith("_test.tsx")
  );
}

async function collectRouteFiles(
  baseDir: string,
  entry: Deno.DirEntry,
  files: string[],
): Promise<void> {
  // Skip hidden files and directories
  if (entry.name.startsWith(".")) return;

  const fullPath = `${baseDir}/${entry.name}`;

  // Handle symlinks safely
  if (entry.isSymlink) {
    try {
      const stat = await Deno.stat(fullPath);
      if (stat.isDirectory) {
        for await (const subEntry of Deno.readDir(fullPath)) {
          await collectRouteFiles(fullPath, subEntry, files);
        }
      } else if (stat.isFile && /\.(ts|tsx)$/.test(entry.name)) {
        if (!shouldSkipFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch {
      // Broken symlink, skip silently
    }
    return;
  }

  if (entry.isDirectory) {
    for await (const subEntry of Deno.readDir(fullPath)) {
      await collectRouteFiles(fullPath, subEntry, files);
    }
  } else if (entry.isFile && /\.(ts|tsx)$/.test(entry.name)) {
    if (shouldSkipFile(entry.name)) {
      return;
    }
    files.push(fullPath);
  }
}

function registerEndpoint(
  registry: OpenAPIRegistry,
  path: string,
  method: HttpMethod,
  def: ApiMethodDef<
    z.ZodType | undefined,
    z.ZodType | undefined,
    z.ZodType | undefined
  >,
  pathParams: string[],
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

  registry.registerPath({
    method: method.toLowerCase() as Lowercase<HttpMethod>,
    path,
    summary: def.summary,
    description: def.description,
    tags: def.tags,
    request: Object.keys(request).length > 0 ? request : undefined,
    responses,
  });
}
