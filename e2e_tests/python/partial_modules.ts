/**
 * Modules for APIs that use only a part of what the generators can write.
 *
 * The fixture API has every kind of operation, so its modules have every
 * fixed part of a generated module. An API without a body, or without an
 * event stream, gets a module without the parts that read one, and that
 * module has to stand by itself: nothing it names is missing, and nothing
 * it defines or imports is left unused, which a type checker in strict
 * mode reports.
 *
 * Run by `./scripts/test-python` with a directory: it writes a FastAPI
 * module and a client module per API there, and ruff and pyright are run
 * over them. `src/python/fastapi_test.ts` and `src/python/client_test.ts`
 * check the same APIs by the text of their modules.
 */

import type { Contract, ContractOperation } from "../../src/contract/index.ts";
import { renderFastApi, renderPythonClient } from "../../src/python/index.ts";

const NOTE = {
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string" } },
  required: ["id", "title"],
};

const LIST: ContractOperation = {
  operationId: "notesList",
  method: "GET",
  path: "/notes",
  pathParams: [],
  response: { type: "array", items: NOTE },
};
const SEARCH: ContractOperation = {
  ...LIST,
  operationId: "notesSearch",
  path: "/notes/search",
  // A summary and a description too long for a line.
  summary:
    "Search the notes, with a summary that is long enough not to fit on the line it is on",
  query: {
    type: "object",
    properties: {
      limit: { type: "integer" },
      text: {
        type: "string",
        description:
          "What a note has to contain: a description that is long enough not to fit on its line.",
      },
    },
  },
};
const RETRIEVE: ContractOperation = {
  operationId: "notesRetrieve",
  method: "GET",
  path: "/notes/{id}",
  pathParams: [{ name: "id", catchAll: false }],
  response: NOTE,
};
const CREATE: ContractOperation = {
  operationId: "notesCreate",
  method: "POST",
  path: "/notes",
  pathParams: [],
  body: {
    type: "object",
    properties: { title: { type: "string", pattern: "^\\w+$" } },
    required: ["title"],
  },
  response: NOTE,
};
const MISSING = {
  type: "object",
  properties: { error: { type: "string", const: "not_found" } },
  required: ["error"],
};
const READ: ContractOperation = {
  operationId: "filesRetrieve",
  method: "GET",
  path: "/files/{+path}",
  pathParams: [{ name: "path", catchAll: true }],
  response: NOTE,
  errors: { 404: MISSING },
};
const PAGES: ContractOperation = {
  operationId: "notesPages",
  method: "GET",
  path: "/pages",
  pathParams: [],
  query: {
    type: "object",
    properties: { cursor: { type: "string" } },
  },
  response: {
    type: "object",
    properties: {
      items: { type: "array", items: NOTE },
      cursor: { type: "string" },
    },
    required: ["items"],
  },
  pagination: {
    style: "cursor",
    items: "items",
    cursor: "cursor",
    cursorParam: "cursor",
  },
};
const WATCH: ContractOperation = {
  operationId: "notesWatch",
  method: "GET",
  path: "/notes/watch",
  pathParams: [],
  events: { changed: NOTE },
};

function contract(...operations: ContractOperation[]): Contract {
  return { version: 1, operations };
}

/** The APIs, by a name that is also the name of their modules. */
export const PARTIAL_APIS: Readonly<Record<string, Contract>> = {
  nothing_read: contract(LIST),
  query_only: contract(SEARCH),
  params_only: contract(RETRIEVE),
  body_only: contract(CREATE),
  stream_only: contract(WATCH),
  stream_with_query: contract({ ...WATCH, query: SEARCH.query! }),
  catch_all_and_error: contract(READ),
  paginated: contract(PAGES),
  every_kind: contract(LIST, SEARCH, RETRIEVE, CREATE, READ, PAGES, WATCH),
};

// What the tests of the generators ask of the text of a module. A type
// checker asks the same of the module itself, in `./scripts/test-python`.

/**
 * The private names a module defines at its top level and does not use
 * anywhere else in it.
 */
export function unused(source: string): string[] {
  const defined = [
    ...source.matchAll(
      /^(?:(?:async )?def |class |type )?(_[A-Za-z0-9_]+)(?=[ (:[=])/gm,
    ),
  ].map((match) => match[1]);
  return [...new Set(defined)].filter((name) =>
    source.match(new RegExp(`(?<![\\w.])${name}\\b`, "g"))!.length < 2
  );
}

/**
 * The private names a module uses and defines nowhere: neither at its top
 * level nor as a method.
 */
export function undefinedNames(source: string): string[] {
  const defined = new Set(
    [
      ...source.matchAll(
        /^(?:(?:async )?def |class |type )?(_[A-Za-z0-9_]+)(?=[ (:[=])/gm,
      ),
      ...source.matchAll(/^ +(?:async )?def (_[A-Za-z0-9_]+)\(/gm),
    ].map((match) => match[1]),
  );
  // Without strings and comments, where a name is a word.
  const code = source.replace(/"""[\s\S]*?"""/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "")
    .replace(/#.*$/gm, "");
  const used = [...code.matchAll(/(?<![\w.])_[A-Za-z][A-Za-z0-9_]*/g)]
    .map((match) => match[0]);
  return [...new Set(used)].filter((name) => !defined.has(name));
}

/** The names a module imports and does not use. */
export function unusedImports(source: string): string[] {
  const body = source.replace(/^(?:from \S+ )?import [^(\n]+$/gm, "")
    .replace(/^from \S+ import \([^)]*\)$/gm, "");
  const imported = [
    ...source.matchAll(/^from \S+ import \(?([^)]*?)\)?$/gm),
  ].flatMap((match) => match[1].split(",").map((name) => name.trim()))
    .concat(
      [...source.matchAll(/^import (\S+)$/gm)].map((match) => match[1]),
    )
    .filter((name) => name !== "");
  return imported.filter((name) =>
    !new RegExp(`(?<![\\w."])${name.replaceAll(".", "\\.")}\\b(?!")`).test(body)
  );
}

if (import.meta.main) {
  const [directory] = Deno.args;
  if (!directory) {
    throw new Error("usage: partial_modules.ts <directory>");
  }
  for (const [name, api] of Object.entries(PARTIAL_APIS)) {
    await Deno.writeTextFile(
      `${directory}/partial_${name}_api.py`,
      renderFastApi(api, { source: `the API "${name}"` }),
    );
    await Deno.writeTextFile(
      `${directory}/partial_${name}_client.py`,
      renderPythonClient(api, { source: `the API "${name}"` }),
    );
  }
}
