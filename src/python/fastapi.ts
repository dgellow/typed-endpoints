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
 * - `create_router(handlers)`: an `APIRouter` that validates each request,
 *   calls the handler and checks what it returns, as the TypeScript
 *   handlers do: a value the response model rejects is a 500 and is
 *   logged, never sent
 * - `install_error_handlers(app)`: answers a request that fails
 *   validation in the shape the TypeScript server uses, a 400 with
 *   `{ error, in, issues }`
 * - `create_app(handlers)`: the three together
 *
 * @module
 */

import type { Contract, ContractOperation } from "../contract/index.ts";
import { pascalCase, PythonModels, snakeCase } from "./models.ts";

/** What the generated module needs to be told. */
export interface FastApiOptions {
  /** Where the routes came from, for the module's docstring. */
  readonly source?: string;
}

/** Fixed part of the module: imports and the helpers the routes share. */
const PRELUDE = `
import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Annotated, Any, Generic, Literal, Protocol, TypeVar, cast

from fastapi import APIRouter, Body, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

logger = logging.getLogger("typed_endpoints")

StatusT = TypeVar("StatusT", bound=int)
BodyT = TypeVar("BodyT")

# An integer JavaScript represents exactly: what Zod's int() accepts.
SafeInt = Annotated[int, Field(ge=-9007199254740991, le=9007199254740991)]


@dataclass(frozen=True)
class Fail(Generic[StatusT, BodyT]):
    """An error response the operation declares: its status and its body."""

    status: StatusT
    body: BodyT


class InvalidRequestIssue(BaseModel):
    """One thing a request got wrong."""

    path: list[str | int]
    message: str
    code: str


class InvalidRequest(BaseModel):
    """The body of the 400 that answers a request that fails validation."""

    error: str
    part: Literal["body", "query", "params", "json"] = Field(
        validation_alias="in", serialization_alias="in"
    )
    issues: list[InvalidRequestIssue]
`.trimStart();

