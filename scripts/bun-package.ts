// Writes the package.json files scripts/test-bun needs, from deno.json.
//
// usage: bun scripts/bun-package.ts <deno.json> <package.json of the package> <package.json of the consumer>

import { readFileSync, writeFileSync } from "node:fs";

const [denoJsonPath, packagePath, consumerPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(denoJsonPath, "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  imports: Record<string, string>;
};

// `npm:zod@^4.6.7` -> ["zod", "^4.6.7"]. Only what the published sources
// import: test-only and Deno-only (jsr:) entries are left out.
const dependencies: Record<string, string> = {};
for (const [name, specifier] of Object.entries(config.imports)) {
  const match = /^npm:(.+)@([^@]+)$/.exec(specifier);
  if (match && name !== "vite") dependencies[match[1]] = match[2];
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

writeFileSync(
  consumerPath,
  JSON.stringify(
    { name: "bun-consumer", private: true, type: "module", dependencies },
    null,
    2,
  ),
);
