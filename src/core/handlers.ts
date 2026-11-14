/**
 * Route handlers with request validation, independent of the framework.
 *
 * A framework hands a route handler some context value: Fresh a `Context`,
 * Bun the request itself. Everything else is the same everywhere: read the
 * standard `Request`, validate body, query and path parameters against the
 * schemas, answer 400 or call the handler. `buildHandlers()` does that for
 * any context type, given how to get the request and the path parameters
 * out of it. The framework integrations are thin wrappers around it.
 *
 * @module
 */

import type { z } from "zod";
import type {
  ApiMethodDef,
  DeclaredResponse,
  ErrorStatus,
  HttpMethod,
  ResponsesDef,
  SseEvent,
  SseEventDef,
  SseMethodDef,
  ValidatedRequest,
} from "./types.ts";
import { applyDependentResponse } from "./dependent.ts";
import type { ReadonlyDeep } from "./dependent_types.ts";
import { SSE_FAILURE_COMMENT } from "../client/sse.ts";
import { validateRequest, type ValidationError } from "./validation.ts";

/** Property that marks a `Failure`, shared by every copy of this module. */
const FAILURE: unique symbol = Symbol.for("typed-endpoints.failure") as never;

/** Path parameters as a router hands them over. */
export type RawParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * How to read a request out of what a framework passes to a handler.
 *
 * `TContext` is the first argument, which the endpoint's own handler
 * receives too. `TRest` are further arguments of the framework's handler
 * signature (Next.js passes the path parameters in a second argument).
 */
export interface RequestAccess<TContext, TRest extends unknown[] = []> {
  /** The standard request. */
  readonly request: (context: TContext, ...rest: TRest) => Request;
  /** The path parameters the router extracted. May be a promise. */
  readonly params: (
    context: TContext,
    ...rest: TRest
  ) => RawParams | undefined | Promise<RawParams | undefined>;
}

/** A method definition with its handler, for context type `TContext`. */
export interface HandlerMethodDef<
  TContext,
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
  TResponses extends ResponsesDef | undefined = ResponsesDef | undefined,
> extends
  ApiMethodDef<
    TBodySchema,
    TQuerySchema,
    TParamsSchema,
    TResponseSchema,
    TResponses
  > {
  /**
   * Handles the request. Receives the framework's context and the
   * validated body, query and path parameters.
   *
   * Returns either:
   *
   * - a value of the `response` schema's input type. It is parsed with the
   *   schema, cut down to what the request asked for where the schema has
   *   `projection()` or `expansion()` places, and sent as JSON with status
   *   200. A value the schema rejects is a server error: the client gets
   *   500 and the issues are logged.
   * - `fail(status, body)` for an error response the method declares in
   *   `responses`. The body is typed by the schema declared for that
   *   status, parsed with it, and sent as JSON with that status. A body
   *   the schema rejects is a server error, as above.
   * - a `Response`, which is sent as it is and not checked. For other
   *   status codes, headers, or bodies that are not JSON.
   */
  readonly handler: (
    context: TContext,
    validated: ValidatedRequest<
      TBodySchema extends z.ZodType ? z.infer<TBodySchema> : unknown,
      TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown,
      TParamsSchema extends z.ZodType ? z.infer<TParamsSchema> : unknown
    >,
  ) =>
    | HandlerResult<TResponseSchema, TResponses>
    | Promise<HandlerResult<TResponseSchema, TResponses>>;
}

/**
 * What a handler may return: a `Response`; when the method declares a
 * `response` schema, a value of that schema's input type; and, for each
 * error status it declares in `responses`, a `fail()` with a body of that
 * status's schema.
 */
export type HandlerResult<TResponseSchema, TResponses = undefined> =
  | (TResponseSchema extends z.ZodType ? Response | z.input<TResponseSchema>
    : Response)
  | DeclaredFailure<TResponses>;

/** A declared error response, as a handler returns it. Made by `fail()`. */
export class Failure<TStatus extends number = number, TBody = unknown> {
  /** Marks the value across copies of this module. */
  readonly [FAILURE] = true;

  /**
   * Create the failure. Use `fail()`.
   *
   * @param status The HTTP status.
   * @param body The response body.
   */
  constructor(
    /** The HTTP status. */
    readonly status: TStatus,
    /** The response body. */
    readonly body: TBody,
  ) {}
}