/** Fixed part of the module: what runs around every handler. */
const RUNTIME = `
_PARTS = {"path": "params", "query": "query", "body": "body"}
_PREFIX = {
    "params": "Params validation error",
    "query": "Query validation error",
    "body": "Validation error",
}


def _describe(issue: dict[str, Any]) -> str:
    path: list[Any] = issue["path"]
    message: str = issue["message"]
    where = ".".join(str(key) for key in path)
    return f"{where}: {message}" if path else message


def _invalid_request(errors: list[dict[str, Any]]) -> JSONResponse:
    """A 400 in the shape the TypeScript server answers with."""
    if any(error.get("type") == "json_invalid" for error in errors):
        return JSONResponse(
            {"error": "Invalid JSON body", "in": "json", "issues": []},
            status_code=400,
        )
    # The part that failed first; its issues, each with the path below it.
    part = _PARTS.get(str(errors[0]["loc"][0]), "body") if errors else "body"
    issues: list[dict[str, Any]] = [
        {
            "path": list(error["loc"][1:]),
            "message": error["msg"],
            "code": error["type"],
        }
        for error in errors
        if _PARTS.get(str(error["loc"][0]), "body") == part
    ]
    listed = ", ".join(_describe(issue) for issue in issues)
    return JSONResponse(
        {"error": f"{_PREFIX[part]}: {listed}", "in": part, "issues": issues},
        status_code=400,
    )


def _parse(model: type[_ModelT], values: dict[str, Any], part: str) -> _ModelT:
    """Path parameters as their model; a failure is a request error."""
    try:
        return model.model_validate(values)
    except ValidationError as error:
        raise RequestValidationError(
            [{**issue, "loc": (part, *issue["loc"])} for issue in error.errors()]
        ) from error


def _internal_error() -> JSONResponse:
    return JSONResponse({"error": "Internal Server Error"}, status_code=500)


def _dump(adapter: TypeAdapter[Any], value: Any) -> Any:
    """A value as JSON, after its model checked it.

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


async def _respond(
    where: str,
    pending: Awaitable[Any],
    response: TypeAdapter[Any] | None,
    errors: dict[int, TypeAdapter[Any]],
) -> Response:
    """Turn what a handler returned into the response of the operation."""
    result = await pending
    if isinstance(result, Response):
        return result

    if isinstance(result, Fail):
        failure = cast("Fail[int, Any]", result)
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
            return JSONResponse(
                _dump(declared, failure.body), status_code=failure.status
            )
        except ValidationError as error:
            logger.error(
                "%s: the body of the %s failure does not match its schema: %s",
                where,
                failure.status,
                error,
            )
            return _internal_error()

    if response is None:
        if result is None:
            return Response(status_code=204)
        return JSONResponse(result)
    try:
        return JSONResponse(_dump(response, result))
    except ValidationError as error:
        logger.error(
            "%s: the returned value does not match the response schema: %s",
            where,
            error,
        )
        return _internal_error()


def _frame(event: Any, events: dict[str, TypeAdapter[Any]]) -> str:
    """One event in text/event-stream framing, after its model checked it."""
    name = getattr(event, "event", None)
    data = events.get(name) if isinstance(name, str) else None
    if data is None:
        raise ValueError(f"the handler yielded an event the stream does not declare: {name!r}")
    lines = [f"event: {name}"]
    # An empty id is meaningful: it resets the client's last event id.
    identifier = getattr(event, "id", None)
    if identifier is not None:
        lines.append(f"id: {identifier}")
    retry = getattr(event, "retry", None)
    if retry is not None:
        lines.append(f"retry: {int(retry)}")
    payload = json.dumps(
        _dump(data, event.data), separators=(",", ":"), ensure_ascii=False
    )
    lines.append(f"data: {payload}")
    return "\\n".join(lines) + "\\n\\n"


async def _frames(
    where: str,
    source: AsyncIterator[Any],
    events: dict[str, TypeAdapter[Any]],
    keep_alive: float | None,
) -> AsyncIterator[str]:
    pending: asyncio.Future[Any] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(source))
            done, _ = await asyncio.wait({pending}, timeout=keep_alive)
            if not done:
                # A comment: ignored by clients, seen by intermediaries.
                yield ": keep-alive\\n\\n"
                continue
            finished, pending = pending, None
            try:
                event = finished.result()
            except StopAsyncIteration:
                return
            yield _frame(event, events)
    except Exception as error:
        # A stream has no status once it has begun. The comment tells a
        # client that the stream ended because the handler failed, or
        # yielded an event its model rejects; the event is never sent.
        logger.error("%s: SSE stream error: %s", where, error)
        yield ": error\\n\\n"
    finally:
        if pending is not None:
            pending.cancel()


def _stream(
    where: str,
    source: AsyncIterator[Any],
    events: dict[str, TypeAdapter[Any]],
    keep_alive: float | None,
) -> StreamingResponse:
    """The events a handler yields as a text/event-stream response."""
    return StreamingResponse(
        _frames(where, source, events, keep_alive),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


def install_error_handlers(app: FastAPI) -> None:
    """Answer a request that fails validation with a 400 that names the part
    that failed and each issue."""

    async def invalid_request(_request: Request, error: Exception) -> Response:
        assert isinstance(error, RequestValidationError)
        return _invalid_request(list(error.errors()))

    app.add_exception_handler(RequestValidationError, invalid_request)

    # The description FastAPI gives of the application says the same: no
    # operation answers the 422 FastAPI would send by itself.
    describe = app.openapi

    def openapi() -> dict[str, Any]:
        schema = describe()
        for path in schema.get("paths", {}).values():
            for operation in path.values():
                if isinstance(operation, dict):
                    responses = cast("dict[str, Any]", operation).get("responses")
                    if isinstance(responses, dict):
                        cast("dict[str, Any]", responses).pop("422", None)
        return schema

    setattr(app, "openapi", openapi)


def create_app(handlers: Handlers) -> FastAPI:
    """An application that serves the operations with the given handlers."""
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(create_router(handlers))
    return app
`.trimStart();

