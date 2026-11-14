import { assertEquals } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { createApiHandlers, endpoint, sseEndpoint } from "./fresh.ts";
import { z } from "zod";
import { cursor, cursorId, offset, page, url } from "../pagination/index.ts";

// Mock Fresh Context
function createMockContext(options: {
  url?: string;
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  // deno-lint-ignore no-explicit-any
}): any {
  const controller = new AbortController();
  return {
    req: {
      url: options.url ?? "http://localhost:3000/api/test",
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
      json: () => Promise.resolve(options.body),
      signal: options.signal ?? controller.signal,
    },
    params: options.params ?? {},
  };
}

Deno.test("createApiHandlers with sseEndpoint returns SSE response", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: {
        ping: z.object({ n: z.number() }),
      },
      async *handler(_ctx, _validated, _signal) {
        yield { event: "ping", data: { n: 1 } };
        yield { event: "ping", data: { n: 2 } };
      },
    }),
  });

  const ctx = createMockContext({});
  const response = await handlers.GET(ctx);

  await assertSnapshot(t, {
    headers: {
      "Content-Type": response.headers.get("Content-Type"),
      "Cache-Control": response.headers.get("Cache-Control"),
    },
    body: await response.text(),
  });
});

Deno.test("createApiHandlers with sseEndpoint validates params", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      params: z.object({ id: z.string().min(3) }),
      events: {
        data: z.object({ value: z.string() }),
      },
      async *handler(_ctx, { params }, _signal) {
        yield { event: "data", data: { value: params.id } };
      },
    }),
  });

  // Valid params
  const validCtx = createMockContext({ params: { id: "abc" } });
  const validResponse = await handlers.GET(validCtx);
  await assertSnapshot(t, { validStatus: validResponse.status });

  // Invalid params (too short)
  const invalidCtx = createMockContext({ params: { id: "ab" } });
  const invalidResponse = await handlers.GET(invalidCtx);
  await assertSnapshot(t, { invalidStatus: invalidResponse.status });
});

Deno.test("createApiHandlers with sseEndpoint validates query", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      query: z.object({ limit: z.coerce.number().min(1) }),
      events: {
        item: z.object({ id: z.number() }),
      },
      async *handler(_ctx, { query }, _signal) {
        for (let i = 0; i < query.limit; i++) {
          yield { event: "item", data: { id: i } };
        }
      },
    }),
  });

  // Valid query
  const validCtx = createMockContext({
    url: "http://localhost:3000/api/test?limit=2",
  });
  const validResponse = await handlers.GET(validCtx);

  await assertSnapshot(t, {
    status: validResponse.status,
    body: await validResponse.text(),
  });
});

Deno.test("createApiHandlers with sseEndpoint includes event ID", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: {
        msg: z.object({ text: z.string() }),
      },
      async *handler(_ctx, _validated, _signal) {
        yield { event: "msg", data: { text: "hello" }, id: "msg-001" };
      },
    }),
  });

  const ctx = createMockContext({});
  const response = await handlers.GET(ctx);

  await assertSnapshot(t, await response.text());
});

Deno.test("createApiHandlers with sseEndpoint includes retry", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: {
        heartbeat: z.object({}),
      },
      async *handler(_ctx, _validated, _signal) {
        yield { event: "heartbeat", data: {}, retry: 5000 };
      },
    }),
  });

  const ctx = createMockContext({});
  const response = await handlers.GET(ctx);

  await assertSnapshot(t, await response.text());
});

Deno.test("createApiHandlers attaches __apiDef with events", async (t) => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      params: z.object({ id: z.string() }),
      events: {
        progress: z.object({ percent: z.number() }),
        complete: z.object({ result: z.string() }),
      },
      async *handler() {
        yield { event: "progress", data: { percent: 100 } };
      },
    }),
  });

  const apiDef = handlers.__apiDef;
  const getDef = apiDef.GET!;

  await assertSnapshot(t, {
    hasGetDef: apiDef.GET !== undefined,
    hasEvents: "events" in getDef,
    handlerStripped: !("handler" in getDef),
  });
});