/**
 * Answer with an error response the endpoint declares.
 *
 * ```ts
 * GET: endpoint({
 *   params: z.object({ id: z.string() }),
 *   response: Item,
 *   responses: { 404: NotFound },
 *   handler: (_ctx, { params }) =>
 *     items.get(params.id) ??
 *       fail(404, { error: "not_found", id: params.id }),
 * })
 * ```
 *
 * The status has to be one the endpoint declares, and the body has to fit
 * the schema declared for it: both are compile errors otherwise. The body
 * is parsed with that schema before it is sent.
 *
 * @param status A status the endpoint declares in `responses`.
 * @param body The body, of the schema declared for the status.
 */
export function fail<const TStatus extends number, const TBody>(
  status: TStatus,
  body: TBody,
): Failure<TStatus, TBody> {
  return new Failure(status, body);
}

/** The `fail()` values a handler may return, given its `responses`. */
export type DeclaredFailure<TResponses> = TResponses extends ResponsesDef ? {
    [S in ErrorStatus<TResponses>]: Failure<
      S,
      ReadonlyDeep<z.input<DeclaredResponse<TResponses, S>>>
    >;
  }[ErrorStatus<TResponses>]
  : never;

/** An SSE method definition with its generator, for context `TContext`. */
export interface HandlerSseMethodDef<
  TContext,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
> extends SseMethodDef<TQuerySchema, TParamsSchema, TEvents> {
  /**
   * Produces the events. Receives the framework's context, the validated
   * query and path parameters with the id of the last event the client
   * saw, and a signal that aborts when the client disconnects or the
   * response body is cancelled.
   *
   * Each yielded event is parsed with the schema of its name before it is
   * sent. An event the schema rejects, an event the endpoint does not
   * declare, and an exception all end the stream as a failure: a comment
   * line (`: error`) is written before the stream closes, so the client
   * can tell a failure from the end of the events. The cause is logged.
   */
  readonly handler: (
    context: TContext,
    validated: {
      query: TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown;
      params: TParamsSchema extends z.ZodType ? z.infer<TParamsSchema>
        : unknown;
      /**
       * The `Last-Event-ID` header: the id of the last event the client
       * received before it reconnected. `undefined` on a first connection.
       */
      lastEventId: string | undefined;
    },
    signal: AbortSignal,
  ) => AsyncGenerator<SseEvent<TEvents>, void, unknown>;
}

/**
 * The method definitions of a route without their handlers, with the schema
 * types as written. Tooling reads the schemas from here at runtime; protocol
 * composition (`fromEndpoint()`) reads their types.
 */
export type ApiDefOf<TDef> = {
  readonly [M in keyof TDef]: Omit<TDef[M], "handler">;
};

/** A handler in a framework's signature, carrying its method definition. */
export type RouteHandler<
  TContext,
  TRest extends unknown[],
  TMethodDef,
> =
  & ((context: TContext, ...rest: TRest) => Promise<Response>)
  & { readonly __methodDef: Omit<TMethodDef, "handler"> };

/** What `buildHandlers()` returns: one handler per defined method. */
export type Handlers<TContext, TDef, TRest extends unknown[] = []> =
  & { [M in keyof TDef]: RouteHandler<TContext, TRest, TDef[M]> }
  & { __apiDef: ApiDefOf<TDef> };

/** Options of `buildHandlers()`. */
export interface BuildHandlersOptions {
  /**
   * Attach `__apiDef` as a non-enumerable property. For routers that
   * reject or iterate unknown keys of a route object. Default: false.
   */
  readonly hiddenApiDef?: boolean;
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && FAILURE in value;
}

/**
 * The response for a `fail()` a handler returned: the body parsed by the
 * schema declared for the status, as JSON with that status.
 */
