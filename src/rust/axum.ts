/**
 * An axum module from a contract.
 *
 * The generated module holds, in this order:
 *
 * - a serde type for every request part, response and declared error body
 * - an error enum per operation that declares errors, one variant per
 *   status, named as the status is: a handler returns
 *   `Result<Response, Error>`, and a status the operation does not
 *   declare cannot be written
 * - `Handlers`: a trait with one method per operation. The application
 *   implements it in a module of its own; a method that is missing or no
 *   longer fits the routes does not compile
 * - `router(handlers)`: an `axum::Router` that checks each request
 *   against the contract, calls the handler and checks what it returns
 * - two private modules: the contract as static data, and the runtime
 *   that checks values against it
 *
 * The source is written as rustfmt writes it, and without what
 * `clippy::pedantic` would flag.
 *
 * @module
 */

import type {
  Contract,
  ContractOperation,
  JsonSchema,
} from "../contract/index.ts";
import { pascalCase, TypeGraph } from "../contract/types.ts";
import { RustContract } from "./contract.ts";
import {
  constantCase,
  documentation,
  RustModels,
  snakeCase,
  wrapped,
} from "./models.ts";
import {
  EVENTS,
  INTERNAL_ERROR,
  MAYBE_ABSENT,
  RUNTIME,
  STREAMS,
} from "./runtime.ts";

/** What the generated module needs to be told. */
export interface AxumOptions {
  /** Where the routes came from, for the module's documentation. */
  readonly source?: string;
}

/** The constants `http::StatusCode` has, by status. */
const STATUS_NAMES: Readonly<Record<string, string>> = {
  300: "MULTIPLE_CHOICES",
  301: "MOVED_PERMANENTLY",
  302: "FOUND",
  303: "SEE_OTHER",
  304: "NOT_MODIFIED",
  307: "TEMPORARY_REDIRECT",
  308: "PERMANENT_REDIRECT",
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  406: "NOT_ACCEPTABLE",
  407: "PROXY_AUTHENTICATION_REQUIRED",
  408: "REQUEST_TIMEOUT",
  409: "CONFLICT",
  410: "GONE",
  411: "LENGTH_REQUIRED",
  412: "PRECONDITION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  414: "URI_TOO_LONG",
  415: "UNSUPPORTED_MEDIA_TYPE",
  416: "RANGE_NOT_SATISFIABLE",
  417: "EXPECTATION_FAILED",
  418: "IM_A_TEAPOT",
  421: "MISDIRECTED_REQUEST",
  422: "UNPROCESSABLE_ENTITY",
  423: "LOCKED",
  424: "FAILED_DEPENDENCY",
  425: "TOO_EARLY",
  426: "UPGRADE_REQUIRED",
  428: "PRECONDITION_REQUIRED",
  429: "TOO_MANY_REQUESTS",
  431: "REQUEST_HEADER_FIELDS_TOO_LARGE",
  451: "UNAVAILABLE_FOR_LEGAL_REASONS",
  500: "INTERNAL_SERVER_ERROR",
  501: "NOT_IMPLEMENTED",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
  505: "HTTP_VERSION_NOT_SUPPORTED",
  507: "INSUFFICIENT_STORAGE",
  508: "LOOP_DETECTED",
  511: "NETWORK_AUTHENTICATION_REQUIRED",
};

/** A declared error of an operation. */
interface DeclaredError {
  readonly status: string;
  /** The type of its body. */
  readonly type: string;
  /** The variant of the operation's error enum: the status by name. */
  readonly variant: string;
  /** The status as a `StatusCode` expression. */
  readonly code: string;
  /** The static that holds the schema of its body. */
  readonly schema: string;
}

