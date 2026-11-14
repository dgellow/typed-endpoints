/**
 * The axum module as source: its handlers, error types, routes and
 * imports.
 *
 * These tests compare text. That the text compiles and behaves is
 * established by `./scripts/test-rust`; two of the rules tested here
 * (which bodies convert into an error type) exist because the other
 * choice does not compile.
 */

import { assertEquals } from "@std/assert";

import type { Contract, ContractOperation } from "../contract/index.ts";
import { renderAxum } from "./axum.ts";

const NOTE = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const NOT_FOUND = {
  type: "object",
  properties: { missing: { type: "string" } },
  required: ["missing"],
};

function operation(
  parts: Partial<ContractOperation> & { operationId: string },
): ContractOperation {
  return { method: "GET", path: "/notes", pathParams: [], ...parts };
}

function render(...operations: ContractOperation[]): string[] {
  const contract: Contract = { version: 1, operations };
  return renderAxum(contract).split("\n");
}

/** The lines from the one that starts with `start` to the next `}`. */
function block(lines: readonly string[], start: string): string[] {
  const from = lines.findIndex((line) => line.startsWith(start));
  const to = lines.findIndex((line, i) => i > from && line === "}");
  return from < 0 ? [] : lines.slice(from, to + 1);
}

Deno.test("rust axum: every handler can fail; what is not declared is an InternalError", () => {
  const lines = render(
    operation({ operationId: "notesList", response: NOTE }),
    operation({
      operationId: "notesRetrieve",
      path: "/notes/{id}",
      pathParams: [{ name: "id", catchAll: false }],
      response: NOTE,
      errors: { 404: NOT_FOUND },
    }),
    operation({ operationId: "notesClear", method: "DELETE" }),
  );
  assertEquals(block(lines, "pub trait Handlers").slice(1), [
    "    /// `GET /notes`",
    "    fn notes_list(&self) -> impl Future<Output = Result<NotesListResponse, InternalError>> + Send;",
    "",
    "    /// `GET /notes/{id}`",
    "    fn notes_retrieve(",
    "        &self,",
    "        params: NotesRetrieveParams,",
    "    ) -> impl Future<Output = Result<NotesRetrieveResponse, NotesRetrieveError>> + Send;",
    "",
    "    /// `DELETE /notes`",
    "    fn notes_clear(&self) -> impl Future<Output = Result<(), InternalError>> + Send;",
    "}",
  ]);

  // A route answers a failure as the operation says, or as a 500.
  assertEquals(block(lines, "async fn notes_list<H: Handlers>").slice(-5), [
    "    match handlers.notes_list().await {",
    "        Ok(response) => operation.respond(&response),",
    "        Err(error) => operation.internal(&error),",
    "    }",
    "}",
  ]);
  assertEquals(block(lines, "async fn notes_retrieve<H: Handlers>").slice(-5), [
    "    match handlers.notes_retrieve(params).await {",
    "        Ok(response) => operation.respond(&response),",
    "        Err(error) => error.respond(operation),",
    "    }",
    "}",
  ]);
  assertEquals(block(lines, "async fn notes_clear<H: Handlers>").slice(-5), [
    "    match handlers.notes_clear().await {",
    "        Ok(()) => StatusCode::NO_CONTENT.into_response(),",
    "        Err(error) => operation.internal(&error),",
    "    }",
    "}",
  ]);
});

