/**
 * A Rust client from a contract.
 *
 * The generated module holds:
 *
 * - a serde type for every request part, response and declared error
 *   body: the types the axum module has
 * - `Error`: why a call did not return what its operation declares
 * - an error enum per operation that declares errors, one variant per
 *   status, and `Other` for everything else: a declared error is a value
 *   a caller matches on
 * - `Client` (reqwest), with a method per operation; for a paginated
 *   list also `<operation>_pages()` and `<operation>_items()`, which
 *   follow the list by the endpoint's pagination style
 * - a private module that writes requests, reads answers and finds the
 *   next page, with its unit tests
 *
 * Operations that stream server-sent events are listed in the module's
 * documentation and left out.
 *
 * The source is written as rustfmt writes it, and without what
 * `clippy::pedantic` would flag.
 *
 * @module
 */

import {
  type Contract,
  type ContractOperation,
  itemsSchema,
  type JsonSchema,
} from "../contract/index.ts";
import { pascalCase, TypeGraph } from "../contract/types.ts";
import { STATUS_NAMES } from "./axum.ts";
import {
  CLIENT_ERROR,
  CLIENT_PAGES,
  CLIENT_RUNTIME,
} from "./client_runtime.ts";
import { rustString } from "./contract.ts";
import {
  constantCase,
  documentation,
  identifier,
  RustModels,
  snakeCase,
  wrapped,
} from "./models.ts";
import { MAYBE_ABSENT } from "./runtime.ts";

/** What the generated module needs to be told. */
export interface RustClientOptions {
  /** Where the routes came from, for the module's documentation. */
  readonly source?: string;
}

/** A declared error of an operation. */
interface DeclaredError {
  readonly status: string;
  /** The type of its body. */
  readonly type: string;
  /** The variant of the operation's error enum: the status by name. */
  readonly variant: string;
}

/** One operation, with the Rust names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  /** `GET /notes/{id}`. */
  readonly label: string;
  /** Name of the client's method. */
  readonly method: string;
  readonly query?: string;
  readonly body?: string;
  readonly response?: string;
  readonly errors: readonly DeclaredError[];
  /** Name of the error enum, when the operation declares errors. */
  readonly errorEnum?: string;
  /** For a paginated list: the type of an item and the static of its rule. */
  readonly pages?: { readonly item?: string; readonly meta: string };
}

/** A banner between the parts of the module. */
function banner(title: string): string[] {
  const rule = `// ${"-".repeat(77)}`;
  return [rule, `// ${title}`, rule, ""];
}

/** The argument of a method that takes a path parameter. */
function argument(name: string): string {
  return identifier(snakeCase(name));
}

/**
 * Render a contract as the source of a Rust client module.
 */
