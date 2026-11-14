/**
 * The published sources run on Deno and on Bun. These checks keep the
 * things out that would tie them to Deno; scripts/test-bun proves the
 * result under Bun.
 */

import { assertEquals } from "@std/assert";
import { listRouteFiles } from "./core/routes.ts";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** The files `deno publish` ships: sources without tests and fixtures. */
async function publishedSources(): Promise<string[]> {
  return (await listRouteFiles(SRC)).filter((path) =>
    !path.includes("/fixtures/")
  );
}

/** Code lines: without comment lines, which may mention anything. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
}

Deno.test("published sources use the Deno API only in core/runtime.ts", async () => {
  const offenders: string[] = [];
  for (const path of await publishedSources()) {
    if (path.endsWith("/core/runtime.ts")) continue;
    const lines = codeLines(await Deno.readTextFile(path));
    // `Deno.args` and `Deno.exit` occur in the text of scripts that a Deno
    // subprocess runs; nothing else is expected.
    const uses = lines.filter((line) =>
      /\bDeno\./.test(line.replace(/\bDeno\.(args|exit)\b/g, ""))
    );
    if (uses.length > 0) {
      offenders.push(`${path.slice(SRC.length + 1)}: ${uses[0].trim()}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("published sources import by relative path, node: or package name", async () => {
  const offenders: string[] = [];
  for (const path of await publishedSources()) {
    for (const line of codeLines(await Deno.readTextFile(path))) {
      const specifier = /\bfrom\s+"([^"]+)"/.exec(line)?.[1];
      if (specifier === undefined) continue;
      // The import map alias and Deno's standard library do not resolve
      // outside this repository's deno.json.
      if (specifier.startsWith("@/") || specifier.startsWith("@std/")) {
        offenders.push(`${path.slice(SRC.length + 1)}: ${specifier}`);
      }
    }
  }
  assertEquals(offenders, []);
});