Deno.test("rust axum: an error type has a variant per status, named as the status is", () => {
  const lines = render(operation({
    operationId: "notesRetrieve",
    response: NOTE,
    errors: { 404: NOT_FOUND, 499: { type: "string" } },
  }));
  assertEquals(block(lines, "pub enum NotesRetrieveError"), [
    "pub enum NotesRetrieveError {",
    "    /// 404, with its body.",
    "    NotFound(NotesRetrieveError404),",
    "    /// 499, with its body.",
    "    Status499(String),",
    "    /// Not part of the contract: a 500.",
    "    Internal(InternalError),",
    "}",
  ]);
  assertEquals(
    lines.filter((line) =>
      line.includes("=> StatusCode::") || /=> status\(/.test(line)
    )
      .map((line) => line.trim()),
    [
      "Self::NotFound(_) => StatusCode::NOT_FOUND,",
      // A status without a name in `http`.
      "Self::Status499(_) => status(499),",
      "Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,",
    ],
  );
  assertEquals(lines.includes("fn status(code: u16) -> StatusCode {"), true);
});

Deno.test("rust axum: a body converts into the error only when its type says which variant", () => {
  const conversions = (errors: ContractOperation["errors"]) =>
    render(operation({ operationId: "notesRetrieve", response: NOTE, errors }))
      .filter((line) => line.startsWith("impl") && line.includes("From<"));
  const any =
    "impl<E: Into<Box<dyn std::error::Error + Send + Sync>>> From<E> for NotesRetrieveError {";
  const internal =
    "impl<E: Into<Box<dyn std::error::Error + Send + Sync>>> From<E> for InternalError {";

  // A type of the module: `?` on it gives its variant.
  assertEquals(conversions({ 404: NOT_FOUND }), [
    internal,
    "impl From<NotesRetrieveError404> for NotesRetrieveError {",
    any,
  ]);

  // A string converts into any error already (E0119 if it were written
  // again), so its variant is written out by the handler.
  assertEquals(conversions({ 404: NOT_FOUND, 409: { type: "string" } }), [
    internal,
    "impl From<NotesRetrieveError404> for NotesRetrieveError {",
    any,
  ]);

  // The same body for two statuses does not say which.
  assertEquals(conversions({ 404: NOT_FOUND, 410: NOT_FOUND }), [
    internal,
    any,
  ]);
});

Deno.test("rust axum: the module imports what its code names, and no more", () => {
  const imports = (...operations: ContractOperation[]) =>
    render(...operations).filter((line) => line.startsWith("use "));

  assertEquals(
    imports(operation({ operationId: "notesList", response: NOTE })),
    [
      "use std::fmt;",
      "use std::future::Future;",
      "use std::sync::Arc;",
      "use axum::extract::State;",
      "use axum::response::Response;",
      "use axum::routing::get;",
      "use serde::{Deserialize, Serialize};",
    ],
  );

  assertEquals(
    imports(
      operation({
        operationId: "notesUpdate",
        method: "PUT",
        path: "/notes/{id}",
        pathParams: [{ name: "id", catchAll: false }],
        query: {
          type: "object",
          properties: { dry: { type: "boolean" } },
        },
        body: {
          type: "object",
          properties: {
            meta: { type: "object", additionalProperties: {} },
          },
        },
        errors: { 404: NOT_FOUND },
      }),
    ),
    [
      "use std::collections::{BTreeMap, HashMap};",
      "use std::fmt;",
      "use std::future::Future;",
      "use std::sync::Arc;",
      "use axum::body::Bytes;",
      "use axum::extract::{Path, Query, State};",
      "use axum::http::{HeaderMap, StatusCode};",
      "use axum::response::{IntoResponse, Response};",
      "use axum::routing::put;",
      "use serde::{Deserialize, Serialize};",
      "use serde_json::Value;",
    ],
  );
});

Deno.test("rust axum: one route per operation; a catch-all is written as axum writes it", () => {
  const lines = render(
    operation({ operationId: "notesList", response: NOTE }),
    operation({ operationId: "notesCreate", method: "POST", response: NOTE }),
    operation({
      operationId: "filesRetrieve",
      path: "/files/{+path}",
      pathParams: [{ name: "path", catchAll: true }],
      response: NOTE,
    }),
  );
  assertEquals(block(lines, "pub fn router<H: Handlers>"), [
    "pub fn router<H: Handlers>(handlers: H) -> axum::Router {",
    "    axum::Router::new()",
    '        .route("/notes", get(notes_list::<H>))',
    '        .route("/notes", post(notes_create::<H>))',
    '        .route("/files/{*path}", get(files_retrieve::<H>))',
    "        .with_state(Arc::new(handlers))",
    "}",
  ]);
});

Deno.test("rust axum: the router compiles the contract's patterns, and says that it may panic", () => {
  const withPattern = render(operation({
    operationId: "notesCreate",
    method: "POST",
    body: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d+$" } },
    },
    response: NOTE,
  }));
  const at = withPattern.findIndex((line) => line.startsWith("pub fn router"));
  assertEquals(
    withPattern[at + 1],
    "    runtime::compile(contract::PATTERNS);",
  );
  assertEquals(withPattern.slice(at - 6, at)[1], "/// # Panics");

  // No pattern: nothing to compile, and nothing to warn of.
  const without = render(
    operation({ operationId: "notesList", response: NOTE }),
  );
  assertEquals(
    without.some((line) => line.includes("runtime::compile")),
    false,
  );
  assertEquals(without.includes("/// # Panics"), false);
});

Deno.test("rust axum: an event stream is listed and left out", () => {
  const lines = render(
    operation({ operationId: "notesList", response: NOTE }),
    operation({
      operationId: "ticksList",
      path: "/ticks",
      events: { tick: { type: "object" } },
    }),
  );
  assertEquals(lines.some((line) => line.includes("ticks_list")), false);
  const at = lines.indexOf("// Not generated: server-sent event streams.");
  assertEquals(lines[at + 1], "//   GET /ticks");
});
