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
 * module per API there, and ruff and pyright are run over them.
 * `src/python/fastapi_test.ts` checks the same APIs by the text of their
 * modules.
 */

import type { Contract, ContractOperation } from "../../src/contract/index.ts";
import { renderFastApi } from "../../src/python/index.ts";

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
  every_kind: contract(LIST, SEARCH, RETRIEVE, CREATE, WATCH),
};

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
  }
}