function respondWithFailure(
  method: string,
  request: Request,
  def: { readonly responses?: ResponsesDef },
  failure: Failure,
): Response {
  const where = `${method} ${new URL(request.url).pathname}`;
  const declared = def.responses?.[failure.status];
  if (!declared) {
    console.error(
      `${where}: the handler failed with status ${failure.status}, which the endpoint does not declare in \`responses\``,
    );
    return jsonError("Internal Server Error", 500);
  }
  const schema = "schema" in declared ? declared.schema : declared;
  const parsed = schema.safeParse(failure.body);
  if (!parsed.success) {
    console.error(
      `${where}: the handler failed with a body that does not match the schema declared for ${failure.status}:`,
      parsed.error.issues,
    );
    return jsonError("Internal Server Error", 500);
  }
  return new Response(JSON.stringify(parsed.data), {
    status: failure.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** JSON error response */
function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The answer to a request that failed validation: 400, or 415 for a body
 * that is not JSON. The body names the part that failed and each issue.
 */
function invalidRequest(failure: ValidationError): Response {
  return new Response(
    JSON.stringify({
      error: failure.error,
      in: failure.type,
      issues: failure.issues,
    }),
    {
      status: failure.type === "content-type" ? 415 : 400,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** One event in `text/event-stream` framing. */
function formatSseEvent<TEvents extends SseEventDef>(
  event: SseEvent<TEvents>,
): string {
  let message = "";
  if (event.event) {
    message += `event: ${String(event.event)}\n`;
  }
  // An empty id is meaningful: it resets the client's last event ID.
  if (event.id !== undefined) {
    message += `id: ${event.id}\n`;
  }
  if (event.retry !== undefined) {
    message += `retry: ${event.retry}\n`;
  }
  return message + `data: ${JSON.stringify(event.data)}\n\n`;
}

/** What `createSseResponse()` needs to know about the endpoint. */
interface SseStreamOptions {
  /** Data schema of each event, by event name. */
  readonly events: SseEventDef;
  /** Milliseconds without an event after which a comment is sent. */
  readonly keepAlive?: number;
  /** Method and path, for the log. */
  readonly where: string;
}

/** A comment line: ignored by clients, seen by intermediaries. */
const KEEP_ALIVE = ": keep-alive\n\n";

/**
 * The comment written before a stream is closed because its handler
 * failed. The client of this library reads it as a failure; any other
 * event-stream client ignores it.
 */
const STREAM_FAILED = `${SSE_FAILURE_COMMENT}\n\n`;

/**
 * Create SSE response from async generator.
 *
 * The generator is advanced only when the consumer reads, and it stops
 * when the response body is cancelled or `abort` fires, whichever is first:
 * the handler's signal aborts and its `finally` blocks run.
 *
 * Each event is parsed with its schema before it is sent. A handler that
 * throws, or yields an event its endpoint does not declare or its schema
 * rejects, fails the stream: the events sent so far stay sent, a comment
 * that says so is written, and the stream closes.
 *
 * The stream is closed, not errored: a response body that errors resets
 * the connection, and on some runtimes (Bun) that drops the events that
 * were sent just before it.
 */
function createSseResponse<TEvents extends SseEventDef>(
  generator: AsyncGenerator<SseEvent<TEvents>, void, unknown>,
  abort: AbortController,
  options: SseStreamOptions,
): Response {
  const encoder = new TextEncoder();
  const { signal } = abort;
  let finished = false;
  // The step of the generator that is under way. It outlives a `pull`
  // that sent a keep-alive instead of an event.
  let pending: Promise<IteratorResult<SseEvent<TEvents>, void>> | undefined;

  // Ends the generator once. A handler that throws while it winds down has
  // nowhere to report to, so the error is logged.
  const finish = () => {
    if (finished) return;
    finished = true;
    generator.return(undefined).catch((error) => {
      console.error(`${options.where}: SSE stream error:`, error);
    });
  };

  /** The event as it goes on the wire, its data parsed by its schema. */
  const checked = (event: SseEvent<TEvents>): string => {
    const name = String(event.event);
    const schema = Object.hasOwn(options.events, name)
      ? options.events[name]
      : undefined;
    if (!schema) {
      throw new Error(
        `the handler yielded the event "${name}", which the endpoint does not declare`,
      );
    }
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) {
      throw new Error(
        `the handler yielded an event "${name}" whose data does not match its schema: ${parsed.error.message}`,
      );
    }
    return formatSseEvent({ ...event, data: parsed.data });
  };

  /** Resolves to `"idle"` after the keep-alive interval; can be cleared. */
  const idle = (): { promise: Promise<"idle">; clear: () => void } => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      promise: new Promise((resolve) => {
        timer = setTimeout(() => resolve("idle"), options.keepAlive);
      }),
      clear: () => clearTimeout(timer),
    };
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) {
          finish();
          controller.close();
          return;
        }

        pending ??= generator.next();
        let next: IteratorResult<SseEvent<TEvents>, void>;
        if (options.keepAlive === undefined) {
          next = await pending;
        } else {
          const timer = idle();
          const first = await Promise.race([pending, timer.promise]);
          timer.clear();
          if (first === "idle") {
            // Nothing to send yet: a comment answers this read, and the
            // next read waits for the same step of the generator.
            if (!finished) controller.enqueue(encoder.encode(KEEP_ALIVE));
            return;
          }
          next = first;
        }
        pending = undefined;

        // The body was cancelled while the handler was working.
        if (finished) return;
        if (next.done || signal.aborted) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(checked(next.value)));
      } catch (error) {
        if (finished) return;
        if (signal.aborted) {
          finished = true;
          controller.close();
          return;
        }
        console.error(`${options.where}: SSE stream error:`, error);
        // The handler may still be running (an event it yielded was
        // rejected): stop it, then end the stream as a failure.
        abort.abort();
        finish();
        controller.enqueue(encoder.encode(STREAM_FAILED));
        controller.close();
      }
    },
    cancel() {
      abort.abort();
      finish();
    },
    // Nothing is produced ahead of the consumer.
  }, { highWaterMark: 0 });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/** Check if a definition is an SSE endpoint */
