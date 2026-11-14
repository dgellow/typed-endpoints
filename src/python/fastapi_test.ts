/**
 * The FastAPI module, as far as its text says.
 *
 * That the module runs, is formatted as `ruff format` formats, passes
 * every ruff rule and pyright in strict mode, and answers as the
 * TypeScript handlers answer is established by `./scripts/test-python`,
 * for the fixture's API. The fixture has every kind of operation, so it
 * uses every fixed part of the module. These tests are about an API that
 * does not: its module carries only the parts it uses, and a type checker
 * in strict mode reports a private name that nothing uses.
 */

import { assertEquals } from "@std/assert";

import {
  PARTIAL_APIS,
  undefinedNames,
  unused,
  unusedImports,
} from "../../e2e_tests/python/partial_modules.ts";
import type { Contract, ContractOperation } from "../contract/index.ts";
import { renderFastApi } from "./fastapi.ts";

const [LIST] = PARTIAL_APIS.nothing_read.operations;
const [SEARCH] = PARTIAL_APIS.query_only.operations;
const [CREATE] = PARTIAL_APIS.body_only.operations;

function contract(...operations: ContractOperation[]): Contract {
  return { version: 1, operations };
}

for (const [name, api] of Object.entries(PARTIAL_APIS)) {
  Deno.test(`fastapi module: ${name}: nothing is defined or imported and not used`, () => {
    const source = renderFastApi(api);
    assertEquals(unused(source), []);
    assertEquals(undefinedNames(source), []);
    assertEquals(unusedImports(source), []);
  });
}

Deno.test("fastapi module: the checks themselves find what is not used", () => {
  const source = [
    "import json",
    "from typing import Any, Final",
    "",
    "_KEPT: Final = 1",
    "_DROPPED = 2",
    "",
    "def _helper(value: Any) -> int:",
    "    return _KEPT",
    "",
    "class _Unused:",
    "    pass",
  ].join("\n");
  assertEquals(unused(source), ["_DROPPED", "_helper", "_Unused"]);
  assertEquals(undefinedNames(`${source}\n_other = _missing(_KEPT)`), [
    "_missing",
  ]);
  // A name in a string is not a use of the module.
  assertEquals(unusedImports(`${source}\n_TEXT = "json"`), ["json"]);
});

Deno.test("fastapi module: a module without a request part has no contract and no checker", () => {
  const source = renderFastApi(contract(LIST));
  for (
    const name of ["_Part", "_Checker", "_Route", "_described", ": Request"]
  ) {
    assertEquals(source.includes(name), false, name);
  }
  assertEquals(source.includes("router = APIRouter()"), true);
});

Deno.test("fastapi module: a route reads the body, the query, then the path", () => {
  const source = renderFastApi(contract({
    ...CREATE,
    operationId: "notesReplace",
    method: "PUT",
    path: "/notes/{id}",
    pathParams: [{ name: "id", catchAll: false }],
    query: SEARCH.query!,
  }));
  // The last one: the first is the method of `Handlers`.
  const start = source.lastIndexOf("    async def notes_replace(");
  assertEquals(
    source.slice(start, source.indexOf("\n\n\n", start)).split("\n"),
    [
      "    async def notes_replace(request: Request) -> Response:",
      "        body = await _body(request, _NOTES_REPLACE_BODY)",
      "        query = _query(request, _NOTES_REPLACE_QUERY)",
      "        params = _params(request, _NOTES_REPLACE_PARAMS)",
      "        return await _respond(",
      '            "PUT /notes/{id}",',
      "            handlers.notes_replace(params=params, query=query, body=body),",
      "            _NOTES_REPLACE_RESPONSE,",
      "            _NOTES_REPLACE_ERRORS,",
      "        )",
    ],
  );
});

Deno.test("fastapi module: operations that take the same part share it, each under its name", () => {
  const source = renderFastApi(contract(CREATE, {
    ...CREATE,
    operationId: "notesDraft",
    path: "/drafts",
  }));
  // Written once, as the class of the body is.
  assertEquals(source.match(/^_NOTES_\w+_BODY: _Part/gm), [
    "_NOTES_CREATE_BODY: _Part",
  ]);
  assertEquals(source.includes("\nNotesDraftBody = NotesCreateBody\n"), true);
  assertEquals(
    source.includes("\n_NOTES_DRAFT_BODY = _NOTES_CREATE_BODY\n"),
    true,
  );
  assertEquals(
    source.includes("body = await _body(request, _NOTES_DRAFT_BODY)"),
    true,
  );
});
