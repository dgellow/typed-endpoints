#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=TSC_*,NODE_*,VSCODE_INSPECTOR_OPTIONS

import { parseArgs } from "@std/cli/parse-args";
import { generateTypes } from "./tsgen/mod.ts";

const help = `
typed-endpoints - Generate TypeScript types from API route Zod schemas

Usage:
  typed-endpoints [options]

Options:
  -r, --routes <dir>    Routes directory (default: routes/api)
  -o, --output <file>   Output file path (required)
  -h, --help            Show this help message

Example:
  typed-endpoints --routes routes/api --output src/api-types.ts
`;

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["routes", "output"],
    boolean: ["help"],
    alias: {
      r: "routes",
      o: "output",
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

  try {
    await generateTypes({
      routesDir: args.routes,
      output: args.output,
    });
    console.log(`Generated types written to ${args.output}`);
  } catch (error) {
    console.error("Error generating types:", error);
    Deno.exit(1);
  }
}

main();