function isSseEndpoint(def: unknown): boolean {
  return typeof def === "object" && def !== null && "events" in def;
}

/**
 * The response for a value a handler returned: parsed by the response
 * schema, reduced by its request-dependent rules, as JSON.
 */
function respondWith(
  method: string,
  request: Request,
  def: { readonly response?: z.ZodType },
  value: unknown,
  validated: { readonly query: unknown },
): Response {
  let body = value;
  if (def.response) {
    const parsed = def.response.safeParse(value);
    if (!parsed.success) {
      // The handler broke the endpoint's contract. That is a bug on the
      // server; the details are for its log, not for the client.
      console.error(
        `${method} ${
          new URL(request.url).pathname
        }: the handler returned a value that does not match the response schema:`,
        parsed.error.issues,
      );
      return jsonError("Internal Server Error", 500);
    }
    body = applyDependentResponse(def.response, parsed.data, validated.query);
  }
  if (body === undefined) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create route handlers with automatic validation for any framework.
 *
 * @param apiDef Method definitions by HTTP method, each with its handler.
 * @param access How to read the request and the path parameters from the
 *   value the framework passes to a handler.
 */
export function buildHandlers<
  TContext,
  TDef extends Record<string, unknown>,
  TRest extends unknown[] = [],
>(
  apiDef: TDef,
  access: RequestAccess<TContext, TRest>,
  options: BuildHandlersOptions = {},
): Handlers<TContext, TDef, TRest> {
  const handlers: Record<
    string,
    (context: TContext, ...rest: TRest) => Promise<Response>
  > = {};

  // Path parameters without the entries a router left undefined.
  const paramsOf = async (
    context: TContext,
    rest: TRest,
  ): Promise<Record<string, string>> => {
    const raw = await access.params(context, ...rest) ?? {};
    return Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
  };

  type MethodDef = HandlerMethodDef<TContext, z.ZodType, z.ZodType, z.ZodType>;
  type SseDef = HandlerSseMethodDef<
    TContext,
    z.ZodType,
    z.ZodType,
    SseEventDef
  >;

  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;

    // Handle SSE endpoints
    if (isSseEndpoint(def)) {
      const sseDef = def as SseDef;
      handlers[method] = async (context: TContext, ...rest: TRest) => {
        const request = access.request(context, ...rest);
        // Validate query and params only (SSE has no body)
        const result = await validateRequest(
          {
            json: () => Promise.resolve(undefined),
            url: request.url,
            params: await paramsOf(context, rest),
          },
          { query: sseDef.query, params: sseDef.params },
          "GET",
        );

        if (!result.success) return invalidRequest(result);

        const abortController = new AbortController();

        // Clean up on client disconnect
        request.signal.addEventListener("abort", () => {
          abortController.abort();
        });

        const generator = sseDef.handler(
          context,
          {
            query: result.data.query,
            params: result.data.params,
            lastEventId: request.headers.get("Last-Event-ID") ?? undefined,
          },
          abortController.signal,
        );

        return createSseResponse(generator, abortController, {
          events: sseDef.events,
          keepAlive: sseDef.keepAlive,
          where: `${method} ${new URL(request.url).pathname}`,
        });
      };
    } else {
      // Handle regular REST endpoints
      const methodDef = def as MethodDef;
      handlers[method] = async (context: TContext, ...rest: TRest) => {
        const request = access.request(context, ...rest);
        const result = await validateRequest(
          {
            json: () => request.json(),
            text: () => request.text(),
            contentType: request.headers.get("Content-Type"),
            url: request.url,
            params: await paramsOf(context, rest),
          },
          methodDef,
          method,
        );

        if (!result.success) return invalidRequest(result);

        const returned = await methodDef.handler(context, result.data);
        if (returned instanceof Response) return returned;
        if (isFailure(returned)) {
          return respondWithFailure(method, request, methodDef, returned);
        }
        return respondWith(method, request, methodDef, returned, result.data);
      };
    }
  }

  // Attach apiDef for OpenAPI/type generation (strip handlers)
  // deno-lint-ignore no-explicit-any
  const apiDefWithoutHandlers: Record<string, any> = {};
  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
    // deno-lint-ignore no-explicit-any
    const { handler: _, ...rest } = def as Record<string, any>;
    apiDefWithoutHandlers[method as HttpMethod] = rest;
    // Each function carries its own definition as well: frameworks that
    // take one export per method have no handler object to read it from.
    Object.defineProperty(handlers[method], "__methodDef", { value: rest });
  }

  Object.defineProperty(handlers, "__apiDef", {
    value: apiDefWithoutHandlers,
    enumerable: !options.hiddenApiDef,
    writable: true,
    configurable: true,
  });
  return handlers as unknown as Handlers<TContext, TDef, TRest>;
}

