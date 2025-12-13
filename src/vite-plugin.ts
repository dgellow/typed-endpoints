import type { Plugin } from "vite";
import { generateOpenApiSpec, type GeneratorOptions } from "./core/openapi.ts";

export interface OpenApiPluginOptions extends GeneratorOptions {
  /** Output path for the spec file. Default: static/openapi.json */
  outputPath?: string;
}

/**
 * Vite plugin to generate OpenAPI spec at build time.
 * Only includes routes with public: true.
 */
export function openApiPlugin(options: OpenApiPluginOptions = {}): Plugin {
  const { outputPath = "static/openapi.json", ...generatorOptions } = options;

  return {
    name: "typed-endpoints-openapi",
    apply: "build",

    async closeBundle() {
      try {
        const spec = await generateOpenApiSpec(generatorOptions);

        // Ensure output directory exists
        const dir = outputPath.split("/").slice(0, -1).join("/");
        if (dir) {
          try {
            await Deno.mkdir(dir, { recursive: true });
          } catch {
            // Directory may already exist
          }
        }

        await Deno.writeTextFile(
          outputPath,
          JSON.stringify(spec, null, 2) + "\n",
        );
        console.log(`\x1b[32m✓\x1b[0m Generated ${outputPath}`);
      } catch (error) {
        console.error(
          `\x1b[31m✗\x1b[0m Failed to generate OpenAPI spec:`,
          error,
        );
      }
    },
  };
}
