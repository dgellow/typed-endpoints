#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

import { stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { ROUTE_CONVENTIONS, type RouteConvention } from "./core/routes.ts";
import { generateContract } from "./contract/index.ts";
import { generateFastApi, generatePythonClient } from "./python/index.ts";
import { generateAxum } from "./rust/index.ts";
import { generateTypes } from "./tsgen/mod.ts";
import { generateProtocolTypesFromModule } from "./protocol/typegen.ts";

/** The values of `--format`. */
const FORMATS = [
  "types",
  "client",
  "routes",
  "protocol",
  "contract",
  "fastapi",
  "python-client",
  "axum",
] as const;

const help = `
typed-endpoints - Generate types and code from API route Zod schemas

Usage:
  typed-endpoints [options]

Options:
  -r, --routes <dir>    Routes directory, repeatable (default: routes/api)
  -o, --output <file>   Output file path (required)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -f, --format <fmt>    Output format: types, client, routes, protocol, contract,
                        fastapi, python-client or axum (default: types)
  --convention <name>   Route file layout: fresh, next, sveltekit, astro, or nitro
                        (default: fresh; also the layout for Bun, Hono and fetch)
  -p, --protocol <file> Protocol module path (required when --format protocol)
  --client-import <mod> Module the client format imports its helper types from
                        (default: @dgellow/typed-endpoints/client)
  -h, --help            Show this help message

Formats:
  types    - Flat type exports (UsersGetResponse, etc.)
  client   - Resource-based Api interface for createClient()
  routes   - Runtime route metadata for createHttpExecutor()
  protocol - Branded types from a protocol module
  contract - The routes as JSON: each operation with a JSON Schema per part
  fastapi  - A Python module: Pydantic models, a Handlers protocol and a
             FastAPI router
  python-client - A Python module: Pydantic models and an httpx client
  axum     - A Rust module: serde types, a Handlers trait and an axum router

Examples:
  typed-endpoints -r routes/api -o src/api-types.ts
  typed-endpoints -r routes/api -o src/api-client.ts --format client
  typed-endpoints -r routes/api -o src/api-routes.ts --format routes
  typed-endpoints -r app/api -o src/api-client.ts --format client --convention next
  typed-endpoints --format protocol --protocol ./my-protocol.ts -o src/protocol-types.ts
  typed-endpoints -r routes/api -o server/api_generated.py --format fastapi
  typed-endpoints -r routes/api -o client/api_client.py --format python-client
  typed-endpoints -r routes/api -o server/src/api_generated.rs --format axum
`;

/**
 * Try to find deno.json or deno.jsonc in the current directory.
 */
async function findDenoConfig(): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      await stat(name);
      return name;
    } catch {
      // File doesn't exist, try next
    }
  }
  return undefined;
}

/** Print the problem and the usage, then exit with a failure. */
function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  console.log(help);
  process.exit(1);
}

async function main() {
  // Strict parsing: a misspelled option or a stray argument would otherwise
  // be dropped and the defaults used.
  let args;
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: {
        routes: { type: "string", short: "r", multiple: true },
        output: { type: "string", short: "o" },
        config: { type: "string", short: "c" },
        format: { type: "string", short: "f" },
        protocol: { type: "string", short: "p" },
        "client-import": { type: "string" },
        convention: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (args.help) {
    console.log(help);
    process.exit(0);
  }

  if (!args.output) {
    fail("--output is required");
  }

  // Auto-detect deno.json if not provided
  const config = args.config ?? (await findDenoConfig());

  // Validate format
  const format = args.format as
    | "types"
    | "client"
    | "routes"
    | "protocol"
    | "contract"
    | "fastapi"
    | "python-client"
    | "axum"
    | undefined;
  if (format && !FORMATS.includes(format)) {
    fail(`Invalid format "${format}". Must be: ${FORMATS.join(", ")}`);
  }

  const convention = args.convention as RouteConvention | undefined;
  if (convention && !ROUTE_CONVENTIONS.includes(convention)) {
    fail(
      `Invalid convention "${convention}". Must be: ${
        ROUTE_CONVENTIONS.join(", ")
      }`,
    );
  }

  if (format === "protocol") {
    if (!args.protocol) {
      fail("--protocol is required when using --format protocol");
    }

    try {
      const output = await generateProtocolTypesFromModule(
        args.protocol,
        config,
      );
      await writeFile(args.output, output);
      console.log(`Generated protocol types written to ${args.output}`);
    } catch (error) {
      console.error(
        "Error generating protocol types:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
    return;
  }

  // Default to routes/api if no routes specified
  const routes = args.routes ?? [];
  const routesDirs = routes.length > 0 ? routes : ["routes/api"];

  try {
    if (format === "contract") {
      // The routes as data, for generators in other languages.
      await generateContract({
        routesDirs,
        output: args.output,
        config,
        convention,
      });
    } else if (format === "fastapi") {
      // A Python module: Pydantic models and a FastAPI router.
      await generateFastApi({
        routesDirs,
        output: args.output,
        config,
        convention,
      });
    } else if (format === "python-client") {
      // A Python module: Pydantic models and an httpx client.
      await generatePythonClient({
        routesDirs,
        output: args.output,
        config,
        convention,
      });
    } else if (format === "axum") {
      // A Rust module: serde types and an axum router.
      await generateAxum({
        routesDirs,
        output: args.output,
        config,
        convention,
      });
    } else {
      await generateTypes({
        routesDirs,
        output: args.output,
        config,
        format,
        clientImport: args["client-import"],
        convention,
      });
    }
    console.log(`Generated ${format ?? "types"} written to ${args.output}`);
  } catch (error) {
    console.error(
      "Error generating types:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
