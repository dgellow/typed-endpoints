import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  createApiHandlers,
  createRouter,
  endpoint,
} from "@/integrations/fetch.ts";
import {
  checkResourceLaws,
  formatResourceLawsReport,
  type LawResult,
  type ResourceLaw,
  type ResourceLawsReport,
} from "./laws.ts";

// =============================================================================
// A resource, and the ways its PUT can be wrong
// =============================================================================

const Body = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).max(3),
  pinned: z.boolean().optional(),
});
type Body = z.output<typeof Body>;

/** The view: the body, and what the server alone decides. */
const Note = Body.extend({
  id: z.string(),
  likes: z.number(),
  revision: z.number(),
  reads: z.number(),
});
type Note = z.output<typeof Note>;

const URL_OF_NOTE = "http://test.local/notes/1";

/** PUT replaces what the body speaks about and keeps the rest. */
const replace = (note: Note, body: Body): Note => ({
  id: note.id,
  likes: note.likes,
  revision: note.revision,
  reads: note.reads,
  ...body,
});

function resource(
  put: (note: Note, body: Body) => Note | Response = replace,
  read: (note: Note) => Note = (note) => note,
) {
  let note: Note = {
    id: "1",
    title: "First",
    tags: ["a"],
    likes: 3,
    revision: 0,
    reads: 0,
  };
  const handler = createApiHandlers({
    GET: endpoint({
      response: Note,
      handler: () => (note = read(note)),
    }),
    PUT: endpoint({
      body: Body,
      response: Note,
      handler: (_request, { body }) => {
        const next = put(note, body);
        return next instanceof Response ? next : (note = next);
      },
    }),
  });
  return { handler, send: createRouter({ "/notes/1": handler }) };
}

function check(
  put?: (note: Note, body: Body) => Note | Response,
  options: {
    read?: (note: Note) => Note;
    laws?: readonly ResourceLaw[];
    ignore?: readonly string[];
  } = {},
): Promise<ResourceLawsReport> {
  const { handler, send } = resource(put, options.read);
  return checkResourceLaws(handler, {
    url: URL_OF_NOTE,
    send,
    ...(options.laws && { laws: options.laws }),
    ...(options.ignore && { ignore: options.ignore }),
  });
}

function law(report: ResourceLawsReport, name: ResourceLaw): LawResult {
  const result = report.laws[name];
  assert(result, `${name} was not checked`);
  return result;
}

/** The laws that did not hold in every run. */
function broken(report: ResourceLawsReport): ResourceLaw[] {
  return (Object.keys(report.laws) as ResourceLaw[]).filter((name) =>
    law(report, name).held !== report.runs
  );
}

/** Every path at which a law's violations differ. */
function paths(report: ResourceLawsReport, name: ResourceLaw): string[] {
  const all = law(report, name).violations.flatMap((violation) =>
    violation.differences.map((difference) => difference.path)
  );
  return [...new Set(all.map((path) => path.split(".")[0]))].sort();
}

// =============================================================================
// The laws
// =============================================================================

Deno.test("laws: a resource that replaces on PUT obeys all four", async () => {
  const report = await check();

  assertEquals(report.ok, true, formatResourceLawsReport(report));
  assertEquals(Object.keys(report.laws), [
    "get-get",
    "get-put",
    "put-get",
    "put-put",
  ]);
  for (const name of Object.keys(report.laws) as ResourceLaw[]) {
    assertEquals(law(report, name), {
      held: 20,
      violations: [],
      refusals: [],
      skips: [],
    });
  }
});

Deno.test("laws: a PUT that drops a field fails put-get, and only it", async () => {
  // `tags` and `pinned` of the body are not stored.
  const report = await check((note, body) => ({ ...note, title: body.title }));

  assertEquals(report.ok, false);
  assertEquals(broken(report), ["put-get"]);
  assertEquals(paths(report, "put-get"), ["pinned", "tags"]);

  // The first violation says what was put and what was read.
  const [violation] = law(report, "put-get").violations;
  assertEquals(violation.exchanges.map((e) => e.method), ["PUT", "GET"]);
  const put = violation.exchanges[0].body as Body;
  for (const difference of violation.differences) {
    const key = difference.path.split(".")[0] as keyof Body;
    assert(key in put, `${key} is a field of the body that was put`);
  }
});

