/**
 * One API, two servers, the same tests.
 *
 * The routes of `e2e_tests/fixtures/conformance` are served twice: by their
 * TypeScript handlers, and by FastAPI from the Python module the
 * generator writes for them (`api_generated.py`) with handlers written in
 * Python (`app.py`). `conformance()` registers the tests below against a
 * base URL; they use the TypeScript client generated from the same routes.
 *
 * What is compared across the two is the contract: statuses, bodies,
 * which part of a request failed and where. The wording of a validation
 * message is each validator's own (Zod's, Pydantic's) and is not compared.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ClientError, createClient } from "@/client/index.ts";
import { checkResourceLaws, formatResourceLawsReport } from "@/core/laws.ts";

import { type Api, routes } from "../fixtures/conformance/api.generated.ts";
import { handler as note } from "../fixtures/conformance/routes/api/notes/[id].ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Invalid {
  error: string;
  in: string;
  issues: { path: (string | number)[]; message: string; code: string }[];
}

/**
 * Places where a server is known to answer differently from the
 * TypeScript handlers. Naming one here does not skip its test: the test
 * then asserts the different answer, so the list stays true.
 */
export type Difference =
  /** `\\d` in a pattern matches every Unicode digit. */
  | "unicode-digits"
  /** A number written with a fraction of zero (2.0) is not an integer. */
  | "whole-float-is-not-integer"
  /** `null` is accepted for a field that is optional and not nullable. */
  | "null-for-optional"
  /** A scalar query parameter given twice takes one of the values. */
  | "repeated-query-key"
  /** A JSON body sent as text/plain is refused. */
  | "json-as-text"
  /** A form body is a 400, not a 415. */
  | "form-is-400"
  /**
   * The issues of a refusal (their order, codes and messages) are the
   * validator's own, not Zod's.
   */
  | "issues-in-other-words"
  /**
   * A value that fits no member of a union is reported once per member,
   * the member named in the path, not once at the union.
   */
  | "issue-per-union-member";

/** A request a server has to refuse. */
export interface Refusal {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  /** Content type of the body; JSON when left out. */
  readonly type?: string;
}

