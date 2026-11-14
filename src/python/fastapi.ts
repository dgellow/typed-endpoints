/**
 * A FastAPI module from a contract.
 *
 * The generated module holds:
 *
 * - a Pydantic model for every request part, response and declared error
 *   body of every operation
 * - `Handlers`: a protocol with one method per operation, typed by those
 *   models. The application implements it in a file of its own, so
 *   generating again never overwrites application code, and a type
 *   checker reports a handler that no longer fits the routes
 * - the contract's schema of every request part, as Python data, and
 *   the checker for them (`fastapi_runtime.ts`)
 * - `create_router(handlers)`: an `APIRouter` whose routes check each
 *   request against the contract, call the handler and check what it
 *   returns, as the TypeScript handlers do: a request the contract
 *   refuses is a 400 with `{ error, in, issues }`, in Zod's words; a
 *   value the response model rejects is a 500 and is logged, never sent
 * - `create_app(handlers)`: an application with that router
 *
 * A route function takes the request as it is. FastAPI would validate
 * typed arguments with Pydantic, by other rules than the contract's.
 *
 * @module
 */

import type {
  Contract,
  ContractOperation,
  JsonSchema,
} from "../contract/index.ts";
import {
  assignment,
  docstring,
  fit,
  imports,
  type ImportTable,
  signature,
} from "./format.ts";
import {
  BODY,
  CHECKING,
  CONTRACT,
  DESCRIBED,
  PARAMS,
  QUERY,
  REFUSING,
  TEXT,
} from "./fastapi_runtime.ts";
import { pascalCase, PythonModels, snakeCase } from "./models.ts";
import { schemaLiteral } from "./schema.ts";

/** What the generated module needs to be told. */
export interface FastApiOptions {
  /** Where the routes came from, for the module's docstring. */
  readonly source?: string;
}

/** What the module may import: the names its source uses are imported. */
const IMPORTS: readonly ImportTable[] = [
  [
    ["asyncio", []],
    ["functools", []],
    ["json", []],
    ["logging", []],
    ["math", []],
    ["operator", []],
    ["re", []],
    [
      "collections.abc",
      ["AsyncIterator", "Awaitable", "Callable", "Coroutine"],
    ],
    ["dataclasses", ["dataclass"]],
    [
      "typing",
      ["Annotated", "Any", "Final", "Literal", "Protocol", "cast", "override"],
    ],
    ["urllib.parse", ["unquote_to_bytes"]],
  ],
  [
    ["fastapi", ["APIRouter", "FastAPI", "Request"]],
    ["fastapi.responses", ["JSONResponse", "Response", "StreamingResponse"]],
    ["fastapi.routing", ["APIRoute"]],
    [
      "pydantic",
      ["BaseModel", "ConfigDict", "Field", "TypeAdapter", "ValidationError"],
    ],
    ["pydantic.alias_generators", ["to_camel"]],
  ],
];

/** `SafeInt`, written when a model uses it. */
const SAFE_INT = `
# An integer JavaScript represents exactly: what Zod's int() accepts.
SafeInt = Annotated[int, Field(ge=-9007199254740991, le=9007199254740991)]
`.trim();

/** Fixed part of the module: what the models and the handlers share. */
const PRELUDE = `
logger = logging.getLogger("typed_endpoints")


@dataclass(frozen=True)
class Fail[StatusT: int, BodyT]:
    """An error response the operation declares: its status and its body."""

    status: StatusT
    body: BodyT


class InvalidRequestIssue(BaseModel):
    """One thing a request got wrong."""

    path: list[str | int]
    message: str
    code: str


class InvalidRequest(BaseModel):
    """The answer to a request that is refused before it reaches its handler.

    A 400 for a part the contract does not accept, or for a body that is not
    JSON; a 415 for a body that does not claim to be.
    """

    model_config = ConfigDict(populate_by_name=True)

    error: str
    part: Literal["body", "query", "params", "json", "content-type"] = Field(
        validation_alias="in", serialization_alias="in"
    )
    issues: list[InvalidRequestIssue]
`.trim();

/** Fixed part of the module: the 500 that says nothing about its cause. */
const INTERNAL_ERROR = `
def _internal_error() -> JSONResponse:
    return JSONResponse({"error": "Internal Server Error"}, status_code=500)
`.trim();