/** One operation, with the Rust names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  /** `GET /notes/{id}`. */
  readonly label: string;
  /** Name of the handler method and of the route function. */
  readonly method: string;
  /** The static that describes the operation. */
  readonly constant: string;
  readonly params?: string;
  readonly query?: string;
  readonly body?: string;
  readonly response?: string;
  readonly errors: readonly DeclaredError[];
  /** Name of the error enum, when the operation declares errors. */
  readonly errorEnum?: string;
  /** For an event stream: its events. */
  readonly stream?: {
    /** Name of the enum of its events. */
    readonly events: string;
    readonly variants: readonly {
      /** The name of the event on the wire. */
      readonly name: string;
      readonly variant: string;
      /** The type of its data. */
      readonly type: string;
      /** The static that holds the schema of its data. */
      readonly schema: string;
    }[];
    /** Milliseconds of silence before a keep-alive comment. */
    readonly keepAlive?: number;
  };
}

/** `/files/{+path}` as axum writes it: `/files/{*path}`. */
function axumPath(path: string): string {
  return path.replace(/\{\+(\w+)\}/g, "{*$1}");
}

/** A banner between the parts of the module. */
function banner(title: string): string[] {
  const rule = `// ${"-".repeat(77)}`;
  return [rule, `// ${title}`, rule, ""];
}

/**
 * Render a contract as the source of a Rust module.
 *
 * An operation that streams server-sent events has a handler that
 * returns a stream of typed events.
 */