Deno.test("createApiHandlers mixes REST and SSE endpoints", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      response: z.object({ items: z.array(z.string()) }),
      handler: () => Response.json({ items: ["a", "b"] }),
    }),
    POST: sseEndpoint({
      events: {
        created: z.object({ id: z.string() }),
      },
      async *handler() {
        yield { event: "created", data: { id: "new-123" } };
      },
    }),
  });

  const getCtx = createMockContext({ method: "GET" });
  const getResponse = await handlers.GET(getCtx);

  const postCtx = createMockContext({ method: "POST" });
  const postResponse = await handlers.POST(postCtx);

  await assertSnapshot(t, {
    GET: getResponse.headers.get("Content-Type"),
    POST: postResponse.headers.get("Content-Type"),
  });
});

// =============================================================================
// Pagination integration tests
// =============================================================================

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

Deno.test("createApiHandlers preserves __pagination in __apiDef for cursor pagination", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...cursor.paginated({
        item: UserSchema,
        names: { items: "data", cursor: "nextCursor" },
      }),
      handler: () =>
        Response.json({
          data: [],
          nextCursor: undefined,
        }),
    }),
  });

  const apiDef = handlers.__apiDef;

  // deno-lint-ignore no-explicit-any
  const pagination = (apiDef.GET as any).__pagination;
  await assertSnapshot(t, pagination);
});

Deno.test("createApiHandlers preserves __pagination for offset pagination", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...offset.paginated({
        item: UserSchema,
        names: {
          items: "results",
          total: "count",
          offsetParam: "skip",
          limitParam: "take",
        },
      }),
      handler: () =>
        Response.json({
          results: [],
          count: 0,
        }),
    }),
  });

  const apiDef = handlers.__apiDef;
  // deno-lint-ignore no-explicit-any
  const pagination = (apiDef.GET as any).__pagination;
  await assertSnapshot(t, pagination);
});

Deno.test("paginated endpoint validates query params", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...cursor.paginated({
        item: UserSchema,
        defaultLimit: 10,
        maxLimit: 50,
      }),
      handler: (_ctx, { query }) => {
        return Response.json({
          items: [],
          cursor: undefined,
          _debug: { limit: query.limit, cursor: query.cursor },
        });
      },
    }),
  });

  // Test with defaults
  const defaultCtx = createMockContext({
    url: "http://localhost:3000/api/users",
  });
  const defaultResponse = await handlers.GET(defaultCtx);
  const defaultData = await defaultResponse.json();
  await assertSnapshot(t, {
    status: defaultResponse.status,
    debug: defaultData._debug,
  });

  // Test with custom limit
  const customCtx = createMockContext({
    url: "http://localhost:3000/api/users?limit=25&cursor=abc",
  });
  const customResponse = await handlers.GET(customCtx);
  const customData = await customResponse.json();
  await assertSnapshot(t, {
    status: customResponse.status,
    debug: customData._debug,
  });

  // Test with invalid limit (exceeds max)
  const invalidCtx = createMockContext({
    url: "http://localhost:3000/api/users?limit=100",
  });
  const invalidResponse = await handlers.GET(invalidCtx);
  await assertSnapshot(t, { status: invalidResponse.status });
});

Deno.test("paginated endpoint with extra query params", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...cursor.paginated({
        item: UserSchema,
        extraQuery: {
          filter: z.string().optional(),
          sort: z.enum(["asc", "desc"]).default("asc"),
        },
      }),
      handler: (_ctx, { query }) => {
        return Response.json({
          items: [],
          cursor: undefined,
          _debug: {
            filter: query.filter,
            sort: query.sort,
          },
        });
      },
    }),
  });

  const ctx = createMockContext({
    url: "http://localhost:3000/api/users?filter=active&sort=desc",
  });
  const response = await handlers.GET(ctx);
  const data = await response.json();

  await assertSnapshot(t, {
    status: response.status,
    debug: data._debug,
  });
});