/** One operation, with the Python names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  /** Name of the handler method and of the route function. */
  readonly method: string;
  readonly params?: string;
  readonly query?: string;
  readonly body?: string;
  readonly response?: string;
  /** Declared error bodies by status: their type expressions. */
  readonly errors: ReadonlyMap<string, string>;
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

  for (const operation of contract.operations) {
    const base = pascalCase(operation.operationId);

    // An event stream: one class per event, typed by the event's data.
    let stream: Rendered["stream"];
    if (operation.events) {
      const classes: string[] = [];
      const dataTypes = new Map<string, string>();
      for (const [name, schema] of Object.entries(operation.events)) {
        const data = models.define(
          `${base}${pascalCase(name)}Data`,
          schema,
          true,
        );
        dataTypes.set(name, data);
        const className = `${base}${pascalCase(name)}Event`;
        classes.push(className);
        eventClasses.push(
          `class ${className}(BaseModel):`,
          `    """The event \`${name}\` of ${operation.method} ${operation.path}."""`,
          "",
          "    model_config = ConfigDict(strict=True)",
          `    data: ${data}`,
          `    event: Literal[${JSON.stringify(name)}] = ${
            JSON.stringify(name)
          }`,
          "    id: str | None = None",
          "    retry: int | None = None",
          "",
          "",
        );
      }
      eventClasses.push(`${base}Event = ${classes.join(" | ")}`, "", "");
      stream = {
        events: `${base}Event`,
        data: dataTypes,
        ...(operation.keepAlive !== undefined &&
          { keepAlive: operation.keepAlive / 1000 }),
      };
    }

    // Path parameters without a schema are strings.
    const params = operation.params ??
      (operation.pathParams.length > 0
        ? {
          type: "object",
          properties: Object.fromEntries(
            operation.pathParams.map(({ name }) => [name, { type: "string" }]),
          ),
          required: operation.pathParams.map(({ name }) => name),
        }
        : undefined);

    rendered.push({
      operation,
      method: snakeCase(operation.operationId),
      // Path and query values arrive as text and are coerced; a body
      // keeps its JSON types, as Zod requires.
      ...(params && {
        params: models.define(`${base}Params`, params, false),
      }),
      ...(operation.query && {
        query: models.define(`${base}Query`, operation.query, false),
      }),
      ...(operation.body && {
        body: models.define(`${base}Body`, operation.body, true),
      }),
      ...(operation.response && {
        response: models.define(`${base}Response`, operation.response, true),
      }),
      errors: new Map(
        Object.entries(operation.errors ?? {}).map(([status, schema]) => [
          status,
          models.define(`${base}Error${status}`, schema, true),
        ]),
      ),
      ...(stream && { stream }),
    });
  }

  const lines: string[] = [
    `"""API models, handlers and router${
      options.source ? ` for ${options.source}` : ""
    }.`,
    "",
    "Generated by typed-endpoints. Do not edit: implement \\`Handlers\\` in a",
    "module of your own and pass it to \\`create_app()\\` or \\`create_router()\\`.",
    ...(models.usesTypeStatement
      ? [
        "",
        "Needs Python 3.12: a type that refers to itself is a \\`type\\` statement.",
      ]
      : []),
    '"""',
    "",
    PRELUDE,
    "",
    '_ModelT = TypeVar("_ModelT", bound=BaseModel)',
    "",
    "",
    "# " + "=".repeat(77),
    "# Models",
    "# " + "=".repeat(77),
    "",
    "",
    ...models.render(),
    ...eventClasses,
    "# " + "=".repeat(77),
    "# Handlers",
    "# " + "=".repeat(77),
    "",
    "",
    "class Handlers(Protocol):",
    '    """One method per operation. A method returns the response value, a',
    "    `Fail` with a status the operation declares, or a `Response`, which is",
    "    sent as it is. The method of an event stream is an async iterator of",
    '    its events."""',
  ];

  for (const item of rendered) {
    lines.push("", ...handlerSignature(item));
  }
  if (rendered.length === 0) lines.push("", "    pass");

  lines.push(
    "",
    "",
    "# " + "=".repeat(77),
    "# Router",
    "# " + "=".repeat(77),
    "",
    "",
  );
  for (const item of rendered) lines.push(...adapters(item));
  lines.push(
    "",
    "",
    "def create_router(handlers: Handlers) -> APIRouter:",
    '    """The operations as routes that call the given handlers."""',
    "    router = APIRouter()",
  );
  for (const item of rendered) lines.push("", ...route(item));
  lines.push("", "    return router", "", "", RUNTIME);

  return lines.join("\n").replaceAll("\\`", "`");
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
      `    def ${item.method}(`,
      "        self,",
      ...handlerArguments(item).map((argument) => `        ${argument},`),
      "        last_event_id: str | None,",
      `    ) -> AsyncIterator[${item.stream.events}]:`,
      `        """${operation.method} ${operation.path}: a stream of events.`,
      "",
      "        `last_event_id` is the id of the last event a client that",
      '        reconnects received; None on a first connection."""',
      "        ...",
    ];
  }
  const returns = [
    item.response ?? "None",
    ...[...item.errors].map(([status, type]) =>
      `Fail[Literal[${status}], ${type}]`
    ),
    "Response",
  ];
  const summary = operation.summary ?? operation.description;
  return [
    `    async def ${item.method}(`,
    "        self,",
    ...handlerArguments(item).map((argument) => `        ${argument},`),
    `    ) -> ${returns.join(" | ")}:`,
    `        """${operation.method} ${operation.path}${
      summary ? `: ${summary.replaceAll('"""', "'''")}` : ""
    }"""`,
    "        ...",
  ];
}

