// Type-level test to verify handler inference works correctly
// Run with: deno check src/adapters/fresh_types_test.ts

import {
  createApiHandlers,
  endpoint,
  type FreshApiMethodDef,
  type FreshSseMethodDef,
  sseEndpoint,
} from "./fresh.ts";
import { z } from "zod";

// Test 1: Direct FreshApiMethodDef - does handler get typed?
const paramsSchema = z.object({ id: z.string(), count: z.number() });
type ParamsSchema = typeof paramsSchema;

const methodDef: FreshApiMethodDef<
  unknown,
  undefined,
  undefined,
  ParamsSchema
> = {
  params: paramsSchema,
  handler: (_ctx, { params }) => {
    // With explicit generic, this should work
    const id: string = params.id;
    const count: number = params.count;
    void id;
    void count;
    return Response.json({ ok: true });
  },
};
void methodDef;

// Test 2: Via endpoint helper - should have full inference
const handlers = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string(), count: z.number() }),
    handler: (_ctx, { params }) => {
      // These MUST be typed correctly - not `any`
      params.id satisfies string;
      params.count satisfies number;
      // @ts-expect-error - id is string, not number
      params.id satisfies number;
      // @ts-expect-error - nonexistent property
      params.nonexistent;
      return Response.json({ ok: true });
    },
  }),

  POST: endpoint({
    body: z.object({ name: z.string() }),
    handler: (_ctx, { body }) => {
      body.name satisfies string;
      // @ts-expect-error - name is string, not number
      body.name satisfies number;
      return Response.json({ ok: true });
    },
  }),
});
void handlers;

// Test 3: Verify types are NOT `any` by checking specific type assertions
const _getMethodTest = endpoint({
  params: z.object({ userId: z.string(), orgId: z.number() }),
  query: z.object({ limit: z.number().optional() }),
  body: z.object({ action: z.literal("activate") }),
  handler: (_ctx, validated) => {
    // Verify exact types - these would fail if types were `any`
    type ExpectedParams = { userId: string; orgId: number };
    type ExpectedQuery = { limit?: number };
    type ExpectedBody = { action: "activate" };

    // These assignments verify the types match exactly
    const _p: ExpectedParams = validated.params;
    const _q: ExpectedQuery = validated.query;
    const _b: ExpectedBody = validated.body;

    // @ts-expect-error - wrong type for userId
    const _wrongParams: { userId: number } = validated.params;
    // @ts-expect-error - wrong type for action
    const _wrongBody: { action: "deactivate" } = validated.body;

    void [_p, _q, _b, _wrongParams, _wrongBody];
    return Response.json({ ok: true });
  },
});

// Test 4: SSE endpoint type inference
const sseHandlers = createApiHandlers({
  GET: sseEndpoint({
    params: z.object({ taskId: z.string() }),
    events: {
      progress: z.object({ percent: z.number() }),
      complete: z.object({ result: z.string() }),
      error: z.object({ message: z.string(), code: z.number() }),
    },
    async *handler(_ctx, { params }, signal) {
      // Params should be typed
      params.taskId satisfies string;
      // @ts-expect-error - taskId is string, not number
      params.taskId satisfies number;

      // Signal should be AbortSignal
      signal satisfies AbortSignal;

      // Yielded events must match schema
      yield { event: "progress", data: { percent: 50 } };
      yield { event: "complete", data: { result: "done" } };
      yield { event: "error", data: { message: "failed", code: 500 } };
    },
  }),
});
void sseHandlers;

// Test 5: Direct FreshSseMethodDef type
const progressEvents = {
  tick: z.object({ count: z.number() }),
};
type ProgressEvents = typeof progressEvents;
type QuerySchema = z.ZodObject<{ limit: z.ZodNumber }>;

const _sseDef: FreshSseMethodDef<
  unknown,
  QuerySchema,
  undefined,
  ProgressEvents
> = {
  query: z.object({ limit: z.number() }),
  events: progressEvents,
  async *handler(_ctx, { query }, _signal) {
    query.limit satisfies number;
    yield { event: "tick", data: { count: 1 } };
  },
};

// Test 6: SSE without params (no id required on client)
const _noParamsSse = createApiHandlers({
  GET: sseEndpoint({
    events: {
      update: z.object({ value: z.number() }),
    },
    async *handler(_ctx, { params, query }, _signal) {
      // params and query should be unknown when not specified
      void params;
      void query;
      yield { event: "update", data: { value: 42 } };
    },
  }),
});
