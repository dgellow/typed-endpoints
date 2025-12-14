#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

import { parseArgs } from "@std/cli/parse-args";
import { generateTypes } from "./tsgen/mod.ts";

const help = `
typed-endpoints - Generate TypeScript types from API route Zod schemas

Usage:
  typed-endpoints [options]

Options:
  -r, --routes <dir>    Routes directory (default: routes/api)
  -o, --output <file>   Output file path (required)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -h, --help            Show this help message

Example:
  typed-endpoints --routes routes/api --output src/api-types.ts
`;

/**
 * Try to find deno.json or deno.jsonc in the current directory.
 */
async function findDenoConfig(): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      await Deno.stat(name);
      return name;
    } catch {
      // File doesn't exist, try next
    }
  }
  return undefined;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["routes", "output", "config"],
    boolean: ["help"],
    alias: {
      r: "routes",
      o: "output",
      c: "config",
      h: "help",
    },
    default: {
      routes: "routes/api",
    },
  });

  if (args.help) {
    console.log(help);
    Deno.exit(0);
  }

  if (!args.output) {
    console.error("Error: --output is required\n");
    console.log(help);
    Deno.exit(1);
  }

  // Auto-detect deno.json if not provided
  const config = args.config ?? (await findDenoConfig());

  try {
    await generateTypes({
      routesDir: args.routes,
      output: args.output,
      config,
    });
    console.log(`Generated types written to ${args.output}`);
  } catch (error) {
    console.error("Error generating types:", error);
    Deno.exit(1);
  }
}

main();
