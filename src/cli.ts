#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

import { parseArgs } from "@std/cli/parse-args";
import { generateTypes } from "./tsgen/mod.ts";

const help = `
typed-endpoints - Generate TypeScript types from API route Zod schemas

Usage:
  typed-endpoints [options]

Options:
  -r, --routes <dir>    Routes directory (can be specified multiple times)
  -o, --output <file>   Output file path (required)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -h, --help            Show this help message

Examples:
  typed-endpoints -r routes/api -o src/api-types.ts
  typed-endpoints -r routes/api -r routes/webhooks -o src/api-types.ts
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
    string: ["output", "config"],
    boolean: ["help"],
    collect: ["routes"],
    alias: {
      r: "routes",
      o: "output",
      c: "config",
      h: "help",
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

  // Default to routes/api if no routes specified
  const routes = args.routes as string[];
  const routesDirs = routes.length > 0 ? routes : ["routes/api"];

  try {
    await generateTypes({
      routesDirs,
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
