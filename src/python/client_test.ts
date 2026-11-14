/**
 * The Python client module, as far as its text says.
 *
 * That the module runs against a server, is formatted as `ruff format`
 * formats, and passes every ruff rule and pyright in strict mode is
 * established by `./scripts/test-python`. These tests are about an API
 * that uses only a part of what the generator writes: its module carries
 * only the parts it uses.
 */

import { assertEquals } from "@std/assert";

import {
  PARTIAL_APIS,
  undefinedNames,
  unused,
  unusedImports,
} from "../../e2e_tests/python/partial_modules.ts";
import { renderPythonClient } from "./client.ts";

for (const [name, api] of Object.entries(PARTIAL_APIS)) {
  Deno.test(`python client module: ${name}: nothing is defined or imported and not used`, () => {
    const source = renderPythonClient(api);
    assertEquals(unused(source), []);
    assertEquals(undefinedNames(source), []);
    assertEquals(unusedImports(source), []);
  });
}

Deno.test("python client module: a module has the functions its operations call", () => {
  const defined = (source: string) =>
    [...source.matchAll(/^def (_\w+)/gm)].map((match) => match[1]);

  // A list without parameters: a response is read, and nothing else.
  assertEquals(defined(renderPythonClient(PARTIAL_APIS.nothing_read)), [
    "_content",
    "_parse",
    "_expect",
  ]);
  assertEquals(defined(renderPythonClient(PARTIAL_APIS.query_only)), [
    "_query",
    "_content",
    "_parse",
    "_expect",
  ]);
  // A catch-all parameter and a declared error.
  assertEquals(defined(renderPythonClient(PARTIAL_APIS.catch_all_and_error)), [
    "_rest",
    "_content",
    "_parse",
    "_expect",
    "_result",
  ]);
  // Only event streams, which the client does not have yet: no operation.
  assertEquals(defined(renderPythonClient(PARTIAL_APIS.stream_only)), []);
});

Deno.test("python client module: the class says what its methods do, and no more", () => {
  const plain = renderPythonClient(PARTIAL_APIS.nothing_read);
  assertEquals(plain.includes("`_result` returns"), false);
  assertEquals(plain.includes("_pages"), false);

  const paginated = renderPythonClient(PARTIAL_APIS.paginated);
  assertEquals(paginated.includes("def _pages("), true);
  assertEquals(
    paginated.includes(
      "`_pages` and `_items` follow a paginated list to its end.",
    ),
    true,
  );
  assertEquals(paginated.includes("`_result` returns"), false);
});

Deno.test("python client module: a module without models has no banner for them", () => {
  // No operation, no model: the banner of the client follows the errors.
  const source = renderPythonClient(PARTIAL_APIS.stream_only);
  assertEquals(source.includes("# Models"), false);
  assertEquals(/\n\n\n\n/.test(source), false);
});