/** Fixed part of the module: a value as JSON, after its model checked it. */
const DUMP = `
def _dump(adapter: TypeAdapter[Any], value: object) -> object:
    """Write a value as JSON, after its model checked it.

    Pydantic does not validate a model instance again, so one that was
    built unchecked or changed after it was built would be sent as it is.
    The value is taken apart first and validated as plain data. Fields
    that were not set stay absent: absent and null are different.
    """
    plain = adapter.dump_python(
        value, by_alias=True, exclude_unset=True, warnings=False
    )
    return adapter.dump_python(
        adapter.validate_python(plain),
        mode="json",
        by_alias=True,
        exclude_unset=True,
    )
`.trim();

/** Fixed part of the module: what a handler returned, as the response. */
const RESPONSES = `
def _failure(
    where: str, failure: Fail[int, object], errors: dict[int, TypeAdapter[Any]]
) -> Response:
    """Turn a failure a handler returned into the response of its status."""
    declared = errors.get(failure.status)
    if declared is None:
        logger.error(
            "%s: the handler failed with status %s, which the operation "
            "does not declare",
            where,
            failure.status,
        )
        return _internal_error()
    try:
        return JSONResponse(_dump(declared, failure.body), status_code=failure.status)
    except ValidationError:
        logger.exception(
            "%s: the body of the %s failure does not match its schema",
            where,
            failure.status,
        )
        return _internal_error()


async def _respond(
    where: str,
    pending: Awaitable[object],
    response: TypeAdapter[Any] | None,
    errors: dict[int, TypeAdapter[Any]],
) -> Response:
    """Turn what a handler returned into the response of the operation."""
    result = await pending
    if isinstance(result, Response):
        return result
    if isinstance(result, Fail):
        return _failure(where, cast("Fail[int, object]", result), errors)
    if response is None:
        return Response(status_code=204) if result is None else JSONResponse(result)
    try:
        return JSONResponse(_dump(response, result))
    except ValidationError:
        logger.exception(
            "%s: the returned value does not match the response schema", where
        )
        return _internal_error()
`.trim();

/** Fixed part of the module: what the handler of a stream yields, as frames. */
const STREAMS = `
class EventError(ValueError):
    """A handler yielded an event that cannot be written to its stream."""


# What the task that runs a handler's generator puts after its last event.
_END = object()
_FAILED = object()


def _frame(event: object, events: dict[str, TypeAdapter[Any]]) -> str:
    """Write one event in text/event-stream framing, after its model checked it."""
    name = getattr(event, "event", None)
    data = events.get(name) if isinstance(name, str) else None
    if data is None:
        message = f"the handler yielded an event the stream does not declare: {name!r}"
        raise EventError(message)
    lines = [f"event: {name}"]
    # An empty id is meaningful: it resets the client's last event id.
    identifier = getattr(event, "id", None)
    if identifier is not None:
        # A line break would end the field, and the frame with it.
        if any(character in str(identifier) for character in "\\r\\n\\0"):
            message = f"the id of the event {name!r} has a line break: {identifier!r}"
            raise EventError(message)
        lines.append(f"id: {identifier}")
    retry = getattr(event, "retry", None)
    if retry is not None:
        if int(retry) < 0:
            message = f"the retry of the event {name!r} is negative: {retry!r}"
            raise EventError(message)
        lines.append(f"retry: {int(retry)}")
    payload = json.dumps(
        _dump(data, getattr(event, "data", None)),
        separators=(",", ":"),
        ensure_ascii=False,
    )
    lines.append(f"data: {payload}")
    return "\\n".join(lines) + "\\n\\n"


async def _produce(
    where: str, source: AsyncIterator[object], queue: asyncio.Queue[object]
) -> None:
    """Run a handler's generator from its start to its end, in one task.

    What the handler holds across a \`yield\` (a timeout, a context variable)
    stays in the task that entered it, and the generator is closed here, not
    when the garbage collector finds it.
    """
    try:
        try:
            async for event in source:
                await queue.put(event)
        finally:
            close = getattr(source, "aclose", None)
            if close is not None:
                await close()
    except Exception:
        logger.exception("%s: SSE stream error", where)
        await queue.put(_FAILED)
    else:
        await queue.put(_END)


async def _frames(
    where: str,
    source: AsyncIterator[object],
    events: dict[str, TypeAdapter[Any]],
    keep_alive: float | None,
) -> AsyncIterator[str]:
    # One event at a time: the handler is not asked for the next one before
    # this one is written.
    queue: asyncio.Queue[object] = asyncio.Queue(maxsize=1)
    producer = asyncio.create_task(_produce(where, source, queue))
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), keep_alive)
            except TimeoutError:
                # A comment: ignored by clients, seen by intermediaries.
                yield ": keep-alive\\n\\n"
                continue
            if event is _END:
                return
            frame = None
            if event is not _FAILED:
                try:
                    frame = _frame(event, events)
                except (ValidationError, ValueError):
                    logger.exception("%s: SSE stream error", where)
            if frame is None:
                # A stream has no status once it has begun. The stream ends
                # here, after a comment: the handler failed, or yielded an
                # event that cannot be written, which is never sent. A client
                # that reconnects asks for what follows the last event it has.
                yield ": error\\n\\n"
                return
            yield frame
    finally:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)


def _stream(
    where: str,
    source: AsyncIterator[object],
    events: dict[str, TypeAdapter[Any]],
    keep_alive: float | None,
) -> StreamingResponse:
    """Send the events a handler yields as a text/event-stream response."""
    return StreamingResponse(
        _frames(where, source, events, keep_alive),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )
`.trim();

