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