Deno.test("laws: a PUT that merges fails put-put, and only it", async () => {
  // A field the body leaves out keeps its earlier value: this is PATCH.
  const report = await check((note, body) => ({ ...note, ...body }));

  assertEquals(broken(report), ["put-put"]);
  assertEquals(paths(report, "put-put"), ["pinned"]);

  const [violation] = law(report, "put-put").violations;
  assertEquals(
    violation.exchanges.map((e) => e.method),
    ["PUT", "GET", "PUT", "PUT", "GET"],
  );
  // The first and the last PUT carry the same body.
  assertEquals(violation.exchanges[0].body, violation.exchanges[3].body);
});

Deno.test("laws: a PUT that is not idempotent fails every law that puts", async () => {
  // Every PUT appends its tags to the ones that are there.
  const report = await check((note, body) => ({
    ...replace(note, body),
    tags: [...note.tags, ...body.tags].slice(-3),
  }));

  assertEquals(broken(report), ["get-put", "put-get", "put-put"]);
  for (const name of ["get-put", "put-get", "put-put"] as const) {
    assertEquals(paths(report, name), ["tags"]);
  }
});

Deno.test("laws: a PUT that resets what the body does not speak about fails get-put", async () => {
  // `likes` is not in the body; PUT sets it to 0.
  const report = await check(
    (note, body) => ({ ...replace(note, body), likes: 0 }),
  );

  // Seen once, on the state the check found: afterwards `likes` is 0 and
  // putting the view back changes nothing any more.
  assertEquals(broken(report), ["get-put"]);
  const result = law(report, "get-put");
  assertEquals(result.held, 19);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].run, 0);
  assertEquals(result.violations[0].differences, [
    { path: "likes", expected: 3, actual: 0 },
  ]);
});

Deno.test("laws: a view that changes when it is read fails get-get", async () => {
  const counting = (note: Note) => ({ ...note, reads: note.reads + 1 });

  const report = await check(undefined, { read: counting });
  // Every law but put-get compares two views, so every one of them fails.
  assertEquals(broken(report), ["get-get", "get-put", "put-put"]);
  assertEquals(paths(report, "get-get"), ["reads"]);

  // Named in `ignore`, the counter is not compared.
  const ignoring = await check(undefined, {
    read: counting,
    ignore: ["reads"],
  });
  assertEquals(ignoring.ok, true, formatResourceLawsReport(ignoring));
});

Deno.test("laws: a revision counter is a violation until it is ignored", async () => {
  const counting = (note: Note, body: Body) => ({
    ...replace(note, body),
    revision: note.revision + 1,
  });

  const report = await check(counting);
  assertEquals(broken(report), ["get-put", "put-put"]);
  assertEquals(paths(report, "get-put"), ["revision"]);
  assertEquals(paths(report, "put-put"), ["revision"]);

  const ignoring = await check(counting, { ignore: ["revision"] });
  assertEquals(ignoring.ok, true, formatResourceLawsReport(ignoring));
});

Deno.test("laws: `laws` selects what is checked", async () => {
  const report = await check(undefined, { laws: ["put-put", "get-get"] });
  assertEquals(Object.keys(report.laws), ["get-get", "put-put"]);
  assertEquals(report.ok, true);
});

// =============================================================================
// Bodies
// =============================================================================

Deno.test("laws: the same seed sends the same requests", async () => {
  const merging = (note: Note, body: Body) => ({ ...note, ...body });
  const run = async (seed: number) => {
    const { handler, send } = resource(merging);
    return await checkResourceLaws(handler, { url: URL_OF_NOTE, send, seed });
  };

  assertEquals(await run(7), await run(7));
  const bodies = (report: ResourceLawsReport) =>
    JSON.stringify(law(report, "put-put").violations[0]?.exchanges);
  assert(bodies(await run(7)) !== bodies(await run(8)));
});

Deno.test("laws: `value` supplies the bodies", async () => {
  const { handler, send } = resource();
  const seen: unknown[] = [];
  const report = await checkResourceLaws(handler, {
    url: URL_OF_NOTE,
    runs: 3,
    laws: ["put-get"],
    value: (random) => ({
      title: `note ${Math.floor(random() * 1000)}`,
      tags: [],
    }),
    send: async (request) => {
      if (request.method === "PUT") seen.push(await request.clone().json());
      return send(request);
    },
  });

  assertEquals(report.ok, true);
  assertEquals(seen.length, 3);
  for (const body of seen) {
    assert(/^note \d+$/.test((body as Body).title));
  }
});