/** Module-level adapters: what checks and writes each response. */
function adapters(item: Rendered): string[] {
  const name = item.method.toUpperCase();
  if (item.stream) {
    return [
      `_${name}_EVENTS: dict[str, TypeAdapter[Any]] = {${
        [...item.stream.data].map(([event, type]) =>
          `${JSON.stringify(event)}: TypeAdapter(${type})`
        ).join(", ")
      }}`,
    ];
  }
  return [
    ...(item.response
      ? [`_${name}_RESPONSE: TypeAdapter[Any] = TypeAdapter(${item.response})`]
      : []),
    `_${name}_ERRORS: dict[int, TypeAdapter[Any]] = {${
      [...item.errors].map(([status, type]) =>
        `${status}: TypeAdapter(${type})`
      ).join(", ")
    }}`,
  ];
}

function route(item: Rendered): string[] {
  const { operation } = item;
  const name = item.method.toUpperCase();
  const decorator = operation.method.toLowerCase();

  const taken: string[] = [];
  const passed: string[] = [];
  const before: string[] = [];
  if (item.params) {
    for (const { name: param } of operation.pathParams) {
      taken.push(`${snakeCase(param)}: str`);
    }
    const values = operation.pathParams
      .map(({ name: param }) => `${JSON.stringify(param)}: ${snakeCase(param)}`)
      .join(", ");
    before.push(
      `        params = _parse(${item.params}, {${values}}, "path")`,
    );
    passed.push("params=params");
  }
  if (item.query) {
    taken.push(`query: Annotated[${item.query}, Query()]`);
    passed.push("query=query");
  }
  if (item.body) {
    taken.push(`body: Annotated[${item.body}, Body()]`);
    passed.push("body=body");
  }

  // What the operation answers, for the description FastAPI serves: the
  // success, the declared errors, and the 400 of a failed validation.
  const documented = [
    ...(item.response ? [`200: {"model": ${item.response}}`] : []),
    ...(taken.length > 0 ? ['400: {"model": InvalidRequest}'] : []),
    ...[...item.errors].map(([status, type]) =>
      `${status}: {"model": ${type}}`
    ),
  ];

  const tags = operation.tags && operation.tags.length > 0
    ? `, tags=${JSON.stringify(operation.tags)}`
    : "";
  const summary = operation.summary
    ? `, summary=${JSON.stringify(operation.summary)}`
    : "";

  if (item.stream) {
    const invalid = taken.length > 0
      ? ', responses={400: {"model": InvalidRequest}}'
      : "";
    return [
      `    @router.${decorator}(`,
      `        ${JSON.stringify(fastApiPath(operation.path))},`,
      `        operation_id=${
        JSON.stringify(operation.operationId)
      }, response_class=StreamingResponse${summary}${tags}${invalid},`,
      "    )",
      `    async def ${item.method}(${
        ["request: Request", ...taken].join(", ")
      }) -> Response:`,
      ...before,
      "        return _stream(",
      `            ${JSON.stringify(`${operation.method} ${operation.path}`)},`,
      `            handlers.${item.method}(${
        [...passed, 'last_event_id=request.headers.get("Last-Event-ID")']
          .join(", ")
      }),`,
      `            _${name}_EVENTS,`,
      `            ${item.stream.keepAlive ?? "None"},`,
      "        )",
    ];
  }

  return [
    `    @router.${decorator}(`,
    `        ${JSON.stringify(fastApiPath(operation.path))},`,
    `        operation_id=${
      JSON.stringify(operation.operationId)
    }, response_model=None${summary}${tags},`,
    `        responses={${documented.join(", ")}},`,
    "    )",
    `    async def ${item.method}(${taken.join(", ")}) -> Response:`,
    ...before,
    "        return await _respond(",
    `            ${JSON.stringify(`${operation.method} ${operation.path}`)},`,
    `            handlers.${item.method}(${passed.join(", ")}),`,
    `            ${item.response ? `_${name}_RESPONSE` : "None"},`,
    `            _${name}_ERRORS,`,
    "        )",
  ];
}