Deno.test("createApiHandlers preserves __pagination for page pagination", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...page.paginated({
        item: UserSchema,
        names: {
          items: "users",
          total: "totalCount",
          totalPages: "pageCount",
          pageParam: "p",
          perPageParam: "size",
        },
        defaultPerPage: 25,
        maxPerPage: 100,
      }),
      handler: () =>
        Response.json({
          users: [],
          totalCount: 0,
          pageCount: 0,
        }),
    }),
  });

  const apiDef = handlers.__apiDef;
  // deno-lint-ignore no-explicit-any
  const pagination = (apiDef.GET as any).__pagination;
  await assertSnapshot(t, pagination);
});

Deno.test("createApiHandlers preserves __pagination for cursorId pagination", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...cursorId.paginated({
        item: UserSchema,
        names: {
          items: "data",
          cursorIdParam: "after",
          idField: "id",
        },
      }),
      handler: () =>
        Response.json({
          data: [],
        }),
    }),
  });

  const apiDef = handlers.__apiDef;
  // deno-lint-ignore no-explicit-any
  const pagination = (apiDef.GET as any).__pagination;
  await assertSnapshot(t, pagination);
});

Deno.test("createApiHandlers preserves __pagination for url pagination", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...url.paginated({
        item: UserSchema,
        names: {
          items: "results",
          nextUrl: "links.next",
          prevUrl: "links.prev",
        },
      }),
      handler: () =>
        Response.json({
          results: [],
          links: { next: undefined, prev: undefined },
        }),
    }),
  });

  const apiDef = handlers.__apiDef;
  // deno-lint-ignore no-explicit-any
  const pagination = (apiDef.GET as any).__pagination;
  await assertSnapshot(t, pagination);
});

Deno.test("page paginated endpoint validates query params", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...page.paginated({
        item: UserSchema,
        defaultPerPage: 10,
        maxPerPage: 50,
      }),
      handler: (_ctx, { query }) => {
        return Response.json({
          items: [],
          total: 0,
          totalPages: 0,
          _debug: { page: query.page, perPage: query.perPage },
        });
      },
    }),
  });

  // Test with defaults
  const defaultCtx = createMockContext({
    url: "http://localhost:3000/api/users",
  });
  const defaultResponse = await handlers.GET(defaultCtx);
  const defaultData = await defaultResponse.json();
  await assertSnapshot(t, {
    status: defaultResponse.status,
    debug: defaultData._debug,
  });

  // Test with custom values
  const customCtx = createMockContext({
    url: "http://localhost:3000/api/users?page=3&perPage=25",
  });
  const customResponse = await handlers.GET(customCtx);
  const customData = await customResponse.json();
  await assertSnapshot(t, {
    status: customResponse.status,
    debug: customData._debug,
  });

  // Test with invalid perPage (exceeds max)
  const invalidCtx = createMockContext({
    url: "http://localhost:3000/api/users?perPage=100",
  });
  const invalidResponse = await handlers.GET(invalidCtx);
  await assertSnapshot(t, { status: invalidResponse.status });
});

Deno.test("cursorId paginated endpoint validates query params", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...cursorId.paginated({
        item: UserSchema,
        names: { cursorIdParam: "after" },
        defaultLimit: 20,
      }),
      handler: (_ctx, { query }) => {
        return Response.json({
          items: [],
          hasMore: false,
          _debug: { after: query.after, limit: query.limit },
        });
      },
    }),
  });

  const ctx = createMockContext({
    url: "http://localhost:3000/api/users?after=user-123&limit=15",
  });
  const response = await handlers.GET(ctx);
  const data = await response.json();

  await assertSnapshot(t, {
    status: response.status,
    debug: data._debug,
  });
});

Deno.test("url paginated endpoint has no query validation (url pagination)", async (t) => {
  const handlers = createApiHandlers({
    GET: endpoint({
      ...url.paginated({
        item: UserSchema,
      }),
      handler: () => {
        return Response.json({
          items: [],
          next: undefined,
          prev: undefined,
        });
      },
    }),
  });

  const ctx = createMockContext({
    url: "http://localhost:3000/api/users",
  });
  const response = await handlers.GET(ctx);

  await assertSnapshot(t, { status: response.status });
});

