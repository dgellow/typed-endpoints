import { assertEquals } from "@std/assert";
import { createApiHandlers, endpoint, sseEndpoint } from "./fresh.ts";
import { z } from "zod";

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

Deno.test("createApiHandlers with sseEndpoint returns SSE response", async () => {
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

  assertEquals(response.headers.get("Content-Type"), "text/event-stream");
  assertEquals(response.headers.get("Cache-Control"), "no-cache");

  const text = await response.text();
  assertEquals(
    text,
    'event: ping\ndata: {"n":1}\n\nevent: ping\ndata: {"n":2}\n\n',
  );
});

Deno.test("createApiHandlers with sseEndpoint validates params", async () => {
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
  assertEquals(validResponse.status, 200);

  // Invalid params (too short)
  const invalidCtx = createMockContext({ params: { id: "ab" } });
  const invalidResponse = await handlers.GET(invalidCtx);
  assertEquals(invalidResponse.status, 400);
});

Deno.test("createApiHandlers with sseEndpoint validates query", async () => {
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
  assertEquals(validResponse.status, 200);

  const text = await validResponse.text();
  assertEquals(
    text,
    'event: item\ndata: {"id":0}\n\nevent: item\ndata: {"id":1}\n\n',
  );
});

Deno.test("createApiHandlers with sseEndpoint includes event ID", async () => {
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
  const text = await response.text();

  assertEquals(
    text,
    'event: msg\nid: msg-001\ndata: {"text":"hello"}\n\n',
  );
});

Deno.test("createApiHandlers with sseEndpoint includes retry", async () => {
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
  const text = await response.text();

  assertEquals(text, "event: heartbeat\nretry: 5000\ndata: {}\n\n");
});

Deno.test("createApiHandlers attaches __apiDef with events", () => {
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

  // __apiDef should have the SSE definition (without handler)
  const apiDef = handlers.__apiDef;
  assertEquals(apiDef.GET !== undefined, true);

  const getDef = apiDef.GET!;
  assertEquals("events" in getDef, true);
  assertEquals("handler" in getDef, false);
});

Deno.test("createApiHandlers mixes REST and SSE endpoints", async () => {
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

  // GET should be REST
  const getCtx = createMockContext({ method: "GET" });
  const getResponse = await handlers.GET(getCtx);
  assertEquals(getResponse.headers.get("Content-Type"), "application/json");

  // POST should be SSE
  const postCtx = createMockContext({ method: "POST" });
  const postResponse = await handlers.POST(postCtx);
  assertEquals(postResponse.headers.get("Content-Type"), "text/event-stream");
});