const ODD = {
  type: "memo",
  createdAt: "a",
  created_at: "b",
  "2fa": true,
  pair: ["width", 2.5],
  scores: { first: 1 },
  loose: "x",
  looseOrNull: null,
  version: 2,
  anything: 1,
  chain: { name: "a", origin: null },
  json: null,
  expr: 1,
};
const SHAPE = {
  shape: { kind: "circle", radius: 1 },
  from: "x",
  meta: { "data-id": "m" },
  note: null,
};
const post = (path: string, body: unknown): Refusal => ({
  method: "POST",
  path,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/**
 * Requests that are refused, one or several things wrong with each. What
 * the TypeScript handlers answer (status and body) is recorded in
 * `refusals.json`; a server that validates as Zod does answers the same.
 */
export const REFUSALS: readonly Refusal[] = [
  // Several things wrong: every one is reported, in the schema's order.
  post("/api/notes", { title: "", tags: "x", pinned: 1, extra: true }),
  // Nothing there, or not an object.
  post("/api/notes", {}),
  post("/api/notes", []),
  post("/api/notes", "null"),
  post("/api/notes", "{not json"),
  { method: "DELETE", path: "/api/notes/n1" },
  { method: "DELETE", path: "/api/notes/n1", body: '{"reason":""}' },
  { ...post("/api/notes", "a=b"), type: "application/x-www-form-urlencoded" },
  // Text that is not the number it should be; blank text is 0.
  { method: "GET", path: "/api/notes?limit=abc&tag=a" },
  { method: "GET", path: "/api/notes?limit=500" },
  { method: "GET", path: "/api/notes?limit=1.5" },
  { method: "GET", path: "/api/notes?limit=" },
  // Lengths, patterns, formats, numbers, null for a value.
  post("/api/edges", {
    short: "abcde",
    digits: "x",
    count: 1.5,
    step: 0.25,
    flag: null,
    when: "yesterday",
    id: "nope",
    email: "nope",
    maybe: 3,
    plain: "3",
  }),
  post("/api/edges", { count: "1", flag: "true", short: 4 }),
  // An integer JavaScript cannot hold exactly.
  post("/api/edges", '{"count":1152921504606846976}'),
  // A union told apart by a field: a wrong field, a variant without its
  // member, no object, no field, a member out of bounds.
  post("/api/shapes", { ...SHAPE, shape: { kind: "triangle" } }),
  post("/api/shapes", { ...SHAPE, shape: { kind: "circle" } }),
  post("/api/shapes", { ...SHAPE, shape: "circle" }),
  post("/api/shapes", { ...SHAPE, shape: { radius: 2 } }),
  post("/api/shapes", { ...SHAPE, shape: { kind: "circle", radius: -1 } }),
  // A literal, a nullable, a missing member of each kind.
  post("/api/shapes", { ...SHAPE, unit: "km", note: 3, meta: {} }),
  post("/api/shapes", { from: "x" }),
  // Tuples, records, unions without a field, constants.
  post("/api/odd", {
    ...ODD,
    version: 3,
    pair: ["a", 1, 2],
    loose: true,
    looseOrNull: true,
  }),
  post("/api/odd", {
    ...ODD,
    pair: ["a"],
    scores: { a: 1.5, b: "x" },
    expr: { op: "neg", of: "two" },
  }),
  // Deep inside a type that refers to itself.
  post("/api/odd", {
    ...ODD,
    chain: { name: "a", origin: null, next: { name: 1 } },
  }),
  post("/api/odd", {}),
  post("/api/trees", { name: "r", children: [{ name: "c" }, 3] }),
];

/** What a server answers to a request it refuses. */
export interface RefusalAnswer {
  readonly request: string;
  readonly status: number;
  readonly body: unknown;
}

/** Send every request of `REFUSALS`; what came back. */
export async function refusals(baseUrl: string): Promise<RefusalAnswer[]> {
  const answers: RefusalAnswer[] = [];
  for (const { method, path, body, type } of REFUSALS) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body !== undefined && {
        body,
        headers: { "Content-Type": type ?? "application/json" },
      }),
    });
    answers.push({
      request: `${method} ${path}${body === undefined ? "" : ` ${body}`}`,
      status: response.status,
      body: await response.json(),
    });
  }
  return answers;
}

/** Where the answers of the TypeScript handlers are recorded. */
export const RECORDED_REFUSALS = new URL("./refusals.json", import.meta.url);

/** What a server under test does not implement, with the reason. */
export interface ConformanceOptions {
  /** The known differences of the server, each with its reason. */
  readonly differences?: Partial<Record<Difference, string>>;
  /**
   * Set when the generator for the server's language does not generate
   * event streams yet: the three stream tests are not registered. The
   * reason is printed, so a run says what it left out.
   */
  readonly withoutEventStreams?: string;
}

/**
 * Register the conformance tests against the server at `baseUrl()`.
 *
 * @param label Names the server in the test names.
 * @param baseUrl Where the server listens; read when a test runs.
 * @param options What the server does not implement.
 */
