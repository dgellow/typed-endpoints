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
  // deno-lint-ignore no-explicit-any
}): any {
  const controller = new AbortController();
  return {
    req: {
      url: options.url ?? "http://localhost:3000/api/test",
      method: options.method ?? "GET",
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
