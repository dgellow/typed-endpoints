import { assert, assertEquals } from "@std/assert";

import { generateTypes } from "../tsgen/mod.ts";
import { type ContractOperation, generateContract } from "./index.ts";

const CONFORMANCE_FIXTURE = "e2e_tests/fixtures/conformance/routes";
const TSGEN_FIXTURE = "src/tsgen/fixtures/routes/api";

function byId(
  operations: readonly ContractOperation[],
): Record<string, ContractOperation> {
  return Object.fromEntries(operations.map((op) => [op.operationId, op]));
}

Deno.test("contract: every operation, ordered by path and method, with its template", async () => {
  const contract = await generateContract({
    routesDirs: [CONFORMANCE_FIXTURE],
  });

  assertEquals(contract.version, 1);
  assertEquals(
    contract.operations.map((op) =>
      `${op.method} ${op.path} ${op.operationId}`
    ),
    [
      "GET /api/echo/{+path} echoRetrieve",
      "POST /api/edges edgesCreate",
      "GET /api/notes notesList",
      "POST /api/notes notesCreate",
      "DELETE /api/notes/{id} notesDelete",
      "GET /api/notes/{id} notesRetrieve",
      "PUT /api/notes/{id} notesUpdate",
      "POST /api/odd oddCreate",
      "POST /api/shapes shapesCreate",
      "GET /api/ticks ticksList",
      "POST /api/trees treesCreate",
    ],
  );

  const operations = byId(contract.operations);
  assertEquals(operations.notesRetrieve.pathParams, [
    { name: "id", catchAll: false },
  ]);
  // A catch-all takes the rest of the path.
  assertEquals(operations.echoRetrieve.pathParams, [
    { name: "path", catchAll: true },
  ]);
  assertEquals(operations.notesList.pathParams, []);
});

Deno.test("contract: operation ids are the ones the route table uses", async () => {
  const contract = await generateContract({
    routesDirs: [CONFORMANCE_FIXTURE],
  });
  const table = await generateTypes({
    routesDirs: [CONFORMANCE_FIXTURE],
    format: "routes",
  });
  for (const { operationId } of contract.operations) {
    assert(table.includes(`  ${operationId}: {`), operationId);
  }
});

Deno.test("contract: request parts are the input side, responses the output side", async () => {
  const { shapesCreate, notesUpdate } = byId(
    (await generateContract({ routesDirs: [CONFORMANCE_FIXTURE] })).operations,
  );

  // `unit` has a default: a client may leave it out, a response has it.
  const required = (schema: unknown) =>
    (schema as { required: string[] }).required;
  assertEquals(required(shapesCreate.body), ["shape", "from", "meta", "note"]);
  assertEquals(required(shapesCreate.response), [
    "area",
    "kind",
    "from",
    "meta",
    "unit",
    "note",
  ]);

  // A body is open (Zod strips what it does not know); a response is
  // closed.
  const body = notesUpdate.body as Record<string, unknown>;
  const response = notesUpdate.response as Record<string, unknown>;
  assertEquals("additionalProperties" in body, false);
  assertEquals(response.additionalProperties, false);
  assertEquals(
    (body.properties as Record<string, unknown>).title,
    { type: "string", minLength: 1, maxLength: 40 },
  );
});

Deno.test("contract: declared errors, named schemas, pagination", async () => {
  const { notesRetrieve, notesCreate, notesList, notesUpdate } = byId(
    (await generateContract({ routesDirs: [CONFORMANCE_FIXTURE] })).operations,
  );

  // Statuses of 400 and above, by status.
  assertEquals(Object.keys(notesRetrieve.errors ?? {}), ["404"]);
  assertEquals(Object.keys(notesCreate.errors ?? {}), ["409"]);
  assertEquals(notesUpdate.errors, undefined);

  // A schema with an id is a definition, referred to by name.
  const notFound = notesRetrieve.errors!["404"] as Record<string, unknown>;
  assertEquals(notFound.$ref, "#/$defs/NotFound");
  assertEquals(Object.keys(notFound.$defs as object), ["NotFound"]);

  // What JSON Schema does not carry.
  assertEquals(notesList.pagination, {
    style: "cursor",
    items: "items",
    cursor: "cursor",
    cursorParam: "cursor",
    limitParam: "limit",
  });
});

Deno.test("contract: an event stream lists its events; what JSON Schema cannot state is open", async () => {
  const operations = (await generateContract({ routesDirs: [TSGEN_FIXTURE] }))
    .operations;
  const streams = operations.filter((op) => op.events);
  assert(streams.length > 0, "the fixture has an SSE endpoint");
  for (const stream of streams) {
    assertEquals(stream.method, "GET");
    for (const schema of Object.values(stream.events!)) {
      assertEquals(typeof schema, "object");
    }
  }

  // The data schema of each event, and the keep-alive interval.
  const { ticksList } = byId(
    (await generateContract({ routesDirs: [CONFORMANCE_FIXTURE] })).operations,
  );
  assertEquals(Object.keys(ticksList.events!), ["tick", "done"]);
  assertEquals(
    (ticksList.events!.tick as { required: string[] }).required,
    ["n"],
  );
  assertEquals(ticksList.keepAlive, 40);
  assertEquals(ticksList.response, undefined);
});

Deno.test("contract: `output` writes the same document as JSON", async () => {
  const output = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const contract = await generateContract({
      routesDirs: [CONFORMANCE_FIXTURE],
      output,
    });
    assertEquals(JSON.parse(await Deno.readTextFile(output)), contract);
  } finally {
    await Deno.remove(output);
  }
});