Deno.test("sseEndpoint: an empty id is sent", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { msg: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "msg", data: { n: 1 }, id: "" };
      },
    }),
  });

  const response = await handlers.GET(createMockContext({}));

  assertEquals(await response.text(), 'event: msg\nid: \ndata: {"n":1}\n\n');
});

Deno.test("sseEndpoint: cancelling the body aborts the signal and ends the handler", async () => {
  const log: string[] = [];
  let handlerSignal: AbortSignal | undefined;
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    const handlers = createApiHandlers({
      GET: sseEndpoint({
        events: { tick: z.object({ n: z.number() }) },
        async *handler(_ctx, _validated, signal) {
          handlerSignal = signal;
          try {
            for (let n = 0; n < 100; n++) {
              log.push(`yield ${n}`);
              yield { event: "tick", data: { n } };
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          } finally {
            log.push("finally");
          }
        },
      }),
    });

    const response = await handlers.GET(createMockContext({}));
    const reader = response.body!.getReader();
    const first = await reader.read();
    assertEquals(
      new TextDecoder().decode(first.value),
      'event: tick\ndata: {"n":0}\n\n',
    );

    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assertEquals(handlerSignal?.aborted, true);
    assertEquals(log.at(-1), "finally");
    // The handler is not resumed after the cancel.
    assertEquals(log, ["yield 0", "finally"]);
    assertEquals(errors, []);
  } finally {
    console.error = originalError;
  }
});

Deno.test("sseEndpoint: the handler is advanced only as the body is read", async () => {
  let produced = 0;
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        for (let n = 0; n < 1000; n++) {
          produced++;
          yield { event: "tick", data: { n } };
        }
      },
    }),
  });

  const response = await handlers.GET(createMockContext({}));
  const reader = response.body!.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Nothing is produced ahead of the reader.
  assertEquals(produced, 1);
  await reader.cancel();
});

/** Read a response body chunk by chunk; the error that cut it, if any. */
async function readStream(
  response: Response,
): Promise<{ text: string; error?: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

/** Run with `console.error` captured. */
async function capturingErrors<T>(
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

Deno.test("sseEndpoint: a handler error cuts the stream after the events sent so far", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "tick", data: { n: 0 } };
        throw new Error("boom");
      },
    }),
  });

  const { result, errors } = await capturingErrors(async () =>
    readStream(await handlers.GET(createMockContext({})))
  );

  // The event that was sent stays sent. The stream then fails where a
  // normal end would close it: a reader can tell the two apart.
  assertEquals(result.text, 'event: tick\ndata: {"n":0}\n\n');
  assertEquals((result.error as Error).message, "boom");
  assertEquals(errors.length, 1);
  assertEquals(errors[0][0], "GET /api/test: SSE stream error:");
  assertEquals((errors[0][1] as Error).message, "boom");
});

Deno.test("sseEndpoint: a handler that returns ends the stream normally", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "tick", data: { n: 0 } };
      },
    }),
  });
  const result = await readStream(await handlers.GET(createMockContext({})));
  assertEquals(result, { text: 'event: tick\ndata: {"n":0}\n\n' });
});

Deno.test("sseEndpoint: an event is parsed by its schema before it is sent", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: {
        tick: z.object({ n: z.number(), unit: z.string().default("s") }),
      },
      async *handler() {
        // The default is applied and the unknown key is stripped, as for
        // a value a REST handler returns.
        yield { event: "tick", data: { n: 1, secret: "not sent" } as never };
      },
    }),
  });
  const result = await readStream(await handlers.GET(createMockContext({})));
  assertEquals(result, {
    text: 'event: tick\ndata: {"n":1,"unit":"s"}\n\n',
  });
});