export function renderRustClient(
  contract: Contract,
  options: RustClientOptions = {},
): string {
  // One type for both sides of a schema, as in the server module.
  const graph = new TypeGraph({ mergeSides: true });
  const models = new RustModels(graph);
  const rendered: Rendered[] = [];
  const skipped: ContractOperation[] = [];
  /** The pagination rule of each list, as a static. */
  const rules: string[] = [];

  for (const operation of contract.operations) {
    if (operation.events) {
      skipped.push(operation);
      continue;
    }
    const label = `${operation.method} ${operation.path}`;
    const base = pascalCase(operation.operationId);
    const part = (
      suffix: string,
      role: string,
      schema: JsonSchema | undefined,
      text: boolean,
    ): string | undefined => {
      if (!schema) return undefined;
      const type = models.type(graph.define(`${base}${suffix}`, schema, text));
      models.describe(type, role, label);
      return type;
    };

    const query = part("Query", "query", operation.query, true);
    const body = part("Body", "body", operation.body, false);
    const response = part("Response", "response", operation.response, false);
    const errors = Object.entries(operation.errors ?? {}).map(
      ([status, schema]) => {
        const name = STATUS_NAMES[status];
        return {
          status,
          type: part(`Error${status}`, `${status} body`, schema, false)!,
          variant: name ? pascalCase(name.toLowerCase()) : `Status${status}`,
        };
      },
    );

    let pages: Rendered["pages"];
    if (operation.pagination && operation.response) {
      const item = part(
        "Item",
        "items",
        itemsSchema(operation.response, operation.pagination.items),
        false,
      );
      const meta = `${constantCase(operation.operationId)}_PAGINATION`;
      rules.push(...paginationStatic(meta, operation.pagination));
      pages = { ...(item && { item }), meta };
    }

    rendered.push({
      operation,
      label,
      method: snakeCase(operation.operationId),
      ...(query && { query }),
      ...(body && { body }),
      ...(response && { response }),
      errors,
      ...(errors.length > 0 && { errorEnum: `${base}Error` }),
      ...(pages && { pages }),
    });
  }

  // Rendered first: what the types use decides what is imported.
  const types = models.render();
  const paginated = rendered.some((item) => item.pages);
  const failing = rendered.filter((item) => item.errorEnum);

  const lines: string[] = [
    `//! A client for the API${
      options.source ? ` of \`${options.source}\`` : ""
    }: its types and`,
    "//! [`Client`].",
    "//!",
    "//! Generated by typed-endpoints from the schemas of the routes. Do not",
    "//! edit. A method of [`Client`] sends the request of one operation and",
    "//! returns its response as the type the contract declares. An error the",
    "//! operation declares is a variant of its error type; anything else is",
    "//! an [`Error`].",
    "//!",
    "//! # Crates",
    "//!",
    "//! `reqwest` 0.12, `serde` with `derive`, and `serde_json`.",
    ...(skipped.length > 0
      ? [
        "//!",
        "//! # Not in this module",
        "//!",
        "//! Server-sent event streams:",
        "//!",
        ...skipped.map((operation) =>
          `//! - \`${operation.method} ${operation.path}\``
        ),
      ]
      : []),
    "",
    ...(models.usesMap ? ["use std::collections::BTreeMap;"] : []),
    "use std::fmt;",
    ...(paginated ? ["use std::marker::PhantomData;"] : []),
    "",
    "use reqwest::{Method, StatusCode};",
    ...(paginated ? ["use serde::de::DeserializeOwned;"] : []),
    "use serde::{Deserialize, Serialize};",
    ...(models.usesValue || paginated ? ["use serde_json::Value;"] : []),
    "",
    ...banner("Types"),
    ...types,
    ...(models.usesMaybeAbsent ? [MAYBE_ABSENT, ""] : []),
    ...banner("Errors"),
    CLIENT_ERROR,
    "",
    ...failing.flatMap(errorEnum),
    ...banner("Client"),
    "/// The operations of the API, as methods.",
    "///",
    "/// It is cheap to clone: the clones share their connections.",
    "#[derive(Debug, Clone)]",
    "pub struct Client {",
    "    http: reqwest::Client,",
    "    /// Where the API is, without a slash at the end.",
    "    base_url: String,",
    "}",
    "",
    "impl Client {",
    "    /// A client for the API at a URL such as `http://localhost:8000`.",
    "    #[must_use]",
    "    pub fn new(base_url: &str) -> Self {",
    "        Self::with_http(base_url, reqwest::Client::new())",
    "    }",
    "",
    "    /// The same, with the HTTP client that sends the requests: its headers,",
    "    /// its timeouts, its proxy.",
    "    #[must_use]",
    "    pub fn with_http(base_url: &str, http: reqwest::Client) -> Self {",
    "        Self {",
    "            http,",
    "            base_url: base_url.trim_end_matches('/').to_owned(),",
    "        }",
    "    }",
    "",
    "    async fn send(",
    "        &self,",
    "        method: Method,",
    "        path: &str,",
    "        query: &[(String, String)],",
    "        body: Option<Vec<u8>>,",
    "    ) -> Result<runtime::Answer, Error> {",
    '        let url = format!("{}{path}", self.base_url);',
    "        runtime::send(&self.http, method, &url, query, body).await",
    "    }",
  ];
  for (const item of rendered) lines.push("", ...methods(item));
  lines.push("}", "");

  if (paginated) {
    lines.push(...banner("Lists"), CLIENT_PAGES, "", ...rules);
  }
  lines.push(CLIENT_RUNTIME, "");
  return lines.join("\n");
}

