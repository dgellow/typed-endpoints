/**
 * What a handler returns.
 *
 * A handler may return a value instead of a `Response`. The value is typed
 * by the response schema, parsed with it, reduced by its request-dependent
 * rules, and sent as JSON. These tests use the fetch integration, the
 * thinnest wrapper around the shared handler code.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import { applyDependentResponse, expansion, projection } from "./dependent.ts";
import { createApiHandlers, endpoint } from "../integrations/fetch.ts";
import { fail } from "./handlers.ts";

const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["admin", "member"]).default("member"),
});
const Team = z.object({ id: z.string(), title: z.string() });

const ada = { id: "1", name: "Ada", email: "ada@example.test" };

async function captureErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

// =============================================================================
// Returned values
// =============================================================================

Deno.test("a returned value is parsed by the response schema and sent as JSON", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      // Not a Response: the value, typed by the schema's input type. `role`
      // has a default and may be left out; `secret` is not in the schema.
      handler: () => ({ ...ada, secret: "do not send" }),
    }),
  });

  const response = await GET(new Request("http://x/users/1"));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  // The default is applied and the unknown key is stripped.
  assertEquals(await response.json(), { ...ada, role: "member" });
});

Deno.test("a returned value that the schema rejects is a 500, logged, not leaked", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      // The types are bypassed, as a database row of the wrong shape would.
      handler: () =>
        ({ id: 1, name: "Ada" }) as unknown as z.input<typeof User>,
    }),
  });

  const { result: response, errors } = await captureErrors(() =>
    GET(new Request("http://x/users/1"))
  );

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "Internal Server Error" });
  assertEquals(errors.length, 1);
  assertEquals(
    errors[0][0],
    "GET /users/1: the handler returned a value that does not match the response schema:",
  );
  // The issues name the fields; they stay in the log.
  assertEquals(
    (errors[0][1] as { path: string[] }[]).map((issue) => issue.path[0]).sort(),
    ["email", "id"],
  );
});

Deno.test("the returned value is checked at compile time", () => {
  createApiHandlers({
    GET: endpoint({
      response: User,
      // @ts-expect-error `email` is missing
      handler: () => ({ id: "1", name: "Ada" }),
    }),
  });

  createApiHandlers({
    GET: endpoint({
      response: User,
      // @ts-expect-error `id` is a string in the schema
      handler: () => Promise.resolve({ ...ada, id: 1 }),
    }),
  });

  // Without a response schema there is nothing to return but a Response.
  createApiHandlers({
    GET: endpoint({
      // @ts-expect-error a value needs a `response` schema
      handler: () => ({ anything: true }),
    }),
  });
});

Deno.test("a Response is sent as it is, unchecked", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      handler: () =>
        Response.json({ error: "not found" }, {
          status: 404,
          headers: { "X-Reason": "missing" },
        }),
    }),
  });

  const response = await GET(new Request("http://x/users/9"));

  assertEquals(response.status, 404);
  assertEquals(response.headers.get("X-Reason"), "missing");
  assertEquals(await response.json(), { error: "not found" });
});

Deno.test("an async handler and a transforming schema", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      // The handler returns the input side; the client gets the output side.
      response: z.object({ at: z.date().transform((d) => d.toISOString()) }),
      handler: async () => {
        await Promise.resolve();
        return { at: new Date(0) };
      },
    }),
  });

  const response = await GET(new Request("http://x/now"));
  assertEquals(await response.json(), { at: "1970-01-01T00:00:00.000Z" });
});

Deno.test("an undefined value that the schema allows is 204", async () => {
  const { DELETE } = createApiHandlers({
    DELETE: endpoint({
      response: z.undefined(),
      handler: () => undefined,
    }),
  });

  const response = await DELETE(
    new Request("http://x/users/1", { method: "DELETE" }),
  );
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
});

// =============================================================================
// Request-dependent rules are applied by the server
// =============================================================================

Deno.test("a projection is applied to what the handler returns", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      query: z.object({
        fields: z.array(z.enum(["id", "name", "email"])).optional(),
      }),
      response: z.object({
        data: z.array(projection(User.omit({ role: true }), "fields")),
        total: z.number(),
      }),
      // The handler returns complete objects, whatever was asked for.
      handler: () => ({ data: [ada], total: 1 }),
    }),
  });

  const some = await GET(new Request("http://x/users?fields=id&fields=name"));
  assertEquals(await some.json(), {
    data: [{ id: "1", name: "Ada" }],
    total: 1,
  });

  const all = await GET(new Request("http://x/users"));
  assertEquals(await all.json(), { data: [ada], total: 1 });
});

Deno.test("an expansion drops the relations that were not asked for", async () => {
  const Base = User.omit({ role: true });
  const relations = { team: Team, manager: Base };
  const { GET } = createApiHandlers({
    GET: endpoint({
      query: z.object({
        expand: z.array(z.enum(["team", "manager"])).optional(),
      }),
      response: expansion(Base, "expand", relations),
      // The handler loads everything.
      handler: () => ({
        ...ada,
        team: { id: "t1", title: "Compilers" },
        manager: { id: "2", name: "Grace", email: "grace@example.test" },
      }),
    }),
  });

  const plain = await GET(new Request("http://x/users/1"));
  assertEquals(await plain.json(), ada);

  const withTeam = await GET(new Request("http://x/users/1?expand=team"));
  assertEquals(await withTeam.json(), {
    ...ada,
    team: { id: "t1", title: "Compilers" },
  });
});

Deno.test("applyDependentResponse: nested places, wrappers, and what it leaves alone", () => {
  const Item = z.object({ id: z.string(), name: z.string() });
  const schema = z.object({
    first: projection(Item, "fields").optional(),
    list: z.array(projection(Item, "fields")).nullable(),
    plain: Item,
    either: z.union([projection(Item, "fields"), z.string()]),
  });
  const item = { id: "1", name: "A" };
  const value = { first: item, list: [item, item], plain: item, either: item };
  const query = { fields: ["id"] };

  assertEquals(applyDependentResponse(schema, value, query), {
    first: { id: "1" },
    list: [{ id: "1" }, { id: "1" }],
    // Not a dependent place.
    plain: item,
    // A union member: the schema does not say which one the value is.
    either: item,
  });

  // No list in the query: everything.
  assertEquals(applyDependentResponse(schema, value, {}), value);
  assertEquals(applyDependentResponse(schema, value, undefined), value);
  // Values that are not objects pass through.
  assertEquals(applyDependentResponse(schema, null, query), null);
  assertEquals(
    applyDependentResponse(schema, { ...value, list: null }, query),
    { first: { id: "1" }, list: null, plain: item, either: item },
  );
});

// =============================================================================
// Declared error responses: fail()
// =============================================================================

const NotFound = z.object({ error: z.literal("not_found"), id: z.string() });
const Conflict = z.object({
  error: z.literal("conflict"),
  current: z.number(),
  holders: z.array(z.string()).default([]),
});

Deno.test("fail(): a declared error is parsed by its schema and sent with its status", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      responses: { 404: NotFound, 409: { schema: Conflict, name: "Conflict" } },
      handler: (request) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (id === "1") return ada;
        if (id === "busy") {
          // `holders` has a default and may be left out.
          return fail(409, { error: "conflict", current: 3 });
        }
        return fail(404, { error: "not_found", id, extra: "not sent" });
      },
    }),
  });

  const found = await GET(new Request("http://x/users?id=1"));
  assertEquals(found.status, 200);

  const missing = await GET(new Request("http://x/users?id=nope"));
  assertEquals(missing.status, 404);
  assertEquals(missing.headers.get("Content-Type"), "application/json");
  // Parsed with the schema declared for 404: the unknown key is stripped.
  assertEquals(await missing.json(), { error: "not_found", id: "nope" });

  const busy = await GET(new Request("http://x/users?id=busy"));
  assertEquals(busy.status, 409);
  // The schema given as `{ schema, name }`; its default is applied.
  assertEquals(await busy.json(), {
    error: "conflict",
    current: 3,
    holders: [],
  });
});

Deno.test("fail(): the status and the body are checked at compile time", () => {
  const never = false as boolean;
  if (never) {
    createApiHandlers({
      GET: endpoint({
        response: User,
        responses: { 404: NotFound, 409: Conflict },
        // @ts-expect-error 500 is not a status the endpoint declares
        handler: () => fail(500, { error: "boom" }),
      }),
    });
    createApiHandlers({
      GET: endpoint({
        response: User,
        responses: { 404: NotFound, 409: Conflict },
        // @ts-expect-error the body declared for 404 has `error: "not_found"`
        handler: () => fail(404, { error: "gone", id: "1" }),
      }),
    });
    createApiHandlers({
      GET: endpoint({
        response: User,
        responses: { 404: NotFound, 409: Conflict },
        // @ts-expect-error the body of another status
        handler: () => fail(409, { error: "not_found", id: "1" }),
      }),
    });
    createApiHandlers({
      GET: endpoint({
        response: User,
        responses: { 404: NotFound },
        // @ts-expect-error `id` is missing
        handler: () => fail(404, { error: "not_found" }),
      }),
    });
    createApiHandlers({
      GET: endpoint({
        response: User,
        // @ts-expect-error the endpoint declares no error response
        handler: () => fail(404, { error: "not_found", id: "1" }),
      }),
    });
    createApiHandlers({
      GET: endpoint({
        response: User,
        // A success entry is not an error to fail with.
        responses: { 201: User, 404: NotFound },
        // @ts-expect-error 201 is not an error status
        handler: () => fail(201, ada),
      }),
    });
  }
});

Deno.test("fail(): a body the declared schema rejects is a 500, logged, not sent", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      responses: { 404: NotFound },
      // Past the types.
      // deno-lint-ignore no-explicit-any
      handler: () => fail(404, { error: "not_found", id: 7 }) as any,
    }),
  });

  const { result: response, errors } = await captureErrors(() =>
    GET(new Request("http://x/users/7"))
  );

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "Internal Server Error" });
  assertEquals(errors.length, 1);
  assertEquals(
    errors[0][0],
    "GET /users/7: the handler failed with a body that does not match the schema declared for 404:",
  );
});

Deno.test("fail(): a status the endpoint does not declare is a 500, logged", async () => {
  const { GET } = createApiHandlers({
    GET: endpoint({
      response: User,
      responses: { 404: NotFound },
      // Past the types.
      // deno-lint-ignore no-explicit-any
      handler: () => fail(403, { error: "forbidden" }) as any,
    }),
  });

  const { result: response, errors } = await captureErrors(() =>
    GET(new Request("http://x/users/7"))
  );

  assertEquals(response.status, 500);
  assertEquals(errors, [[
    "GET /users/7: the handler failed with status 403, which the endpoint does not declare in `responses`",
  ]]);
});

Deno.test("fail(): an async handler, and a Response next to it", async () => {
  const { DELETE } = createApiHandlers({
    DELETE: endpoint({
      responses: { 404: NotFound },
      handler: async (request) => {
        await Promise.resolve();
        return new URL(request.url).pathname.endsWith("/1")
          ? new Response(null, { status: 204 })
          : fail(404, { error: "not_found", id: "2" });
      },
    }),
  });

  assertEquals((await DELETE(new Request("http://x/users/1"))).status, 204);
  const missing = await DELETE(new Request("http://x/users/2"));
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), { error: "not_found", id: "2" });
});

// =============================================================================
// A request that fails validation
// =============================================================================

Deno.test("a request that fails validation is a 400 that names the part and each issue", async () => {
  let reached = false;
  const { POST } = createApiHandlers({
    POST: endpoint({
      body: z.object({ name: z.string(), age: z.number().int() }),
      query: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
      handler: () => {
        reached = true;
        return new Response(null, { status: 204 });
      },
    }),
  });
  const post = (body: string, query = "", headers?: HeadersInit) =>
    POST(
      new Request(`http://x/users${query}`, { method: "POST", body, headers }),
    );

  const invalid = await post(JSON.stringify({ name: 1, age: 1.5 }));
  assertEquals(invalid.status, 400);
  assertEquals(await invalid.json(), {
    error:
      "Validation error: name: Invalid input: expected string, received number, age: Invalid input: expected int, received number",
    in: "body",
    issues: [
      {
        path: ["name"],
        message: "Invalid input: expected string, received number",
        code: "invalid_type",
      },
      {
        path: ["age"],
        message: "Invalid input: expected int, received number",
        code: "invalid_type",
      },
    ],
  });

  const query = await post(
    JSON.stringify({ name: "Ada", age: 36 }),
    "?dryRun=maybe",
  );
  assertEquals(query.status, 400);
  const queryBody = await query.json();
  assertEquals(queryBody.in, "query");
  assertEquals(queryBody.issues.map((i: { path: unknown }) => i.path), [[
    "dryRun",
  ]]);

  const malformed = await post("{name:");
  assertEquals(malformed.status, 400);
  assertEquals(await malformed.json(), {
    error: "Invalid JSON body",
    in: "json",
    issues: [],
  });

  // A body that is not JSON and says so: 415, not "invalid JSON".
  const form = await post("name=Ada&age=36", "", {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  assertEquals(form.status, 415);
  assertEquals(await form.json(), {
    error:
      'Unsupported content type "application/x-www-form-urlencoded": the body has to be JSON',
    in: "content-type",
    issues: [],
  });

  assertEquals(reached, false);
});

Deno.test("a body declared on DELETE reaches the handler parsed, or is refused", async () => {
  const seen: unknown[] = [];
  const { DELETE } = createApiHandlers({
    DELETE: endpoint({
      body: z.object({ ids: z.array(z.string()).min(1) }),
      response: z.object({ deleted: z.number() }),
      handler: (_request, { body }) => {
        seen.push(body);
        return { deleted: body.ids.length };
      },
    }),
  });
  const send = (body?: unknown) =>
    DELETE(
      new Request("http://x/items", {
        method: "DELETE",
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );

  const deleted = await send({ ids: ["1", "2"] });
  assertEquals(await deleted.json(), { deleted: 2 });
  assertEquals(seen, [{ ids: ["1", "2"] }]);

  // Before, the schema was not read for DELETE and the handler received
  // `undefined` typed as the body.
  assertEquals((await send({ ids: [] })).status, 400);
  const missing = await send();
  assertEquals(missing.status, 400);
  assertEquals((await missing.json()).in, "body");
  assertEquals(seen.length, 1);
});

Deno.test("a body schema that allows no body accepts a request without one", async () => {
  const { DELETE } = createApiHandlers({
    DELETE: endpoint({
      body: z.object({ reason: z.string() }).optional(),
      response: z.object({ reason: z.string() }),
      handler: (_request, { body }) => ({ reason: body?.reason ?? "none" }),
    }),
  });

  const bare = await DELETE(
    new Request("http://x/items/1", { method: "DELETE" }),
  );
  assertEquals(await bare.json(), { reason: "none" });

  const withReason = await DELETE(
    new Request("http://x/items/1", {
      method: "DELETE",
      body: JSON.stringify({ reason: "spam" }),
    }),
  );
  assertEquals(await withReason.json(), { reason: "spam" });
});