/** Fixed part of the module: the application. */
const APP = `
def create_app(handlers: Handlers) -> FastAPI:
    """Make an application that serves the operations with the given handlers."""
    app = FastAPI()
    app.include_router(create_router(handlers))
    return app
`.trim();

/** One operation, with the Python names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  /** `GET /notes/{id}`. */
  readonly label: string;
  /** Name of the handler method and of the route function. */
  readonly method: string;
  readonly params?: string;
  readonly query?: string;
  readonly body?: string;
  /**
   * The constant that holds each request part: the contract's schema of
   * it and its type.
   */
  readonly parts: {
    readonly params?: string;
    readonly query?: string;
    readonly body?: string;
  };
  readonly response?: string;
  /** Declared error bodies by status: their type expressions. */
  readonly errors: ReadonlyMap<string, string>;
  /** What the handler returns: the name of that type. */
  readonly result: string;
  /** For an event stream: the type of its events. */
  readonly stream?: {
    /** Name of the union of the event classes. */
    readonly events: string;
    /** The type of each event's data, by event name. */
    readonly data: ReadonlyMap<string, string>;
    /** Seconds of silence before a keep-alive comment. */
    readonly keepAlive?: number;
  };
}

/** `/files/{+path}` as FastAPI writes it: `/files/{path:path}`. */
function fastApiPath(path: string): string {
  return path.replace(/\{\+(\w+)\}/g, "{$1:path}");
}

/** A banner between the parts of the module. */
function banner(title: string): string[] {
  const rule = `# ${"=".repeat(77)}`;
  return [rule, `# ${title}`, rule, "", ""];
}

/**
 * Render a contract as the source of a Python module.
 *
 * An operation that streams server-sent events has a handler that is an
 * async iterator of typed events.
 */