/** The static that says how a list is paginated. */
function paginationStatic(
  name: string,
  meta: NonNullable<ContractOperation["pagination"]>,
): string[] {
  const text = (value: string) => rustString(value);
  const optional = (value: string | undefined) =>
    value === undefined ? "None" : `Some(${rustString(value)})`;
  const fields: [string, string][] = [["items", text(meta.items)]];
  let variant: string;
  switch (meta.style) {
    case "cursor":
      variant = "Cursor";
      fields.push(
        ["cursor", text(meta.cursor)],
        ["cursor_param", text(meta.cursorParam)],
      );
      break;
    case "cursorId":
      variant = "CursorId";
      fields.push(
        ["id_field", text(meta.idField)],
        ["cursor_id_param", text(meta.cursorIdParam)],
        ["limit_param", optional(meta.limitParam)],
      );
      break;
    case "offset":
      variant = "Offset";
      fields.push(
        ["total", text(meta.total)],
        ["offset_param", text(meta.offsetParam)],
      );
      break;
    case "page":
      variant = "Page";
      fields.push(
        ["total", optional(meta.total)],
        ["total_pages", optional(meta.totalPages)],
        ["page_param", text(meta.pageParam)],
        ["per_page_param", optional(meta.perPageParam)],
      );
      break;
    case "url":
      variant = "Url";
      fields.push(["next_url", text(meta.nextUrl)]);
      break;
  }
  return [
    `static ${name}: runtime::Pagination = runtime::Pagination::${variant} {`,
    ...fields.map(([field, value]) => `    ${field}: ${value},`),
    "};",
    "",
  ];
}

/** What a call returns: the response, or how it failed. */
function returns(item: Rendered): string {
  return `Result<${item.response ?? "()"}, ${item.errorEnum ?? "Error"}>`;
}

function errorEnum(item: Rendered): string[] {
  const name = item.errorEnum!;
  return [
    `/// How \`${item.label}\` fails: with an error it declares, or otherwise.`,
    "#[derive(Debug)]",
    `pub enum ${name} {`,
    ...item.errors.flatMap((error) => [
      `    /// ${error.status}, with its body.`,
      `    ${error.variant}(${error.type}),`,
    ]),
    "    /// Not an error the operation declares.",
    "    Other(Error),",
    "}",
    "",
    `impl fmt::Display for ${name} {`,
    "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
    "        match self {",
    ...item.errors.map((error) =>
      `            Self::${error.variant}(_) => f.write_str(${
        rustString(`${item.label} answered ${error.status}`)
      }),`
    ),
    "            Self::Other(error) => error.fmt(f),",
    "        }",
    "    }",
    "}",
    "",
    `impl std::error::Error for ${name} {`,
    "    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {",
    "        match self {",
    "            Self::Other(error) => error.source(),",
    `            ${
      item.errors.map((error) => `Self::${error.variant}(_)`).join(" | ")
    } => None,`,
    "        }",
    "    }",
    "}",
    "",
    `impl From<Error> for ${name} {`,
    "    fn from(error: Error) -> Self {",
    "        Self::Other(error)",
    "    }",
    "}",
    "",
  ];
}

/** The path of an operation as an expression of type `Result<String, Error>`. */
function pathParts(
  operation: ContractOperation,
): { format: string; args: string[] } {
  const args: string[] = [];
  const format = operation.path.replace(
    /\{(\+?)(\w+)\}/g,
    (_, rest: string, name: string) => {
      args.push(`runtime::${rest ? "rest" : "segment"}(${argument(name)})`);
      return "{}";
    },
  );
  return { format, args };
}

/**
 * The statement that sends a request, as rustfmt writes it: a chain wider
 * than its `chain_width` has a line per call.
 */
