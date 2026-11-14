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
import { RustContract, rustString } from "./contract.ts";
import {
  constantCase,
  documentation,
  RustModels,
  snakeCase,
  wrapped,
} from "./models.ts";
import { MAYBE_ABSENT, RUNTIME } from "./runtime.ts";

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
 * Operations that stream server-sent events are listed in a comment and
 * left out.
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
  const skipped: ContractOperation[] = [];

  for (const operation of contract.operations) {
    if (operation.events) {
      skipped.push(operation);
      continue;
    }
    const label = `${operation.method} ${operation.path}`;
    const base = pascalCase(operation.operationId);
    const constant = constantCase(operation.operationId);
    const part = (
      suffix: string,
      what: string,
      schema: JsonSchema | undefined,
      text: boolean,
    ): { type: string; schema: string } | undefined => {
      if (!schema) return undefined;
      const type = models.type(graph.define(`${base}${suffix}`, schema, text));
      models.describe(type, `${what} \`${label}\`.`);
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

    const params = part("Params", "The path parameters of", paramsSchema, true);
    const query = part("Query", "The query of", operation.query, true);
    const body = part("Body", "The body of", operation.body, false);
    const response = part(
      "Response",
      "The response of",
      operation.response,
      false,
    );
    const errors = Object.entries(operation.errors ?? {}).map(
      ([status, schema]) => {
        const name = STATUS_NAMES[status];
        return {
          status,
          ...part(`Error${status}`, `The ${status} body of`, schema, false)!,
          variant: name ? pascalCase(name.toLowerCase()) : `Status${status}`,
          code: name ? `StatusCode::${name}` : `status(${status})`,
        };
      },
    );

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
        errors: new Map(errors.map((error) => [error.status, error.schema])),
      }),
      ...(params && { params: params.type }),
      ...(query && { query: query.type }),
      ...(body && { body: body.type }),
      ...(response && { response: response.type }),
      errors,
      ...(errors.length > 0 && { errorEnum: `${base}Error` }),
    });
  }

  // Rendered first: what the types use decides what is imported.
  const types = models.render();
  const failing = rendered.filter((item) => item.errorEnum);
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
    "",
    ...imports(rendered, models),
    "",
    ...banner("Types"),
    ...types,
    ...(models.usesMaybeAbsent ? [MAYBE_ABSENT, ""] : []),
    ...banner("Handlers"),
    ...failing.flatMap((item) => errorEnum(item, graph)),
    "/// The operations of the API, one method each.",
    "///",
    "/// A method returns the response. For an operation that declares errors",
    "/// it returns a `Result`, and the error names the status.",
    "pub trait Handlers: Send + Sync + 'static {",
  ];
  rendered.forEach((item, i) => {
    if (i > 0) lines.push("");
    lines.push(...handlerSignature(item));
  });
  lines.push("}", "");

  if (skipped.length > 0) {
    lines.push("// Not generated: server-sent event streams.");
    for (const operation of skipped) {
      lines.push(`//   ${operation.method} ${operation.path}`);
    }
    lines.push("");
  }

  lines.push(...banner("Router"), ...router(rendered), "");
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
  lines.push(...data.render(), "", RUNTIME, "");

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
  const silent = any((item) => !item.response);
  const methods = [
    ...new Set(rendered.map((item) => item.operation.method.toLowerCase())),
  ];

  return [
    ...group("std::collections", [
      ...(models.usesMap ? ["BTreeMap"] : []),
      ...(any((item) => !!item.params) ? ["HashMap"] : []),
    ]),
    ...(failing ? ["use std::fmt;"] : []),
    "use std::future::Future;",
    "use std::sync::Arc;",
    "",
    ...(any((item) => !!item.body) ? ["use axum::body::Bytes;"] : []),
    ...group("axum::extract", [
      ...(any((item) => !!item.params) ? ["Path"] : []),
      ...(any((item) => !!item.query) ? ["Query"] : []),
      "State",
    ]),
    ...group("axum::http", [
      ...(any((item) => !!item.body) ? ["HeaderMap"] : []),
      ...(failing || silent ? ["StatusCode"] : []),
    ]),
    ...group("axum::response", [
      ...(silent ? ["IntoResponse"] : []),
      "Response",
    ]),
    ...group("axum::routing", methods),
    "use serde::{Deserialize, Serialize};",
    ...(models.usesValue ? ["use serde_json::Value;"] : []),
  ];
}