// =============================================================================
// Integrations
// =============================================================================

/**
 * The helpers of a framework integration, typed for the framework's
 * handler signature.
 */
export interface Integration<TContext, TRest extends unknown[] = []> {
  /**
   * Define an API endpoint with full type inference for the handler.
   *
   * Zero runtime cost: returns its argument. It exists so that the schemas
   * type the `validated` argument of the handler.
   */
  endpoint<
    TBodySchema extends z.ZodType | undefined = undefined,
    TQuerySchema extends z.ZodType | undefined = undefined,
    TParamsSchema extends z.ZodType | undefined = undefined,
    TResponseSchema extends z.ZodType | undefined = undefined,
    const TResponses extends ResponsesDef | undefined = undefined,
  >(
    def: HandlerMethodDef<
      TContext,
      TBodySchema,
      TQuerySchema,
      TParamsSchema,
      TResponseSchema,
      TResponses
    >,
  ): HandlerMethodDef<
    TContext,
    TBodySchema,
    TQuerySchema,
    TParamsSchema,
    TResponseSchema,
    TResponses
  >;

  /**
   * Define an SSE endpoint with full type inference.
   *
   * Zero runtime cost: returns its argument.
   */
  sseEndpoint<
    TQuerySchema extends z.ZodType | undefined = undefined,
    TParamsSchema extends z.ZodType | undefined = undefined,
    TEvents extends SseEventDef = SseEventDef,
  >(
    def: HandlerSseMethodDef<TContext, TQuerySchema, TParamsSchema, TEvents>,
  ): HandlerSseMethodDef<TContext, TQuerySchema, TParamsSchema, TEvents>;

  /**
   * Create the framework's handlers, with automatic validation: one
   * function per method, each in the framework's handler signature.
   */
  createApiHandlers<TDef extends Record<string, unknown>>(
    apiDef: TDef,
  ): Handlers<TContext, TDef, TRest>;
}

/**
 * Create the helpers of an integration from how the framework's handler
 * arguments give access to the request.
 *
 * @example
 * ```ts
 * // A framework that calls handlers with (request, { params })
 * const { endpoint, sseEndpoint, createApiHandlers } = defineIntegration<
 *   Request,
 *   [route: { params: Record<string, string> }]
 * >({
 *   request: (request) => request,
 *   params: (_request, route) => route.params,
 * });
 * ```
 */
export function defineIntegration<TContext, TRest extends unknown[] = []>(
  access: RequestAccess<TContext, TRest>,
  options: BuildHandlersOptions = {},
): Integration<TContext, TRest> {
  return {
    endpoint: (def) => def,
    sseEndpoint: (def) => def,
    createApiHandlers: (apiDef) => buildHandlers(apiDef, access, options),
  };
}