export function conformance(
  label: string,
  baseUrl: () => string,
  options: ConformanceOptions = {},
): void {
  const client = () => createClient<Api>({ baseUrl: baseUrl(), routes });
  const send = (method: string, path: string, body?: string, type?: string) =>
    fetch(`${baseUrl()}${path}`, {
      method,
      ...(body !== undefined && {
        body,
        headers: { "Content-Type": type ?? "application/json" },
      }),
    });
  const test = (name: string, fn: () => Promise<void>) =>
    Deno.test(`${label}: ${name}`, fn);

  const differs = (difference: Difference) =>
    options.differences?.[difference] !== undefined;
  for (const [name, reason] of Object.entries(options.differences ?? {})) {
    console.log(`${label}: known difference "${name}": ${reason}`);
  }

  test("create, retrieve and replace a note", async () => {
    const api = client();
    const created = await api.notes.create({
      title: `first of ${label}`,
      tags: ["a", "b"],
    });
    assertType<
      Equal<
        typeof created,
        {
          title: string;
          tags: string[];
          pinned?: boolean;
          id: string;
          likes: number;
        }
      >
    >();
    assertEquals(created.title, `first of ${label}`);
    assertEquals(created.likes, 0);
    // A field that was not sent is absent from the answer, not null.
    assertEquals("pinned" in created, false);

    assertEquals(await api.notes.retrieve(created.id), created);

    const replaced = await api.notes.update(created.id, {
      title: "renamed",
      tags: [],
      pinned: true,
    });
    assertEquals(replaced, {
      id: created.id,
      likes: 0,
      title: "renamed",
      tags: [],
      pinned: true,
    });
    assertEquals(await api.notes.retrieve(created.id), replaced);
  });

  test("declared errors come back as values, typed by status", async () => {
    const api = client();

    const missing = await api.notes.retrieve.result("no-such-note");
    assertEquals(missing, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: "no-such-note" },
    });

    await api.notes.create({ title: `taken on ${label}`, tags: [] });
    const again = await api.notes.create.result({
      title: `taken on ${label}`,
      tags: [],
    });
    assertEquals(again, {
      ok: false,
      status: 409,
      error: { error: "conflict", title: `taken on ${label}` },
    });

    // The throwing call throws for the same answer.
    const error = await assertRejects(
      () => api.notes.retrieve("no-such-note"),
      ClientError,
    );
    assertEquals(error.status, 404);
  });

  test("a list is paginated by cursor and filtered by tag", async () => {
    const api = client();
    const tag = `listed-${label}`;
    for (const id of ["l1", "l2", "l3", "l4", "l5"]) {
      await api.notes.update(`${label}-${id}`, {
        title: id,
        tags: id === "l3" ? [tag, "odd"] : [tag],
      });
    }

    // Pages of two, followed by cursor until the server gives none.
    const pages: string[][] = [];
    for await (const page of api.notes.list.pages({ query: { tag: [tag] } })) {
      pages.push(page.items.map((item) => item.title));
    }
    assertEquals(pages, [["l1", "l2"], ["l3", "l4"], ["l5"]]);

    const titles: string[] = [];
    for await (
      const item of api.notes.list.items({ query: { tag: [tag], limit: 4 } })
    ) {
      titles.push(item.title);
    }
    assertEquals(titles, ["l1", "l2", "l3", "l4", "l5"]);

    // Every given tag has to be on the note.
    const odd = await api.notes.list({ query: { tag: [tag, "odd"] } });
    assertEquals(odd.items.map((item) => item.title), ["l3"]);
    // The last page has no cursor: the member is absent.
    assertEquals("cursor" in odd, false);
  });

  test("a request that fails validation is a 400 that names the part and the place", async () => {
    const invalid = async (response: Response) => {
      assertEquals(response.status, 400);
      const body = await response.json() as Invalid;
      assertEquals(typeof body.error, "string");
      return {
        in: body.in,
        paths: body.issues.map((issue) => issue.path.join(".")).sort(),
      };
    };

    // A body with two wrong fields and one missing.
    assertEquals(
      await invalid(
        await send(
          "PUT",
          "/api/notes/v1",
          JSON.stringify({ title: "", tags: ["a", 2] }),
        ),
      ),
      { in: "body", paths: ["tags.1", "title"] },
    );
    assertEquals(
      await invalid(await send("PUT", "/api/notes/v1", JSON.stringify({}))),
      { in: "body", paths: ["tags", "title"] },
    );

    // Types are not coerced in a body: "5" is not a boolean, 5 not a string.
    assertEquals(
      await invalid(
        await send(
          "PUT",
          "/api/notes/v1",
          JSON.stringify({ title: 5, tags: [], pinned: "true" }),
        ),
      ),
      { in: "body", paths: ["pinned", "title"] },
    );

    // A query parameter out of range; in a query, text becomes a number.
    assertEquals(await invalid(await send("GET", "/api/notes?limit=0")), {
      in: "query",
      paths: ["limit"],
    });
    assertEquals((await send("GET", "/api/notes?limit=3")).status, 200);

    // Malformed JSON.
    const malformed = await send("PUT", "/api/notes/v1", "{title:");
    assertEquals(malformed.status, 400);
    assertEquals(await malformed.json(), {
      error: "Invalid JSON body",
      in: "json",
      issues: [],
    });

    // Nothing was stored by any of them.
    assertEquals((await send("GET", "/api/notes/v1")).status, 404);
  });

  test("a DELETE carries a body, which is validated", async () => {
    const api = client();
    await api.notes.update(`${label}-d1`, { title: "to delete", tags: [] });

    const short = await assertRejects(
      () => api.notes.delete(`${label}-d1`, { reason: "no" }),
      ClientError,
    );
    assertEquals(short.status, 400);
    assertEquals((short.body as Invalid).in, "body");

    assertEquals(
      await api.notes.delete(`${label}-d1`, { reason: "obsolete" }),
      { deleted: true, reason: "obsolete" },
    );
    const gone = await api.notes.delete.result(`${label}-d1`, {
      reason: "obsolete",
    });
    assertEquals(gone, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: `${label}-d1` },
    });
  });

  test("a catch-all parameter keeps its slashes", async () => {
    const api = client();
    assertEquals(await api.echo.retrieve("docs/guide/intro.md"), {
      path: "docs/guide/intro.md",
      segments: ["docs", "guide", "intro.md"],
    });
  });

  test("unions, defaults, nulls and names Python cannot spell cross unchanged", async () => {
    const api = client();
    const circle = await api.shapes.create({
      shape: { kind: "circle", radius: 2 },
      from: "sketch",
      meta: { "data-id": "m1" },
      note: null,
    });
    assertEquals(circle, {
      area: 12,
      kind: "circle",
      from: "sketch",
      meta: { "data-id": "m1" },
      // The default of a field that was left out.
      unit: "mm",
      // Null where the schema allows null.
      note: null,
    });

    const rect = await api.shapes.create({
      shape: { kind: "rect", width: 2, height: 2.5 },
      from: "plan",
      meta: { "data-id": "m2", class: "wide" },
      unit: "cm",
      note: "checked",
    });
    assertEquals(rect, {
      area: 5,
      kind: "rect",
      from: "plan",
      meta: { "data-id": "m2", class: "wide" },
      unit: "cm",
      note: "checked",
    });

    // A member of the union that is neither variant, and a variant
    // without its field.
    for (
      const shape of [{ kind: "triangle", side: 1 }, { kind: "circle" }]
    ) {
      const response = await send(
        "POST",
        "/api/shapes",
        JSON.stringify({
          shape,
          from: "x",
          meta: { "data-id": "m" },
          note: null,
        }),
      );
      assertEquals(response.status, 400);
      const body = await response.json() as Invalid;
      assertEquals(body.in, "body");
      assert(
        body.issues.every((issue) => issue.path[0] === "shape"),
        JSON.stringify(body.issues),
      );
    }
  });

  test("a schema that refers to itself", async () => {
    const api = client();
    const leaf = (name: string) => ({ name, children: [] });
    const root = {
      name: "root",
      children: [leaf("a"), { name: "b", children: [leaf("c")] }],
    };
    assertEquals(await api.trees.create(root), { depth: 3, root });

    // Checked at every level.
    const response = await send(
      "POST",
      "/api/trees",
      JSON.stringify({
        name: "root",
        children: [{ name: "b", children: [{ name: 7, children: [] }] }],
      }),
    );
    assertEquals(response.status, 400);
    const body = await response.json() as Invalid;
    assertEquals(body.issues.map((issue) => issue.path), [
      ["children", 0, "children", 0, "name"],
    ]);
  });

  test("shapes another language has to find a way to say", async () => {
    const api = client();
    const odd = {
      type: "memo",
      createdAt: "2026-11-14",
      created_at: "2026-11-13",
      "2fa": true,
      pair: ["width", 2.5] as [string, number],
      scores: { first: 1, second: 2 },
      loose: ["a", "b"] as string | number | string[],
      looseOrNull: null as string | number | null,
      version: 2 as const,
      anything: { nested: [1, "two", null] } as unknown,
      chain: {
        name: "a",
        origin: null,
        next: { name: "b", origin: { name: "c", origin: null } },
      },
      json: { list: [1, "two", null, { deep: [true] }] } as Json,
      expr: {
        op: "add" as const,
        args: [1, { op: "neg" as const, of: 2 }],
      },
    };
    // The default arrives; nothing else is added and nothing is lost.
    assertEquals(await api.odd.create(odd), { ...odd, limit: null });

    // Every member of a union without a field to tell them apart.
    for (const loose of ["text", 4.5, 3]) {
      const answer = await api.odd.create({
        ...odd,
        loose,
        looseOrNull: loose,
        anything: loose,
        limit: 7,
      });
      assertEquals(
        [answer.loose, answer.looseOrNull, answer.anything, answer.limit],
        [loose, loose, loose, 7],
      );
    }

    // A null that is there is a value; a field that is not there is not.
    const withNull = await api.odd.create({ ...odd, jsonIfAny: null });
    assertEquals("jsonIfAny" in withNull && withNull.jsonIfAny, null);
    assertEquals("jsonIfAny" in await api.odd.create(odd), false);

    // What the types of a language may not say is still refused.
    const refusals: [Record<string, unknown>, (string | number)[]][] = [
      [{ expr: { op: "neg", of: "two" } }, ["expr"]],
      [{ version: 3 }, ["version"]],
      [{ pair: ["width", "wide"] }, ["pair", 1]],
      [{ scores: { first: 1.5 } }, ["scores", "first"]],
      [{ loose: true }, ["loose"]],
      [{ created_at: 1 }, ["created_at"]],
      [{ "2fa": "yes" }, ["2fa"]],
      [
        { chain: { name: "a", origin: null, next: { name: "b" } } },
        ["chain", "next", "origin"],
      ],
    ];
    for (const [change, path] of refusals) {
      const response = await send(
        "POST",
        "/api/odd",
        JSON.stringify({ ...odd, ...change }),
      );
      assertEquals(response.status, 400, JSON.stringify(change));
      const body = await response.json() as Invalid;
      const paths = body.issues.map((issue) => issue.path);
      const union = "loose" in change || "expr" in change;
      if (union && differs("issue-per-union-member")) {
        // An issue for each member, under the union.
        assert(paths.length > 1, JSON.stringify(paths));
        assert(
          paths.every((at) => at.length > 1 && at[0] === path[0]),
          JSON.stringify(paths),
        );
      } else {
        assertEquals(paths, [path], JSON.stringify(body.issues));
      }
    }
  });

  test("a refusal says what the TypeScript handlers say, word for word", async () => {
    const recorded = JSON.parse(
      await Deno.readTextFile(RECORDED_REFUSALS),
    ) as RefusalAnswer[];
    const answers = await refusals(baseUrl());
    assertEquals(answers.length, recorded.length);

    if (!differs("issues-in-other-words")) {
      for (const [i, answer] of answers.entries()) {
        assertEquals(answer, recorded[i], answer.request);
      }
      return;
    }
    // Refused all the same, and not in the same words.
    for (const answer of answers) {
      assert(
        answer.status >= 400 && answer.status < 500,
        `${answer.request}: ${answer.status}`,
      );
    }
    const same = answers.filter((answer, i) =>
      JSON.stringify(answer) === JSON.stringify(recorded[i])
    );
    assert(same.length < answers.length, "every answer is the recorded one");
  });

  /** POST one field to /api/edges; the status, and what came back. */
  const edge = async (body: unknown, type?: string) => {
    const response = await send(
      "POST",
      "/api/edges",
      typeof body === "string" ? body : JSON.stringify(body),
      type,
    );
    const answer = await response.json() as
      & Invalid
      & { received?: string[]; maybe?: string | null; count?: number };
    return {
      status: response.status,
      answer,
      paths: (answer.issues ?? []).map((issue) => issue.path.join(".")),
    };
  };
  const accepted = async (body: unknown) =>
    assertEquals((await edge(body)).status, 200, JSON.stringify(body));
  const refused = async (body: unknown, path: string) => {
    const result = await edge(body);
    assertEquals(result.status, 400, JSON.stringify(body));
    assertEquals(result.answer.in, "body");
    assertEquals(result.paths, [path], JSON.stringify(body));
  };

  test("edge: a string's length is counted in code points", async () => {
    // Measured, not assumed: Zod counts code points, as JSON Schema does.
    // An emoji is one code point and two UTF-16 code units, so four of
    // them have the JavaScript `length` 8 and fit `max(4)`.
    const emoji = (count: number) => "\u{1F600}".repeat(count);
    await accepted({ short: "abcd" });
    await accepted({ short: emoji(4) });
    await refused({ short: "abcde" }, "short");
    await refused({ short: emoji(5) }, "short");
    // A letter and a combining accent are two code points.
    await accepted({ short: "e\u0301e\u0301" });
    await refused({ short: "e\u0301e\u0301e\u0301" }, "short");
  });

  test("edge: a pattern is a JavaScript pattern", async () => {
    await accepted({ digits: "2026" });
    await refused({ digits: "20x6" }, "digits");
    // An Arabic-Indic digit is not 0-9.
    if (differs("unicode-digits")) {
      await accepted({ digits: "\u0663" });
    } else {
      await refused({ digits: "\u0663" }, "digits");
    }
    // So it is in the complement, also when that is written in a class.
    await refused({ plain: "a3" }, "plain");
    if (differs("unicode-digits")) {
      await refused({ plain: "\u0663" }, "plain");
    } else {
      await accepted({ plain: "\u0663" });
    }

    // A lookahead: any word that does not begin with "admin".
    await accepted({ word: "ada" });
    await refused({ word: "administrator" }, "word");
  });

  test("edge: numbers are JavaScript numbers", async () => {
    // 2.0 is an integer; the handler sees 2.
    const whole = await edge(JSON.parse('{"count": 2}'));
    assertEquals(whole.answer.count, 2);
    const written = await send("POST", "/api/edges", '{"count": 2.0}');
    if (differs("whole-float-is-not-integer")) {
      assertEquals(written.status, 400);
      await written.body?.cancel();
    } else {
      assertEquals(written.status, 200);
      assertEquals((await written.json()).count, 2);
    }
    await refused({ count: 2.5 }, "count");

    // A multiple of 0.1, whatever binary floating point makes of it.
    await accepted({ step: 0.3 });
    await accepted({ step: 1.1 });
    await accepted({ step: 0.5 });
    await refused({ step: 0.35 }, "step");
  });

  test("edge: absent, null and a value are three things", async () => {
    const absent = await edge({});
    assertEquals(absent.answer.received, []);
    assertEquals("maybe" in absent.answer, false);

    const nothing = await edge({ maybe: null });
    assertEquals(nothing.answer.received, ["maybe"]);
    assertEquals(nothing.answer.maybe, null);

    const something = await edge({ maybe: "x" });
    assertEquals(something.answer.received, ["maybe"]);
    assertEquals(something.answer.maybe, "x");

    // Optional is not nullable.
    if (differs("null-for-optional")) {
      await accepted({ flag: null });
    } else {
      await refused({ flag: null }, "flag");
    }
    // A member the schema does not name is dropped, not refused.
    const extra = await edge({ flag: true, extra: 1 });
    assertEquals(extra.status, 200);
    assertEquals(extra.answer.received, ["flag"]);
  });

  test("edge: string formats", async () => {
    await accepted({ when: "2026-01-01T12:30:00Z" });
    await accepted({ when: "2026-01-01T12:30:00.123Z" });
    await refused({ when: "2026-01-01" }, "when");
    await refused({ when: "2026-01-01 12:30:00" }, "when");

    await accepted({ id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });
    await refused({ id: "f47ac10b58cc4372a5670e02b2c3d479" }, "id");

    await accepted({ email: "ada@example.test" });
    await refused({ email: "ada@" }, "email");
  });

  test("edge: a scalar query parameter given twice", async () => {
    const response = await send("GET", "/api/notes?limit=1&limit=2");
    if (differs("repeated-query-key")) {
      assertEquals(response.status, 200);
      await response.body?.cancel();
    } else {
      assertEquals(response.status, 400);
      const body = await response.json() as Invalid;
      assertEquals(body.in, "query");
      assertEquals(body.issues.map((issue) => issue.path), [["limit"]]);
    }
  });

  test("edge: what counts as a JSON body", async () => {
    // JSON under text/plain: what fetch() sends for a string body when no
    // header is set.
    const plain = await edge('{"flag": true}', "text/plain;charset=UTF-8");
    assertEquals(plain.status, differs("json-as-text") ? 400 : 200);

    // A form body is not JSON and says so.
    const form = await send(
      "POST",
      "/api/edges",
      "flag=true",
      "application/x-www-form-urlencoded",
    );
    assertEquals(form.status, differs("form-is-400") ? 400 : 415);
    await form.body?.cancel();

    // No body at all: a missing value, reported at the root.
    const empty = await fetch(`${baseUrl()}/api/edges`, { method: "POST" });
    assertEquals(empty.status, 400);
    const body = await empty.json() as Invalid;
    assertEquals(body.in, "body");
    assertEquals(body.issues.map((issue) => issue.path), [[]]);
  });

  if (options.withoutEventStreams !== undefined) {
    console.log(
      `${label}: event stream tests not run: ${options.withoutEventStreams}`,
    );
  } else {
    eventStreams();
  }

  function eventStreams(): void {
    test("an event stream: typed events, in order, in the same frames", async () => {
      const api = client();
      const seen: unknown[] = [];
      for await (const event of api.ticks.subscribe({ query: { count: 2 } })) {
        seen.push([event.event, event.data, event.id]);
        if (event.event === "tick") {
          assertType<Equal<typeof event.data, { n: number }>>();
        }
      }
      assertEquals(seen, [
        ["tick", { n: 0 }, "0"],
        ["tick", { n: 1 }, "1"],
        ["done", { total: 2 }, undefined],
      ]);

      // Byte for byte what is on the wire.
      const response = await send("GET", "/api/ticks?count=2");
      assertEquals(response.status, 200);
      assertEquals(
        response.headers.get("content-type")?.split(";")[0],
        "text/event-stream",
      );
      assertEquals(
        await response.text(),
        'event: tick\nid: 0\ndata: {"n":0}\n\n' +
          'event: tick\nid: 1\ndata: {"n":1}\n\n' +
          'event: done\ndata: {"total":2}\n\n',
      );

      // The query is validated before the stream begins.
      const invalid = await send("GET", "/api/ticks?count=-1");
      assertEquals(invalid.status, 400);
      assertEquals((await invalid.json() as Invalid).in, "query");
    });

    test("an event stream that fails says so, and the client resumes after the event it has", async () => {
      const api = client();
      const seen: number[] = [];
      for await (
        const event of api.ticks.subscribe({
          query: { count: 4, failAt: 2 },
          reconnectDelay: 5,
        })
      ) {
        if (event.event === "tick") seen.push(event.data.n);
      }
      // The first connection failed before tick 2; the second was asked
      // for with Last-Event-ID: 1 and continued from there.
      assertEquals(seen, [0, 1, 2, 3]);

      // On the wire: the events before the failure, then the comment.
      const failed = await send("GET", "/api/ticks?count=4&failAt=1");
      assertEquals(
        await failed.text(),
        'event: tick\nid: 0\ndata: {"n":0}\n\n: error\n\n',
      );

      // An event its schema rejects is a failure too, and is never sent.
      const bad = await send("GET", "/api/ticks?count=4&badAt=1");
      assertEquals(
        await bad.text(),
        'event: tick\nid: 0\ndata: {"n":0}\n\n: error\n\n',
      );
    });

    test("an event stream that is silent is kept alive with comments", async () => {
      const response = await send("GET", "/api/ticks?count=1&pause=150");
      const text = await response.text();
      const comments = text.split(": keep-alive\n\n").length - 1;
      assert(comments >= 1, `no keep-alive comment in ${JSON.stringify(text)}`);
      assertEquals(
        text.replaceAll(": keep-alive\n\n", ""),
        'event: tick\nid: 0\ndata: {"n":0}\n\nevent: done\ndata: {"total":1}\n\n',
      );
    });
  }

  test("the note is a lawful resource", async () => {
    const url = `${baseUrl()}/api/notes/${label}-lawful`;
    const created = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "lawful", tags: ["x"] }),
    });
    assertEquals(created.status, 200);
    await created.body?.cancel();

    // Generated bodies, GET and PUT: the four lens laws hold.
    const report = await checkResourceLaws(note, { url, runs: 10 });
    assertEquals(report.ok, true, formatResourceLawsReport(report));
  });
}