export function renderFastApi(
  contract: Contract,
  options: FastApiOptions = {},
): string {
  const models = new PythonModels();
  const rendered: Rendered[] = [];
  /** The event classes of the streams: defined after the models. */
  const eventClasses: string[] = [];
  /** What each handler returns: defined after the models. */
  const results: string[] = [];
  /** The request parts as the contract has them: defined after the models. */
  const parts: string[] = [];
  /** The constant of each part already written, by its schema. */
  const written = new Map<string, string>();

  for (const operation of contract.operations) {
    const base = pascalCase(operation.operationId);
    const label = `${operation.method} ${operation.path}`;
    const part = (
      suffix: string,
      role: string,
      schema: JsonSchema | undefined,
      strict: boolean,
    ): string | undefined => {
      if (!schema) return undefined;
      const type = models.define(`${base}${suffix}`, schema, strict);
      models.describe(type, role, label);
      return type;
    };

    // An event stream: one class per event, typed by the event's data.
    let stream: Rendered["stream"];
    if (operation.events) {
      const classes: string[] = [];
      const dataTypes = new Map<string, string>();
      for (const [name, schema] of Object.entries(operation.events)) {
        const data = part(
          `${pascalCase(name)}Data`,
          `data of the event \`${name}\``,
          schema,
          true,
        )!;
        dataTypes.set(name, data);
        const className = `${base}${pascalCase(name)}Event`;
        classes.push(className);
        eventClasses.push(
          `class ${className}(${models.base(true)}):`,
          ...docstring(4, `The event \`${name}\` of \`${label}\`.`),
          "",
          ...assignment(4, "data", data, undefined),
          ...assignment(
            4,
            "event",
            `Literal[${JSON.stringify(name)}]`,
            JSON.stringify(name),
          ),
          "    id: str | None = None",
          "    retry: int | None = None",
          "",
          "",
        );
      }
      eventClasses.push(
        ...assignment(0, `type ${base}Event`, undefined, classes.join(" | ")),
        "",
        "",
      );
      stream = {
        events: `${base}Event`,
        data: dataTypes,
        ...(operation.keepAlive !== undefined &&
          { keepAlive: operation.keepAlive / 1000 }),
      };
    }

    // Path parameters without a schema are strings.
    const paramsSchema = operation.params ??
      (operation.pathParams.length > 0
        ? {
          type: "object",
          properties: Object.fromEntries(
            operation.pathParams.map(({ name }) => [name, { type: "string" }]),
          ),
          required: operation.pathParams.map(({ name }) => name),
        }
        : undefined);

    // Path and query values arrive as text and are coerced; a body keeps
    // its JSON types, as Zod requires.
    const params = part("Params", "path parameters", paramsSchema, false);
    const query = part("Query", "query", operation.query, false);
    const body = part("Body", "body", operation.body, true);

    // What the contract says each part is, beside its type. Operations
    // that take the same part share it, as they share the type.
    const constant = (
      suffix: string,
      type: string | undefined,
      schema: JsonSchema | undefined,
    ): string | undefined => {
      if (!type || !schema) return undefined;
      // A body keeps its JSON types and the other parts are coerced: the
      // same schema is two types.
      const key = `${suffix === "BODY"}:${JSON.stringify(schema)}`;
      const name = `_${
        snakeCase(operation.operationId).toUpperCase()
      }_${suffix}`;
      const known = written.get(key);
      if (known !== undefined) {
        // The same part under this operation's name, as the models have
        // the same class under a name per operation.
        parts.push(`${name} = ${known}`);
        return name;
      }
      written.set(key, name);
      parts.push(
        ...assignment(
          0,
          name,
          `_Part[${type}]`,
          `_Part(${schemaLiteral(schema, models)}, TypeAdapter(${type}))`,
        ),
      );
      return name;
    };
    const constants = {
      params: constant("PARAMS", params, paramsSchema),
      query: constant("QUERY", query, operation.query),
      body: constant("BODY", body, operation.body),
    };
    const response = part("Response", "response", operation.response, true);
    const errors = new Map(
      Object.entries(operation.errors ?? {}).map(([status, schema]) => [
        status,
        part(`Error${status}`, `${status} body`, schema, true)!,
      ]),
    );

    // What a handler returns has a name: its annotation stays short.
    const result = `${base}Result`;
    if (!stream) {
      results.push(
        ...assignment(
          0,
          `type ${result}`,
          undefined,
          [
            response ?? "None",
            ...[...errors].map(([status, type]) =>
              `Fail[Literal[${status}], ${type}]`
            ),
            "Response",
          ].join(" | "),
        ),
      );
    }

    rendered.push({
      operation,
      label,
      method: snakeCase(operation.operationId),
      ...(params && { params }),
      ...(query && { query }),
      ...(body && { body }),
      parts: {
        ...(constants.params && { params: constants.params }),
        ...(constants.query && { query: constants.query }),
        ...(constants.body && { body: constants.body }),
      },
      ...(response && { response }),
      errors,
      result,
      ...(stream && { stream }),
    });
  }

  // What the module needs of its fixed part: a block that nothing uses
  // is not written.
  const takes = (part: "params" | "query" | "body") =>
    rendered.some((item) => item.parts[part] !== undefined);
  const reads = takes("params") || takes("query") || takes("body");
  const streams = rendered.some((item) => item.stream);
  const answers = rendered.some((item) => !item.stream);

  // The checker compiles the patterns of the contract, with what the
  // models compile theirs with.
  if (reads) models.compilesPatterns();

  const body: string[] = [
    PRELUDE,
    "",
    "",
    ...banner("Models"),
    ...models.render(),
    ...eventClasses,
    ...banner("Handlers"),
    "# What a handler returns: the response, a failure the operation declares,",
    "# or a response written by hand, which is sent as it is.",
    ...results,
    "",
    "",
    "class Handlers(Protocol):",
    '    """The operations of the API, one method each.',
    "",
    "    A method returns the response value, a `Fail` with a status the",
    "    operation declares, or a `Response`, which is sent as it is. The method",
    "    of an event stream is an async iterator of its events.",
    '    """',
  ];

  for (const item of rendered) {
    body.push("", ...handlerSignature(item));
  }

  if (reads) {
    body.push(
      "",
      "",
      ...banner("Contract"),
      CONTRACT,
      "",
      "",
      "# What the contract says each part of a request is, and the type the part",
      "# has once the contract accepts it.",
      ...parts,
    );
  }

  body.push("", "", ...banner("Router"));
  for (const item of rendered) body.push(...adapters(item));
  // A function per operation adds its route: one function with every
  // route in it grows with the API.
  for (const item of rendered) {
    body.push(
      "",
      "",
      ...signature(
        0,
        `def _add_${item.method}`,
        ["router: APIRouter", "handlers: Handlers"],
        "None",
      ),
      ...route(item),
    );
  }
  body.push(
    "",
    "",
    "def create_router(handlers: Handlers) -> APIRouter:",
    ...docstring(
      4,
      reads
        ? [
          "Make a router whose routes call the given handlers.",
          "",
          "It needs nothing of the application it is included in: a request " +
          "the contract refuses is answered by the router itself.",
        ].join("\n")
        : "Make a router whose routes call the given handlers.",
    ),
    `    router = APIRouter(${reads ? "route_class=_Route" : ""})`,
    ...rendered.map((item) => `    _add_${item.method}(router, handlers)`),
    "    return router",
    "",
    "",
    APP,
  );

  const requests = [
    ...(reads ? [CHECKING, REFUSING] : []),
    ...(takes("params") || takes("query") ? [TEXT] : []),
    ...(takes("body") ? [BODY] : []),
    ...(takes("query") ? [QUERY] : []),
    ...(takes("params") ? [PARAMS] : []),
    ...(reads ? [DESCRIBED] : []),
  ];
  if (requests.length > 0) {
    body.push("", "", ...banner("Requests"), requests.join("\n\n\n"));
  }
  const responses = [
    ...(reads || answers ? [INTERNAL_ERROR] : []),
    DUMP,
    ...(answers ? [RESPONSES] : []),
    ...(streams ? [STREAMS] : []),
  ];
  body.push("", "", ...banner("Responses"), responses.join("\n\n\n"));

  const source = body.join("\n");
  const lines: string[] = [
    ...docstring(
      0,
      [
        `API models, handlers and router${
          options.source ? ` for ${options.source}` : ""
        }.`,
        "",
        "Generated by typed-endpoints. Do not edit: implement `Handlers` in a " +
        "module of your own and pass it to `create_app()` or `create_router()`.",
        "",
        "Needs Python 3.12 and Pydantic 2.12.",
      ].join("\n"),
    ),
    "",
    ...imports(source, IMPORTS),
    "",
    ...(models.usesSafeInt ? [SAFE_INT, ""] : []),
    source,
    "",
  ];
  return lines.join("\n");
}