export function renderAxum(
  contract: Contract,
  options: AxumOptions = {},
): string {
  // One type for both sides of a schema: the runtime checks what differs.
  const graph = new TypeGraph({ mergeSides: true });
  const models = new RustModels(graph);
  const data = new RustContract();
  const rendered: Rendered[] = [];

  for (const operation of contract.operations) {
    const label = `${operation.method} ${operation.path}`;
    const base = pascalCase(operation.operationId);
    const constant = constantCase(operation.operationId);
    const part = (
      suffix: string,
      role: string,
      schema: JsonSchema | undefined,
      text: boolean,
    ): { type: string; schema: string } | undefined => {
      if (!schema) return undefined;
      const type = models.type(graph.define(`${base}${suffix}`, schema, text));
      models.describe(type, role, label);
      return {
        type,
        schema: data.define(`${constant}_${constantCase(suffix)}`, schema),
      };
    };

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

    const params = part("Params", "path parameters", paramsSchema, true);
    const query = part("Query", "query", operation.query, true);
    const body = part("Body", "body", operation.body, false);
    const response = part("Response", "response", operation.response, false);
    const errors = Object.entries(operation.errors ?? {}).map(
      ([status, schema]) => {
        const name = STATUS_NAMES[status];
        return {
          status,
          ...part(`Error${status}`, `${status} body`, schema, false)!,
          variant: name ? pascalCase(name.toLowerCase()) : `Status${status}`,
          code: name ? `StatusCode::${name}` : `status(${status})`,
        };
      },
    );

    // An event stream: an enum with a variant per event, each with the
    // type of that event's data.
    const used = new Set<string>();
    const stream = operation.events && {
      events: `${base}Event`,
      variants: Object.entries(operation.events).map(([name, schema], i) => {
        let variant = pascalCase(name).replace(/^_/, "Event");
        if (variant === "" || used.has(variant)) variant = `Event${i + 1}`;
        used.add(variant);
        return {
          name,
          variant,
          ...part(
            `${pascalCase(name)}Data`,
            `data of the event \`${name}\``,
            schema,
            false,
          )!,
        };
      }),
      ...(operation.keepAlive !== undefined &&
        { keepAlive: operation.keepAlive }),
    };

    rendered.push({
      operation,
      label,
      method: snakeCase(operation.operationId),
      constant: data.operation(constant, {
        label,
        params: params?.schema,
        query: query?.schema,
        body: body?.schema,
        response: response?.schema,
      }),
      ...(params && { params: params.type }),
      ...(query && { query: query.type }),
      ...(body && { body: body.type }),
      ...(response && { response: response.type }),
      errors,
      ...(errors.length > 0 && { errorEnum: `${base}Error` }),
      ...(stream && { stream }),
    });
  }

  // Rendered first: what the types use decides what is imported.
  const types = models.render();
  const failing = rendered.filter((item) => item.errorEnum);
  const streaming = rendered.filter((item) => item.stream);
  const unnamed = failing.some((item) =>
    item.errors.some((error) => error.code.startsWith("status("))
  );

  const lines: string[] = [
    `//! The API${
      options.source ? ` of \`${options.source}\`` : ""
    }: its types,`,
    "//! [`Handlers`] and [`router`].",
    "//!",
    "//! Generated by typed-endpoints from the schemas of the routes. Do not",
    "//! edit: implement [`Handlers`] in a module of your own and pass it to",
    "//! [`router`]. A request reaches a handler once it fits the contract,",
    "//! as the type the handler takes; what a handler returns is checked",
    "//! against the contract before it is sent.",
    "//!",
    "//! # Crates",
    "//!",
    "//! `axum` 0.8, `serde` with `derive`, `serde_json`, `tracing`, and",
    ...(streaming.length > 0
      ? [
        "//! `fancy-regex` for the patterns of the contract; `futures-core` for",
        "//! the event streams.",
      ]
      : ["//! `fancy-regex` for the patterns of the contract."]),
    "//!",
    "//! # Types",
    "//!",
    "//! A type says what Rust's types can say; a field's documentation says",
    "//! what else the contract requires of it, which is checked on the way in",
    "//! and on the way out. A member that is an `Option` is left out when it",
    "//! is `None`, unless its documentation says it is written `null`.",
    "//!",
    "//! # Answers",
    "//!",
    "//! | Status | When | Body |",
    "//! | --- | --- | --- |",
    "//! | 200 | the handler returned a response | the response |",
    "//! | 204 | the operation has no response | none |",
    "//! | a declared status | the handler returned that error | its body |",
    "//! | 400 | the request does not fit the contract | see below |",
    '//! | 415 | the body is not JSON | `{"error": "..."}` |',
    '//! | 500 | the handler failed or broke the contract | `{"error": "Internal Server Error"}` |',
    "//!",
    "//! A 400 names the part of the request and every issue with it:",
    "//!",
    "//! ```json",
    "//! {",
    '//!   "error": "Validation error: tags: Too big: expected array to have <=4 items",',
    '//!   "in": "body",',
    '//!   "issues": [',
    "//!     {",
    '//!       "code": "too_big",',
    '//!       "message": "Too big: expected array to have <=4 items",',
    '//!       "path": ["tags"]',
    "//!     }",
    "//!   ]",
    "//! }",
    "//! ```",
    "//!",
    "//! The cause of a 500 is not in its body. It is reported through",
    "//! `tracing`, at the error level: an application without a subscriber",
    "//! sees nothing.",
    ...(streaming.length > 0
      ? [
        "//!",
        "//! # Event streams",
        "//!",
        "//! The handler of a stream returns an [`EventStream`] of its events. An",
        "//! event is written once its data fits the contract. When the handler",
        "//! fails, or yields an event that does not fit, the stream ends with",
        "//! the comment `: error`: a stream has no status once it has begun.",
      ]
      : []),
    "",
    ...imports(rendered, models),
    "",
    ...banner("Types"),
    ...types,
    ...(models.usesMaybeAbsent ? [MAYBE_ABSENT, ""] : []),
    ...(streaming.length > 0 ? [EVENTS, ""] : []),
    ...streaming.flatMap((item) => eventEnum(item)),
    ...banner("Handlers"),
    INTERNAL_ERROR,
    "",
    ...failing.flatMap((item) => errorEnum(item, graph)),
    "/// The operations of the API, one method each.",
    "///",
    "/// A method returns the response, or fails. What an operation declares as",
    "/// an error is a variant of its error type, named as the status is; any",
    "/// other failure is an [`InternalError`], which every error converts into.",
    "pub trait Handlers: Send + Sync + 'static {",
  ];
  rendered.forEach((item, i) => {
    if (i > 0) lines.push("");
    lines.push(...handlerSignature(item));
  });
  lines.push("}", "");

  // Written before the router: what it does depends on the contract.
  const contractModule = data.render();
  lines.push(...banner("Router"), ...router(rendered, data.hasPatterns), "");
  for (const item of rendered) lines.push(...route(item), "");
  if (unnamed) {
    lines.push(
      "/// A status that has no name.",
      "fn status(code: u16) -> StatusCode {",
      "    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)",
      "}",
      "",
    );
  }
  lines.push(...contractModule, "", RUNTIME, "");
  if (streaming.length > 0) lines.push(STREAMS, "");

  return lines.join("\n");
}

