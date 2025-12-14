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
  /** Directories containing route files. Defaults to ["routes/api"] */
  routesDirs?: string[];
  /** Output file path. If provided, writes generated types to this file */
  output?: string;
  /**
   * Path to deno.json config file. When provided, uses subprocess to import
   * route files with the config's import map. This is needed when running
   * the CLI as an external package.
   */
  config?: string;
}

interface RouteModule {
  handler?: { __apiDef?: ApiDef };
}

// Helper script for subprocess import - extracts __apiDef and converts Zod schemas to type strings
// This runs in user's context with their import map, so it can import Zod and route files
// The zodToTypeString logic is inlined to avoid version/export issues
const IMPORT_HELPER_SCRIPT = `
// Inlined zodToTypeString implementation
function getDef(schema) {
  const zod = schema._zod;
  return zod?.def ?? schema._def ?? {};
}
function getTypeName(def) {
  return def.type ?? def.typeName ?? "unknown";
}
function convert(schema) {
  const def = getDef(schema);
  const typeName = getTypeName(def);
  switch (typeName) {
    case "string": return "string";
    case "number": case "int": return "number";
    case "boolean": return "boolean";
    case "bigint": return "bigint";
    case "date": return "Date";
    case "symbol": return "symbol";
    case "any": return "any";
    case "unknown": return "unknown";
    case "never": return "never";
    case "void": return "void";
    case "null": return "null";
    case "undefined": return "undefined";
    case "nan": return "number";
    case "file": return "File";
    case "literal": {
      const values = def.values;
      return values.map(v => typeof v === "string" ? \`"\${v}"\` : String(v)).join(" | ");
    }
    case "enum": {
      const entries = def.entries;
      const values = Object.values(entries);
      return values.map(v => typeof v === "string" ? \`"\${v}"\` : String(v)).join(" | ");
    }
    case "array": {
      const inner = convert(def.element);
      if (inner.includes("|") && !inner.startsWith("(")) return \`(\${inner})[]\`;
      return \`\${inner}[]\`;
    }
    case "object": {
      const shape = def.shape;
      const entries = Object.entries(shape);
      if (entries.length === 0) return "{}";
      const props = entries.map(([key, value]) => {
        const isOptional = getTypeName(getDef(value)) === "optional";
        const typeStr = convert(value);
        return \`\${key}\${isOptional ? "?" : ""}: \${typeStr}\`;
      });
      return \`{ \${props.join("; ")}; }\`;
    }
    case "optional": return \`\${convert(def.innerType)} | undefined\`;
    case "nullable": return \`\${convert(def.innerType)} | null\`;
    case "union": return def.options.map(convert).join(" | ");
    case "intersection": return \`\${convert(def.left)} & \${convert(def.right)}\`;
    case "tuple": {
      const itemTypes = def.items.map(convert);
      if (def.rest) return \`[\${itemTypes.join(", ")}, ...\${convert(def.rest)}[]]\`;
      return \`[\${itemTypes.join(", ")}]\`;
    }
    case "record": {
      const keyType = def.keyType ? convert(def.keyType) : "string";
      return \`Record<\${keyType}, \${convert(def.valueType)}>\`;
    }
    case "map": return \`Map<\${convert(def.keyType)}, \${convert(def.valueType)}>\`;
    case "set": return \`Set<\${convert(def.valueType)}>\`;
    case "promise": return \`Promise<\${convert(def.innerType)}>\`;
    case "function": {
      const inputType = def.input ? convert(def.input) : "[]";
      const outputType = def.output ? convert(def.output) : "void";
      return \`(...args: \${inputType}) => \${outputType}\`;
    }
    case "lazy": return convert(def.getter());
    case "default": case "prefault": case "catch": case "readonly": case "nonoptional": case "success":
      return convert(def.innerType);
    case "transform": return "unknown";
    case "pipe": return convert(def.out);
    case "custom": return "unknown";
    case "template_literal": return "string";
    default: return "unknown";
  }
}
function zodToTypeString(schema) { return convert(schema); }

const filePath = Deno.args[0];
try {
  const mod = await import(filePath);
  const apiDef = mod.handler?.__apiDef;
  if (!apiDef) {
    console.log("null");
    Deno.exit(0);
  }

  // Convert Zod schemas to type strings before serializing
  const result = {};
  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
    result[method] = {
      bodyType: def.body ? zodToTypeString(def.body) : undefined,
      responseType: def.response ? zodToTypeString(def.response) : undefined,
    };
  }
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(e.message);
  Deno.exit(1);
}
`;

/**
 * Import a module using subprocess with the given config.
 * This allows importing files that use the config's import map.
 */
async function importWithConfig(
  filePath: string,
  configPath: string,
): Promise<ApiDef | undefined> {
  const absolutePath = await Deno.realPath(filePath);
  const fileUrl = toFileUrl(absolutePath).href;

  const cmd = new Deno.Command("deno", {
    args: [
      "eval",
      "--config",
      configPath,
      IMPORT_HELPER_SCRIPT,
      fileUrl, // Pass target file URL as an argument to the script
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new Error(`Failed to import ${filePath} via eval: ${errorText}`);
  }

  const output = new TextDecoder().decode(stdout).trim();
  if (output === "null") {
    return undefined;
  }

  try {
    const result = JSON.parse(output);
    return result ?? undefined;
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from eval subprocess for ${filePath}: ${
        typeof e === "object" && e && "message" in e ? e.message : e
      }\nReceived: ${output}`,
    );
  }
}

interface EndpointType {
  name: string;
  path: string;
  method: string;
  request?: string;
  response?: string;
}

/**
 * Import a route module and extract its apiDef.
 * Uses subprocess with config if provided, otherwise direct import.
 */
async function getApiDef(
  filePath: string,
  config: string | undefined,
  cacheBuster: string,
): Promise<{ filePath: string; apiDef: ApiDef | undefined }> {
  if (config) {
    const apiDef = await importWithConfig(filePath, config);
    return { filePath, apiDef };
  }

  const absolutePath = await Deno.realPath(filePath);
  const fileUrl = toFileUrl(absolutePath).href + cacheBuster;
  const mod = (await import(fileUrl)) as RouteModule;
  return { filePath, apiDef: mod.handler?.__apiDef };
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

  const endpoints: EndpointType[] = [];
  const cacheBuster = `?t=${Date.now()}`;

  // Import all route files (in parallel when using config for better perf)
  const importResults = await Promise.all(
    routeFiles
      .sort()
      .map((filePath) => getApiDef(filePath, config, cacheBuster)),
  );

  for (const { filePath, apiDef } of importResults) {
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

      // When using subprocess, we get type strings directly (bodyType/responseType)
      // When using direct import, we get Zod schemas (body/response)
      // Use type assertion since subprocess returns a different shape
      const def = methodDef as {
        body?: unknown;
        response?: unknown;
        bodyType?: string;
        responseType?: string;
      };

      if (def.bodyType) {
        endpoint.request = def.bodyType;
      } else if (def.body) {
        endpoint.request = zodToTypeString(
          def.body as Parameters<typeof zodToTypeString>[0],
        );
      }

      if (def.responseType) {
        endpoint.response = def.responseType;
      } else if (def.response) {
        endpoint.response = zodToTypeString(
          def.response as Parameters<typeof zodToTypeString>[0],
        );
      }

      endpoints.push(endpoint);
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