Deno.test("laws: what is expected back is the body as the schema parses it", async () => {
  // The schema upper-cases the code and fills in a default: the server
  // keeps the parsed value, and that is what the view has to contain.
  const Code = z.object({
    code: z.string().min(1).transform((code) => code.toUpperCase()),
    label: z.string().default("none"),
  });
  let state: z.output<typeof Code> = { code: "A", label: "none" };
  const handler = createApiHandlers({
    GET: endpoint({ response: Code, handler: () => state }),
    PUT: endpoint({
      body: Code,
      response: Code,
      handler: (_request, { body }) => (state = body),
    }),
  });

  const report = await checkResourceLaws(handler, {
    url: "http://test.local/code",
    send: createRouter({ "/code": handler }),
  });
  assertEquals(report.ok, true, formatResourceLawsReport(report));
});

Deno.test("laws: get-put sends the view without the members a strict body rejects", async () => {
  const Strict = z.strictObject({ title: z.string() });
  let state = { id: "1", title: "First" };
  const handler = createApiHandlers({
    GET: endpoint({ handler: () => Response.json(state) }),
    PUT: endpoint({
      body: Strict,
      handler: (_request, { body }) => {
        state = { ...state, ...body };
        return Response.json(state);
      },
    }),
  });

  const report = await checkResourceLaws(handler, {
    url: "http://test.local/strict",
    send: createRouter({ "/strict": handler }),
    laws: ["get-put"],
  });
  assertEquals(report.ok, true, formatResourceLawsReport(report));
});

// =============================================================================
// What is not a violation
// =============================================================================

Deno.test("laws: a view that is not a body leaves get-put unstated", async () => {
  // The view shows the author as an object; the body takes an id.
  let authorId = "u1";
  const handler = createApiHandlers({
    GET: endpoint({
      handler: () =>
        Response.json({ author: { id: authorId, name: `user ${authorId}` } }),
    }),
    PUT: endpoint({
      body: z.object({ author: z.string() }),
      handler: (_request, { body }) => {
        authorId = body.author;
        return new Response(null, { status: 204 });
      },
    }),
  });

  const report = await checkResourceLaws(handler, {
    url: "http://test.local/post",
    send: createRouter({ "/post": handler }),
    runs: 2,
    laws: ["get-put"],
  });

  assertEquals(report.ok, false);
  const result = law(report, "get-put");
  assertEquals(result.violations, []);
  assertEquals(result.skips.length, 2);
  assert(
    result.skips[0].reason.startsWith("the view is not a PUT body (author: "),
    result.skips[0].reason,
  );
});

Deno.test("laws: a request the server refuses is reported, not compared", async () => {
  // The body schema does not say that the title is unique.
  const report = await check((note, body) => {
    return body.title === note.title
      ? replace(note, body)
      : Response.json({ error: "title is taken" }, { status: 409 });
  }, { laws: ["get-put", "put-get"] });

  assertEquals(report.ok, false);
  // Putting the view back does not change the title.
  assertEquals(law(report, "get-put").held, 20);

  const result = law(report, "put-get");
  assertEquals(result.violations, []);
  assertEquals(result.refusals.length, 20);
  const exchanges = result.refusals[0].exchanges;
  assertEquals(exchanges.length, 1);
  assertEquals(exchanges[0].method, "PUT");
  assertEquals(exchanges[0].status, 409);
  assertEquals(exchanges[0].response, { error: "title is taken" });
});

// =============================================================================
// PATCH
// =============================================================================

function patched() {
  const Patch = Body.partial();
  let note = { id: "1", title: "First", tags: ["a"] as string[], likes: 3 };
  const handler = createApiHandlers({
    GET: endpoint({ handler: () => Response.json(note) }),
    PATCH: endpoint({
      body: Patch,
      handler: (_request, { body }) => {
        note = { ...note, ...body };
        return Response.json(note);
      },
    }),
  });
  return { handler, send: createRouter({ "/notes/1": handler }) };
}

Deno.test("laws: a PATCH that merges obeys the laws checked for PATCH", async () => {
  const { handler, send } = patched();
  const report = await checkResourceLaws(handler, {
    url: URL_OF_NOTE,
    send,
    method: "PATCH",
  });

  assertEquals(report.method, "PATCH");
  assertEquals(Object.keys(report.laws), ["get-get", "get-put", "put-get"]);
  assertEquals(report.ok, true, formatResourceLawsReport(report));
});