/** The `use` lines of the module: only what its code names. */
function imports(rendered: readonly Rendered[], models: RustModels): string[] {
  const group = (path: string, names: string[]) =>
    names.length === 0
      ? []
      : names.length === 1
      ? [`use ${path}::${names[0]};`]
      : [`use ${path}::{${names.sort().join(", ")}};`];
  const any = (test: (item: Rendered) => boolean) => rendered.some(test);
  const failing = any((item) => item.errorEnum !== undefined);
  const streaming = any((item) => item.stream !== undefined);
  const silent = any((item) => !item.response && !item.stream);
  const methods = [
    ...new Set(rendered.map((item) => item.operation.method.toLowerCase())),
  ];

  return [
    ...group("std::collections", [
      ...(models.usesMap ? ["BTreeMap"] : []),
      ...(any((item) => !!item.params) ? ["HashMap"] : []),
    ]),
    "use std::fmt;",
    "use std::future::Future;",
    ...(streaming ? ["use std::pin::Pin;"] : []),
    "use std::sync::Arc;",
    ...(streaming ? ["use std::time::Duration;"] : []),
    "",
    ...(any((item) => !!item.body) ? ["use axum::body::Bytes;"] : []),
    ...group("axum::extract::rejection", [
      ...(any((item) => !!item.body) ? ["BytesRejection"] : []),
      ...(any((item) => !!item.params) ? ["PathRejection"] : []),
    ]),
    ...group("axum::extract", [
      ...(any((item) => !!item.params) ? ["Path"] : []),
      ...(any((item) => !!item.query) ? ["Query"] : []),
      "State",
    ]),
    ...group("axum::http", [
      ...(any((item) => !!item.body) || streaming ? ["HeaderMap"] : []),
      ...(failing || silent ? ["StatusCode"] : []),
    ]),
    ...group("axum::response", [
      ...(silent ? ["IntoResponse"] : []),
      "Response",
    ]),
    ...group("axum::routing", methods),
    ...(streaming ? ["use futures_core::Stream;"] : []),
    "use serde::{Deserialize, Serialize};",
    ...(models.usesValue ? ["use serde_json::Value;"] : []),
  ];
}

/** What a handler returns: the response, or how it failed. */
function returns(item: Rendered): string {
  return `Result<${item.response ?? "()"}, ${
    item.errorEnum ?? "InternalError"
  }>`;
}

function errorEnum(item: Rendered, graph: TypeGraph): string[] {
  const name = item.errorEnum!;
  // A body converts into the error when its type says which variant it
  // is: a type of this module, in one variant only. Anything else (a
  // string, a number) already converts into `InternalError`.
  const defined = (type: string) =>
    graph.definitions.some((definition) => definition.name === type);
  const bodies = item.errors.map((error) =>
    graph.object(error.type)?.name ?? error.type
  );
  const convertible = item.errors.filter((error, i) =>
    defined(error.type) && bodies.indexOf(bodies[i]) === bodies.lastIndexOf(
        bodies[i],
      )
  );

  return [
    `/// How \`${item.label}\` fails: the errors it declares, or outside the`,
    "/// contract.",
    "///",
    "/// A declared body converts into its variant and any error into",
    "/// `Internal`, so the question mark works on both. For that the type is",
    "/// not an error type itself.",
    "#[derive(Debug)]",
    `pub enum ${name} {`,
    ...item.errors.flatMap((error) => [
      `    /// ${error.status}, with its body.`,
      `    ${error.variant}(${error.type}),`,
    ]),
    "    /// Not part of the contract: a 500.",
    "    Internal(InternalError),",
    "}",
    "",
    `impl ${name} {`,
    "    /// The status the error is answered with.",
    "    #[must_use]",
    "    pub fn status(&self) -> StatusCode {",
    "        match self {",
    ...item.errors.map((error) =>
      `            Self::${error.variant}(_) => ${error.code},`
    ),
    "            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,",
    "        }",
    "    }",
    "",
    "    fn respond(&self, operation: &runtime::Operation) -> Response {",
    "        match self {",
    ...item.errors.flatMap((error) =>
      arm(
        12,
        `Self::${error.variant}(body)`,
        "operation.fail(",
        [error.code, `&contract::${error.schema}`, "body"],
      )
    ),
    "            Self::Internal(error) => operation.internal(error),",
    "        }",
    "    }",
    "}",
    "",
    ...convertible.flatMap((error) => [
      `impl From<${error.type}> for ${name} {`,
      `    fn from(body: ${error.type}) -> Self {`,
      `        Self::${error.variant}(body)`,
      "    }",
      "}",
      "",
    ]),
    `impl<E: Into<Box<dyn std::error::Error + Send + Sync>>> From<E> for ${name} {`,
    "    fn from(error: E) -> Self {",
    "        Self::Internal(InternalError::from(error))",
    "    }",
    "}",
    "",
  ];
}