/** The arguments a handler takes, in a fixed order. */
function handlerArguments(item: Rendered): string[] {
  return [
    ...(item.params ? [`params: ${item.params}`] : []),
    ...(item.query ? [`query: ${item.query}`] : []),
    ...(item.body ? [`body: ${item.body}`] : []),
  ];
}

function handlerSignature(item: Rendered): string[] {
  const { operation } = item;
  if (item.stream) {
    // Not `async def`: an async generator function, called, is the
    // iterator.
    return [
      ...signature(
        4,
        `def ${item.method}`,
        ["self", ...handlerArguments(item), "last_event_id: str | None"],
        `AsyncIterator[${item.stream.events}]`,
      ),
      ...docstring(
        8,
        [
          `Answer \`${item.label}\` with a stream of events.`,
          "",
          "`last_event_id` is the id of the last event a client that " +
          "reconnects received; None on a first connection.",
        ].join("\n"),
      ),
      "        ...",
    ];
  }
  const summary = (operation.summary ?? operation.description)?.trim();
  return [
    ...signature(
      4,
      `async def ${item.method}`,
      ["self", ...handlerArguments(item)],
      item.result,
    ),
    ...docstring(
      8,
      `Answer \`${item.label}\`.${summary ? `\n\n${summary}` : ""}`,
    ),
    "        ...",
  ];
}