function sending(args: readonly string[]): string[] {
  const call = `send(${args.join(", ")})`;
  return `self.${call}.await?`.length <= 60
    ? [`        let answer = self.${call}.await?;`]
    : [
      "        let answer = self",
      `            .${call}`,
      "            .await?;",
    ];
}

/** The methods of the client for one operation. */
function methods(item: Rendered): string[] {
  const { operation, label } = item;
  const parameters = [
    "&self",
    ...operation.pathParams.map(({ name }) => `${argument(name)}: &str`),
    ...(item.body ? [`body: &${item.body}`] : []),
    ...(item.query ? [`query: &${item.query}`] : []),
  ];
  const { format, args } = pathParts(operation);
  const method = `Method::${operation.method}`;
  const summary = (operation.summary ?? operation.description)?.trim()
    .split("\n")[0];

  // The path: a literal, or built from the parameters.
  const path = args.length === 0 ? [] : wrapped(
    8,
    "let path = format!(",
    [rustString(format), ...args.map((arg) => `${arg}?`)],
    ");",
    false,
  );
  const pathArg = args.length === 0 ? rustString(format) : "&path";
  const send = [
    ...(item.query ? ["        let query = runtime::pairs(query)?;"] : []),
    ...(item.body ? ["        let body = runtime::body(body)?;"] : []),
    ...sending([
      method,
      pathArg,
      item.query ? "&query" : "&[]",
      item.body ? "Some(body)" : "None",
    ]),
  ];
  const success = item.response ? "answer.success()" : "answer.done()";

  const declared = item.errors.map((error) =>
    `[\`${item.errorEnum}::${error.variant}\`] for a ${error.status}`
  );
  const errorsDoc = item.errorEnum
    ? `${
      declared.join(", ")
    }; any other failure is [\`${item.errorEnum}::Other\`].`
    : "If the request cannot be sent, or the answer is not the response of the operation.";

  const lines: string[] = [
    ...documentation(
      `\`${label}\`${
        summary ? `: ${summary}` : ""
      }\n\n# Errors\n\n${errorsDoc}`,
      4,
    ),
    ...wrapped(
      4,
      `pub async fn ${item.method}(`,
      parameters,
      `) -> ${returns(item)} {`,
    ),
    ...path,
    ...send,
    ...(item.errorEnum
      ? [
        "        match answer.status() {",
        ...item.errors.map((error) =>
          `            ${error.status} => Err(${item.errorEnum}::${error.variant}(answer.declared()?)),`
        ),
        `            _ => Ok(${success}?),`,
        "        }",
      ]
      : [`        ${success}`]),
    "    }",
  ];

  if (item.pages && item.response) {
    const pathResult = args.length === 0
      ? `Ok(String::from(${rustString(format)}))`
      : `(|| Ok(format!(${
        [rustString(format), ...args.map((arg) => `${arg}?`)].join(", ")
      })))()`;
    const pages = (indent: number, open: string, close: string) =>
      wrapped(indent, open, [
        "self",
        rustString(item.method),
        method,
        pathResult,
        item.query ? "runtime::pairs(query)" : "Ok(Vec::new())",
        `&${item.pages!.meta}`,
      ], close);
    lines.push(
      "",
      ...documentation(
        `Every page of \`${label}\`, from the one the query asks for.`,
        4,
      ),
      "    #[must_use]",
      ...wrapped(
        4,
        `pub fn ${item.method}_pages(`,
        parameters,
        `) -> Pages<'_, ${item.response}> {`,
      ),
      ...pages(8, "Pages::new(", ")"),
      "    }",
    );
    if (item.pages.item) {
      lines.push(
        "",
        ...documentation(
          `Every item of \`${label}\`, across its pages.`,
          4,
        ),
        "    #[must_use]",
        ...wrapped(
          4,
          `pub fn ${item.method}_items(`,
          parameters,
          `) -> Items<'_, ${item.response}, ${item.pages.item}> {`,
        ),
        `        Items::new(self.${item.method}_pages(${
          parameters.slice(1).map((parameter) => parameter.split(":")[0]).join(
            ", ",
          )
        }))`,
        "    }",
      );
    }
  }
  return lines;
}
