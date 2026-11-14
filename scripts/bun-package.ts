// Writes the package.json files scripts/test-bun needs, from deno.json.
//
// usage: bun scripts/bun-package.ts <deno.json> <package.json of the package> <package.json of the consumer>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [denoJsonPath, packagePath, consumerPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(denoJsonPath, "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  imports: Record<string, string>;
};

// The versions Deno runs with: deno.json names a range (`npm:zod@^4.6.7`),
// deno.lock the version it resolved to (`4.6.7`). Bun gets that one, so
// that both runtimes test the same code.
const lock = JSON.parse(
  readFileSync(join(dirname(denoJsonPath), "deno.lock"), "utf8"),
) as { specifiers: Record<string, string> };

// Only what the published sources import: test-only and Deno-only (jsr:)
// entries are left out.
const dependencies: Record<string, string> = {};
for (const [name, specifier] of Object.entries(config.imports)) {
  const match = /^npm:(.+)@([^@]+)$/.exec(specifier);
  if (!match || name === "vite") continue;
  const resolved = lock.specifiers[specifier];
  if (!resolved) {
    throw new Error(`deno.lock has no version for ${specifier}`);
  }
  // `9.1.0_zod@4.6.7`: the version, then the peers it was resolved with.
  dependencies[match[1]] = resolved.split("_")[0];
}

writeFileSync(
  packagePath,
  JSON.stringify(
    {
      name: config.name,
      version: config.version,
      type: "module",
      exports: config.exports,
    },
    null,
    2,
  ),
);

// Frameworks the Bun tests run the integrations in. The package itself
// does not depend on them. Exact versions: a new release of a framework
// changes what is tested only when this file changes.
const frameworks = {
  hono: "4.13.18",
  h3: "2.0.8",
};

writeFileSync(
  consumerPath,
  JSON.stringify(
    {
      name: "bun-consumer",
      private: true,
      type: "module",
      dependencies: { ...dependencies, ...frameworks },
    },
    null,
    2,
  ),
);
