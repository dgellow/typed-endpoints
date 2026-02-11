#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

import { parseArgs } from "@std/cli/parse-args";
import { generateTypes } from "./tsgen/mod.ts";
import { generateProtocolTypesFromModule } from "./protocol/typegen.ts";

const help = `
typed-endpoints - Generate TypeScript types from API route Zod schemas

Usage:
  typed-endpoints [options]

Options:
  -r, --routes <dir>    Routes directory (can be specified multiple times)
  -o, --output <file>   Output file path (required)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -f, --format <fmt>    Output format: types, client, routes, or protocol (default: types)
  -p, --protocol <file> Protocol module path (required when --format protocol)
  -h, --help            Show this help message

Formats:
  types    - Flat type exports (UsersGetResponse, etc.)
  client   - Resource-based Api interface for createClient()
  routes   - Runtime route metadata for createHttpExecutor()
  protocol - Branded types from a protocol module

Examples:
  typed-endpoints -r routes/api -o src/api-types.ts
  typed-endpoints -r routes/api -o src/api-client.ts --format client
  typed-endpoints -r routes/api -o src/api-routes.ts --format routes
  typed-endpoints --format protocol --protocol ./my-protocol.ts -o src/protocol-types.ts
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
    string: ["output", "config", "format", "protocol"],
    boolean: ["help"],
    collect: ["routes"],
    alias: {
      r: "routes",
      o: "output",
      c: "config",
      f: "format",
      p: "protocol",
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

  // Validate format
  const format = args.format as
    | "types"
    | "client"
    | "routes"
    | "protocol"
    | undefined;
  if (format && !["types", "client", "routes", "protocol"].includes(format)) {
    console.error(
      `Error: Invalid format "${format}". Must be: types, client, routes, or protocol\n`,
    );
    console.log(help);
    Deno.exit(1);
  }

  if (format === "protocol") {
    if (!args.protocol) {
      console.error(
        "Error: --protocol is required when using --format protocol\n",
      );
      console.log(help);
      Deno.exit(1);
    }

    try {
      const output = await generateProtocolTypesFromModule(
        args.protocol,
        config,
      );
      await Deno.writeTextFile(args.output, output);
      console.log(`Generated protocol types written to ${args.output}`);
    } catch (error) {
      console.error("Error generating protocol types:", error);
      Deno.exit(1);
    }
    return;
  }

  // Default to routes/api if no routes specified
  const routes = (args.routes ?? []) as string[];
  const routesDirs = routes.length > 0 ? routes : ["routes/api"];

  try {
    await generateTypes({
      routesDirs,
      output: args.output,
      config,
      format,
    });
    console.log(`Generated ${format ?? "types"} written to ${args.output}`);
  } catch (error) {
    console.error("Error generating types:", error);
    Deno.exit(1);
  }
}

main();