/**
 * A match arm that is a call, as rustfmt writes it: an argument per line
 * when the arguments are wider than rustfmt's `fn_call_width`; otherwise
 * on one line, or the call in a block when the line is too long.
 */
function arm(
  indent: number,
  pattern: string,
  open: string,
  args: readonly string[],
): string[] {
  const pad = " ".repeat(indent);
  const call = `${open}${args.join(", ")})`;
  if (args.join(", ").length <= 60) {
    return `${pad}${pattern} => ${call},`.length <= 100
      ? [`${pad}${pattern} => ${call},`]
      : [`${pad}${pattern} => {`, `${pad}    ${call}`, `${pad}}`];
  }
  return [
    `${pad}${pattern} => ${open}`,
    ...args.map((arg) => `${pad}    ${arg},`),
    `${pad}),`,
  ];
}

/** The arguments a handler takes, in a fixed order. */
function handlerArguments(item: Rendered): string[] {
  return [
    ...(item.params ? [`params: ${item.params}`] : []),
    ...(item.query ? [`query: ${item.query}`] : []),
    ...(item.body ? [`body: ${item.body}`] : []),
  ];
}

/** The enum of a stream's events, and what the stream writer asks of it. */
function eventEnum(item: Rendered): string[] {
  const { events, variants } = item.stream!;
  const match = (value: (variant: typeof variants[number]) => string) => [
    "        match self {",
    ...variants.map((variant) =>
      `            Self::${variant.variant}(_) => ${value(variant)},`
    ),
    "        }",
  ];
  return [
    `/// The events of \`${item.label}\`.`,
    "#[derive(Debug, Clone, PartialEq, Serialize)]",
    // Written as its data: the name of an event is not part of it.
    "#[serde(untagged)]",
    `pub enum ${events} {`,
    ...variants.flatMap((variant) => [
      `    /// The event \`${variant.name}\`.`,
      `    ${variant.variant}(${variant.type}),`,
    ]),
    "}",
    "",
    `impl streams::Declared for ${events} {`,
    "    fn name(&self) -> &'static str {",
    ...match((variant) => JSON.stringify(variant.name)),
    "    }",
    "",
    "    fn schema(&self) -> &'static runtime::Schema {",
    ...match((variant) => `&contract::${variant.schema}`),
    "    }",
    "}",
    "",
  ];
}

function handlerSignature(item: Rendered): string[] {
  const { operation } = item;
  const summary = operation.summary ?? operation.description;
  if (item.stream) {
    return [
      ...documentation(
        `\`${item.label}\`: a stream of events.${
          summary ? ` ${summary.split("\n")[0]}` : ""
        }\n\n` +
          "A client that reconnects says which event it saw last: its id is " +
          "`last_event_id`, and `None` on a first connection.",
        4,
      ),
      ...wrapped(
        4,
        `fn ${item.method}(`,
        ["&self", ...handlerArguments(item), "last_event_id: Option<String>"],
        `) -> impl Future<Output = Result<EventStream<${item.stream.events}>, InternalError>> + Send;`,
      ),
    ];
  }
  return [
    ...documentation(
      `\`${item.label}\`${summary ? `: ${summary.split("\n")[0]}` : ""}`,
      4,
    ),
    ...wrapped(
      4,
      `fn ${item.method}(`,
      ["&self", ...handlerArguments(item)],
      `) -> impl Future<Output = ${returns(item)}> + Send;`,
    ),
  ];
}