Deno.test("sseEndpoint: an event its schema rejects is not sent and cuts the stream", async () => {
  let cleanedUp = false;
  let aborted = false;
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler(_ctx, _validated, signal) {
        try {
          yield { event: "tick", data: { n: 0 } };
          // Past the types: data from an untyped source.
          yield { event: "tick", data: { n: "one" } as never };
          yield { event: "tick", data: { n: 2 } };
        } finally {
          cleanedUp = true;
          aborted = signal.aborted;
        }
      },
    }),
  });

  const { result, errors } = await capturingErrors(async () =>
    readStream(await handlers.GET(createMockContext({})))
  );

  assertEquals(result.text, 'event: tick\ndata: {"n":0}\n\n');
  assertEquals(
    (result.error as Error).message.startsWith(
      'the handler yielded an event "tick" whose data does not match its schema',
    ),
    true,
  );
  assertEquals(errors.length, 1);
  // The handler is stopped where it stands: its `finally` runs and its
  // signal is aborted.
  assertEquals(cleanedUp, true);
  assertEquals(aborted, true);
});

Deno.test("sseEndpoint: an event the endpoint does not declare cuts the stream", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "tock", data: {} } as never;
      },
    }),
  });

  const { result, errors } = await capturingErrors(async () =>
    readStream(await handlers.GET(createMockContext({})))
  );
  assertEquals(result.text, "");
  assertEquals(
    (result.error as Error).message,
    'the handler yielded the event "tock", which the endpoint does not declare',
  );
  assertEquals(errors.length, 1);
});

Deno.test("sseEndpoint: the handler receives the id of the last event the client saw", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler(_ctx, { lastEventId }) {
        // Resume after the event the client has.
        const from = lastEventId === undefined ? 0 : Number(lastEventId) + 1;
        for (let n = from; n < 3; n++) {
          yield { event: "tick", data: { n }, id: String(n) };
        }
      },
    }),
  });

  const first = await readStream(await handlers.GET(createMockContext({})));
  assertEquals(first.text.match(/"n":\d/g), ['"n":0', '"n":1', '"n":2']);

  const resumed = await readStream(
    await handlers.GET(
      createMockContext({ headers: { "Last-Event-ID": "1" } }),
    ),
  );
  assertEquals(resumed.text, 'event: tick\nid: 2\ndata: {"n":2}\n\n');
});

Deno.test("sseEndpoint: keepAlive sends a comment while the handler has nothing to say", async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => release = resolve);
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      keepAlive: 10,
      async *handler() {
        yield { event: "tick", data: { n: 0 } };
        await waiting;
        yield { event: "tick", data: { n: 1 } };
      },
    }),
  });

  const response = await handlers.GET(createMockContext({}));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const read = async () => decoder.decode((await reader.read()).value);

  assertEquals(await read(), 'event: tick\ndata: {"n":0}\n\n');
  // The handler is waiting: comments arrive, one per read.
  assertEquals(await read(), ": keep-alive\n\n");
  assertEquals(await read(), ": keep-alive\n\n");
  release();
  // The event the handler was working on is not lost.
  let next = await read();
  while (next === ": keep-alive\n\n") next = await read();
  assertEquals(next, 'event: tick\ndata: {"n":1}\n\n');
  assertEquals((await reader.read()).done, true);
});

Deno.test("sseEndpoint: without keepAlive nothing is sent between events", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "tick", data: { n: 0 } };
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { event: "tick", data: { n: 1 } };
      },
    }),
  });
  const result = await readStream(await handlers.GET(createMockContext({})));
  assertEquals(
    result.text,
    'event: tick\ndata: {"n":0}\n\nevent: tick\ndata: {"n":1}\n\n',
  );
});

Deno.test("sseEndpoint: a request aborted before the first read produces no events", async () => {
  const controller = new AbortController();
  let started = false;
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        started = true;
        yield { event: "tick", data: { n: 0 } };
      },
    }),
  });

  const ctx = createMockContext({ signal: controller.signal });
  const response = await handlers.GET(ctx);
  controller.abort();

  assertEquals(await response.text(), "");
  assertEquals(started, false);
});