/** What a handler returns: the response, or a `Result` with the errors. */
function returns(item: Rendered): string {
  const response = item.response ?? "()";
  return item.errorEnum ? `Result<${response}, ${item.errorEnum}>` : response;
}

function errorEnum(item: Rendered, graph: TypeGraph): string[] {
  const name = item.errorEnum!;
  // The format string of `write!`: braces of the path are text.
  const label = item.label.replaceAll("{", "{{").replaceAll("}", "}}");
  // A body type converts into the error when it says which variant.
  const bodies = item.errors.map((error) =>
    graph.object(error.type)?.name ?? error.type
  );
  const convertible = new Set(bodies).size === bodies.length;

  return [
    `/// The errors \`${item.label}\` declares.`,
    "#[derive(Debug, Clone, PartialEq)]",
    `pub enum ${name} {`,
    ...item.errors.flatMap((error) => [
      `    /// ${error.status}, with its body.`,
      `    ${error.variant}(${error.type}),`,
    ]),
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
    "        }",
    "    }",
    "",
    "    fn respond(&self, operation: &runtime::Operation) -> Response {",
    "        match self {",
    ...item.errors.map((error) =>
      `            Self::${error.variant}(body) => operation.fail(self.status(), body),`
    ),
    "        }",
    "    }",
    "}",
    "",
    `impl fmt::Display for ${name} {`,
    "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
    `        write!(f, ${rustString(`${label} answered {}`)}, self.status())`,
    "    }",
    "}",
    "",
    `impl std::error::Error for ${name} {}`,
    "",
    ...(convertible
      ? item.errors.flatMap((error) => [
        `impl From<${error.type}> for ${name} {`,
        `    fn from(body: ${error.type}) -> Self {`,
        `        Self::${error.variant}(body)`,
        "    }",
        "}",
        "",
      ])
      : []),
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

function handlerSignature(item: Rendered): string[] {
  const { operation } = item;
  const summary = operation.summary ?? operation.description;
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
  if (item.params) {
    extractors.push("Path(path): Path<HashMap<String, String>>");
  }
  if (item.query) {
    extractors.push("Query(pairs): Query<Vec<(String, String)>>");
  }
  if (item.body) extractors.push("headers: HeaderMap", "bytes: Bytes");

  const read = (name: string, expression: string) => [
    `    let ${name} = match ${expression} {`,
    `        Ok(${name}) => ${name},`,
    "        Err(response) => return *response,",
    "    };",
  ];
  const passed = [
    ...(item.params ? ["params"] : []),
    ...(item.query ? ["query"] : []),
    ...(item.body ? ["body"] : []),
  ];
  const call = `handlers.${item.method}(${passed.join(", ")}).await`;
  const taken = passed.length > 0 || item.response || item.errorEnum;

  return [
    ...wrapped(
      0,
      `async fn ${item.method}<H: Handlers>(`,
      extractors,
      ") -> Response {",
    ),
    ...(taken ? [`    let operation = &contract::${item.constant};`] : []),
    // In the order the TypeScript handlers check: body, query, path.
    ...(item.body ? read("body", "operation.body(&headers, &bytes)") : []),
    ...(item.query ? read("query", "operation.query(pairs)") : []),
    ...(item.params ? read("params", "operation.params(path)") : []),
    ...(item.errorEnum
      ? [
        `    match ${call} {`,
        item.response
          ? "        Ok(response) => operation.respond(&response),"
          : "        Ok(()) => StatusCode::NO_CONTENT.into_response(),",
        "        Err(error) => error.respond(operation),",
        "    }",
      ]
      : item.response
      ? [`    operation.respond(&${call})`]
      : [`    ${call};`, "    StatusCode::NO_CONTENT.into_response()"]),
    "}",
  ];
}

function router(rendered: readonly Rendered[]): string[] {
  return [
    "/// The operations as routes that call the given handlers.",
    "pub fn router<H: Handlers>(handlers: H) -> axum::Router {",
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
    "        .with_state(Arc::new(handlers))",
    "}",
  ];
}
