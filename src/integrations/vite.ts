/**
 * Vite Integration
 *
 * Build-time plugins for Vite that run during `vite build` (closeBundle hook).
 *
 * - openApiPlugin() — generates OpenAPI spec files from route definitions
 * - protocolTypesPlugin() — generates branded TypeScript types from protocol modules
 *
 * @module
 */

import type { Plugin } from "vite";
import { generateOpenApiSpec, type GeneratorOptions } from "../core/openapi.ts";
import { generateProtocolTypesFromModule } from "../protocol/typegen.ts";

export interface OpenApiPluginOptions extends GeneratorOptions {
  /** Output path for the spec file. Default: static/openapi.json */
  outputPath?: string;
}

export interface ProtocolTypesPluginOptions {
  /** Path to the protocol module file */
  protocolModule: string;
  /** Output path for the generated types. Default: src/protocol-types.ts */
  outputPath?: string;
  /** Path to deno.json config (for import map resolution) */
  config?: string;
}

/**
 * Vite plugin to generate branded protocol types at build time.
 */
export function protocolTypesPlugin(
  options: ProtocolTypesPluginOptions,
): Plugin {
  const { protocolModule, outputPath = "src/protocol-types.ts", config } =
    options;

  return {
    name: "typed-endpoints-protocol-types",
    apply: "build",

    async closeBundle() {
      try {
        const output = await generateProtocolTypesFromModule(
          protocolModule,
          config,
        );

        // Ensure output directory exists
        const dir = outputPath.split("/").slice(0, -1).join("/");
        if (dir) {
          await Deno.mkdir(dir, { recursive: true });
        }

        await Deno.writeTextFile(outputPath, output);
        console.log(`\x1b[32m✓\x1b[0m Generated ${outputPath}`);
      } catch (error) {
        console.error(
          `\x1b[31m✗\x1b[0m Failed to generate protocol types:`,
          error,
        );
      }
    },
  };
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
          await Deno.mkdir(dir, { recursive: true });
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
