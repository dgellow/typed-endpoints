import { toFileUrl } from "@std/path";
import type { ApiDef, HttpMethod } from "@/core/types.ts";
import { collectRouteFiles } from "./files.ts";
import { filePathToApiPath, pathToTypeName } from "./path.ts";
import { zodToTypeString } from "./zod.ts";

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
  /** Directory containing route files. Defaults to "routes/api" */
  routesDir?: string;
  /** Output file path. If provided, writes generated types to this file */
  output?: string;
}

interface RouteModule {
  handler?: { __apiDef?: ApiDef };
}

interface EndpointType {
  name: string;
  path: string;
  method: string;
  request?: string;
  response?: string;
}

/**
 * Generate TypeScript types from API route Zod schemas.
 * Returns the generated types as a string.
 * If `output` is provided, also writes to that file.
 */
export async function generateTypes(
  options: TypeGenOptions = {},
): Promise<string> {
  const { routesDir = "routes/api", output } = options;

  const routeFiles: string[] = [];
  for await (const entry of Deno.readDir(routesDir)) {
    await collectRouteFiles(routesDir, entry, routeFiles);
  }

  const endpoints: EndpointType[] = [];
  const cacheBuster = `?t=${Date.now()}`;

  for (const filePath of routeFiles.sort()) {
    try {
      const absolutePath = await Deno.realPath(filePath);
      const fileUrl = toFileUrl(absolutePath).href + cacheBuster;
      const mod = (await import(fileUrl)) as RouteModule;

      const apiDef = mod.handler?.__apiDef;
      if (!apiDef) continue;

      const apiPath = filePathToApiPath(filePath);
      const baseName = pathToTypeName(apiPath);

      for (const method of HTTP_METHODS) {
        const methodDef = apiDef[method];
        if (!methodDef) continue;

        // Disambiguate if multiple methods on same endpoint
        const methodCount = HTTP_METHODS.filter((m) => apiDef[m]).length;
        const name = methodCount > 1
          ? `${baseName}${method.charAt(0)}${method.slice(1).toLowerCase()}`
          : baseName;

        const endpoint: EndpointType = {
          name,
          path: apiPath,
          method,
        };

        if (methodDef.body) {
          endpoint.request = zodToTypeString(methodDef.body);
        }

        if (methodDef.response) {
          endpoint.response = zodToTypeString(methodDef.response);
        }

        endpoints.push(endpoint);
      }
    } catch (error) {
      console.error(`Failed to process ${filePath}:`, error);
    }
  }

  const lines: string[] = [
    "// Auto-generated from API route Zod schemas",
    "// Do not edit manually",
    "",
  ];

  for (const endpoint of endpoints) {
    lines.push(`// ${endpoint.method} ${endpoint.path}`);

    if (endpoint.request) {
      lines.push(`export type ${endpoint.name}Request = ${endpoint.request};`);
    }

    if (endpoint.response) {
      lines.push(
        `export type ${endpoint.name}Response = ${endpoint.response};`,
      );
    }

    lines.push("");
  }

  const content = lines.join("\n");

  if (output) {
    await Deno.writeTextFile(output, content);
  }

  return content;
}