function route(item: Rendered): string[] {
  const extractors = ["State(handlers): State<Arc<H>>"];
  // What axum itself can refuse is taken as a `Result`, and answered in
  // the shape of every other refusal.
  if (item.params) {
    extractors.push(
      "path: Result<Path<HashMap<String, String>>, PathRejection>",
    );
  }
  if (item.query) {
    extractors.push("Query(pairs): Query<Vec<(String, String)>>");
  }
  if (item.body) {
    extractors.push(
      "headers: HeaderMap",
      "bytes: Result<Bytes, BytesRejection>",
    );
  } else if (item.stream) {
    extractors.push("headers: HeaderMap");
  }

  const read = (name: string, expression: string) => [
    `    let ${name} = ${expression}?;`,
  ];
  const passed = [
    ...(item.params ? ["params"] : []),
    ...(item.query ? ["query"] : []),
    ...(item.body ? ["body"] : []),
  ];
  if (item.stream) passed.push("last_event_id");
  const call = `handlers.${item.method}(${passed.join(", ")}).await`;
  const { keepAlive } = item.stream ?? {};

  return [
    ...wrapped(
      0,
      `async fn ${item.method}<H: Handlers>(`,
      extractors,
      ") -> Result<Response, runtime::Refused> {",
    ),
    `    let operation = &contract::${item.constant};`,
    // In the order the TypeScript handlers check: body, query, path.
    ...(item.body ? read("body", "operation.body(&headers, bytes)") : []),
    ...(item.query ? read("query", "operation.query(pairs)") : []),
    ...(item.params ? read("params", "operation.params(path)") : []),
    ...(item.stream
      ? ["    let last_event_id = streams::last_event_id(&headers);"]
      : []),
    `    Ok(match ${call} {`,
    ...(item.stream
      ? arm(8, "Ok(events)", "streams::respond(", [
        "operation.name",
        "events",
        keepAlive === undefined
          ? "None"
          : `Some(Duration::from_millis(${keepAlive}))`,
      ])
      : [
        item.response
          ? "        Ok(response) => operation.respond(&response),"
          : "        Ok(()) => StatusCode::NO_CONTENT.into_response(),",
      ]),
    item.errorEnum
      ? "        Err(error) => error.respond(operation),"
      : "        Err(error) => operation.internal(&error),",
    "    })",
    "}",
  ];
}

function router(
  rendered: readonly Rendered[],
  patterns: boolean,
): string[] {
  const panics = (text: readonly string[]) =>
    patterns ? ["///", "/// # Panics", "///", ...text] : [];
  return [
    "/// The operations as routes that call the given handlers.",
    ...panics(["/// As [`router_from_arc`] does."]),
    "pub fn router<H: Handlers>(handlers: H) -> axum::Router {",
    "    router_from_arc(Arc::new(handlers))",
    "}",
    "",
    "/// [`router`], for handlers that something else holds as well.",
    ...panics([
      "/// If a pattern of the contract is not one this module's regular",
      "/// expression engine can compile. It is found here, when the server",
      "/// starts, and not by the first request that reaches it.",
    ]),
    "pub fn router_from_arc<H: Handlers>(handlers: Arc<H>) -> axum::Router {",
    ...(patterns ? ["    runtime::compile(contract::PATTERNS);"] : []),
    "    axum::Router::new()",
    // One line per operation; axum joins the methods of a path.
    ...rendered.flatMap((item) =>
      wrapped(
        8,
        ".route(",
        [
          JSON.stringify(axumPath(item.operation.path)),
          `${item.operation.method.toLowerCase()}(${item.method}::<H>)`,
        ],
        ")",
      )
    ),
    "        .with_state(handlers)",
    "}",
  ];
}