Deno.test("laws: put-put does not hold for a partial update", async () => {
  // The reason it is left out for PATCH: a field of the update in between
  // that the last update does not mention remains.
  const { handler, send } = patched();
  const report = await checkResourceLaws(handler, {
    url: URL_OF_NOTE,
    send,
    method: "PATCH",
    laws: ["put-put"],
  });

  assertEquals(report.ok, false);
  assert(law(report, "put-put").violations.length > 0);
});

// =============================================================================
// What is a resource
// =============================================================================

Deno.test("laws: a route without GET, or without a body to update with, is rejected", async () => {
  const body = z.object({ title: z.string() });
  const send = () => new Response("{}");
  const url = URL_OF_NOTE;

  const noGet = createApiHandlers({
    PUT: endpoint({ body, handler: () => Response.json({}) }),
  });
  const noBody = createApiHandlers({
    GET: endpoint({ handler: () => Response.json({}) }),
    PUT: endpoint({ handler: () => Response.json({}) }),
  });
  const getAndPut = createApiHandlers({
    GET: endpoint({ handler: () => Response.json({}) }),
    PUT: endpoint({ body, handler: () => Response.json({}) }),
  });

  await assertRejects(
    // @ts-expect-error the route does not define GET
    () => checkResourceLaws(noGet, { url, send }),
    Error,
    "does not define GET",
  );
  await assertRejects(
    // @ts-expect-error PUT has no body schema
    () => checkResourceLaws(noBody, { url, send }),
    Error,
    "does not define PUT with a body schema",
  );
  await assertRejects(
    // @ts-expect-error the route defines PUT, not PATCH
    () => checkResourceLaws(getAndPut, { url, send, method: "PATCH" }),
    Error,
    "does not define PATCH with a body schema",
  );

  // The method definitions are accepted as well as the handlers.
  const report = await checkResourceLaws(
    { GET: {}, PUT: { body } },
    {
      url,
      send: () => Response.json({ title: "x" }),
      runs: 1,
      laws: ["get-get"],
    },
  );
  assertEquals(report.ok, true);
});

// =============================================================================
// Comparison and report
// =============================================================================

Deno.test("laws: lists are compared by position and length; `*` ignores every member", async () => {
  let reads = 0;
  const handler = createApiHandlers({
    GET: endpoint({
      handler: () => {
        reads++;
        return Response.json({
          items: [
            { name: "a", etag: `e${reads}` },
            ...(reads % 2 === 0 ? [{ name: "b", etag: `f${reads}` }] : []),
          ],
        });
      },
    }),
    PUT: endpoint({
      body: z.object({}),
      handler: () => new Response(null, { status: 204 }),
    }),
  });
  const send = createRouter({ "/list": handler });
  const options = {
    url: "http://test.local/list",
    send,
    runs: 1,
    laws: ["get-get"],
  } as const;

  const report = await checkResourceLaws(handler, options);
  assertEquals(law(report, "get-get").violations[0].differences, [
    { path: "items.0.etag", expected: "e1", actual: "e2" },
    { path: "items.1", actual: { name: "b", etag: "f2" } },
  ]);

  const ignoring = await checkResourceLaws(handler, {
    ...options,
    ignore: ["items.*.etag", "items.1"],
  });
  assertEquals(ignoring.ok, true);
});

Deno.test("laws: the report names the law, the requests and the places", async () => {
  const report = await check((note, body) => ({ ...note, title: body.title }), {
    laws: ["get-get", "put-get"],
  });
  const text = formatResourceLawsReport(report);
  const lines = text.split("\n");

  assertEquals(
    lines[0],
    "resource laws: PUT http://test.local/notes/1, 20 runs, seed 0",
  );
  assertEquals(lines[1], "  get-get: held in 20 of 20 runs");
  assert(
    /^ {2}put-get: held in \d+ of 20 runs, violated in \d+$/.test(lines[2]),
  );
  assert(/^ {4}run \d+: PUT \{.*\}, GET$/.test(lines[3]), lines[3]);
  assert(
    /^ {6}(tags|pinned)(\.\d+)?: put .*, read .*$/.test(lines[4]),
    lines[4],
  );
});