/** Module-level adapters: what checks and writes each response. */
function adapters(item: Rendered): string[] {
  const name = item.method.toUpperCase();
  if (item.stream) {
    return assignment(
      0,
      `_${name}_EVENTS`,
      "dict[str, TypeAdapter[Any]]",
      `{${
        [...item.stream.data].map(([event, type]) =>
          `${JSON.stringify(event)}: TypeAdapter(${type})`
        ).join(", ")
      }}`,
    );
  }
  return [
    ...(item.response
      ? assignment(
        0,
        `_${name}_RESPONSE`,
        "TypeAdapter[Any]",
        `TypeAdapter(${item.response})`,
      )
      : []),
    ...assignment(
      0,
      `_${name}_ERRORS`,
      "dict[int, TypeAdapter[Any]]",
      `{${
        [...item.errors].map(([status, type]) =>
          `${status}: TypeAdapter(${type})`
        ).join(", ")
      }}`,
    ),
  ];
}

function route(item: Rendered): string[] {
  const { operation } = item;
  const name = item.method.toUpperCase();
  const decorator = operation.method.toLowerCase();

  // Read in the order the TypeScript handlers check a request: the body,
  // the query, the path. The first part that is refused is the answer.
  const before: string[] = [];
  if (item.parts.body) {
    before.push(
      ...fit(8, "body = ", `await _body(request, ${item.parts.body})`),
    );
  }
  if (item.parts.query) {
    before.push(...fit(8, "query = ", `_query(request, ${item.parts.query})`));
  }
  if (item.parts.params) {
    before.push(
      ...fit(8, "params = ", `_params(request, ${item.parts.params})`),
    );
  }
  const read = Object.keys(item.parts) as ("params" | "query" | "body")[];
  const passed = (["params", "query", "body"] as const)
    .filter((part) => item.parts[part])
    .map((part) => `${part}=${part}`);

  // What the operation answers, for the description FastAPI serves: the
  // success, the declared errors, and the refusals of a request.
  const documented = new Map<number, string>([
    ...(item.response && !item.stream
      ? [[200, item.response] as [number, string]]
      : []),
    ...[...item.errors].map(([status, type]) =>
      [Number(status), type] as [number, string]
    ),
    ...(read.length > 0 ? [[400, "InvalidRequest"] as [number, string]] : []),
    ...(item.parts.body ? [[415, "InvalidRequest"] as [number, string]] : []),
  ]);
  const responses = [...documented]
    .sort(([a], [b]) => a - b)
    .map(([status, type]) => `${status}: {"model": ${type}}`);

  const options = [
    JSON.stringify(fastApiPath(operation.path)),
    `operation_id=${JSON.stringify(operation.operationId)}`,
    item.stream ? "response_class=StreamingResponse" : "response_model=None",
    ...(operation.summary
      ? [`summary=${JSON.stringify(operation.summary)}`]
      : []),
    ...(operation.tags && operation.tags.length > 0
      ? [`tags=${JSON.stringify(operation.tags).replaceAll('","', '", "')}`]
      : []),
    ...(item.stream && responses.length === 0
      ? []
      : [`responses={${responses.join(", ")}}`]),
    // FastAPI describes a request from the arguments of the route
    // function, which takes the request as it is: the contract says what
    // it has to be.
    ...(read.length > 0
      ? [`openapi_extra=_described(${
        (["params", "query", "body"] as const)
          .filter((part) => item.parts[part])
          .map((part) => `${part}=${item.parts[part]}`)
          .join(", ")
      })`]
      : []),
  ];
  const where = JSON.stringify(item.label);
  const taken = read.length > 0 || item.stream ? ["request: Request"] : [];

  if (item.stream) {
    return [
      ...fit(4, "@", `router.${decorator}(${options.join(", ")})`),
      ...signature(4, `async def ${item.method}`, taken, "Response"),
      ...before,
      ...fit(
        8,
        "return ",
        `_stream(${where}, handlers.${item.method}(${
          [...passed, 'last_event_id=request.headers.get("Last-Event-ID")']
            .join(", ")
        }), _${name}_EVENTS, ${item.stream.keepAlive ?? "None"})`,
      ),
    ];
  }

  return [
    ...fit(4, "@", `router.${decorator}(${options.join(", ")})`),
    ...signature(4, `async def ${item.method}`, taken, "Response"),
    ...before,
    ...fit(
      8,
      "return ",
      `await _respond(${where}, handlers.${item.method}(${
        passed.join(", ")
      }), ${item.response ? `_${name}_RESPONSE` : "None"}, _${name}_ERRORS)`,
    ),
  ];
}
