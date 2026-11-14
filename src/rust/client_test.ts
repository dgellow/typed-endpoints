/**
 * The Rust client module, part by part.
 *
 * These tests compare text. That the text compiles, is formatted as
 * rustfmt formats, has nothing for clippy to say and talks to a server is
 * established by `./scripts/test-rust`.
 */

import { assertEquals } from "@std/assert";

import type { Contract, ContractOperation } from "../contract/index.ts";
import { renderRustClient } from "./client.ts";

const NOTE = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const NOT_FOUND = {
  type: "object",
  properties: { error: { const: "not_found" } },
  required: ["error"],
};

function operation(
  overrides: Partial<ContractOperation> & { operationId: string },
): ContractOperation {
  return {
    method: "GET",
    path: "/notes",
    pathParams: [],
    ...overrides,
  };
}

function render(...operations: ContractOperation[]): string[] {
  const contract: Contract = { version: 1, operations };
  return renderRustClient(contract).split("\n");
}

/** The lines from one that starts with `start` to the next closing brace at its indentation. */
function block(lines: readonly string[], start: string): string[] {
  const from = lines.findIndex((line) => line.trimStart().startsWith(start));
  const indent = lines[from]?.length - lines[from]?.trimStart().length;
  const to = lines.findIndex((line, i) =>
    i > from && line === `${" ".repeat(indent)}}`
  );
  return from < 0
    ? []
    : lines.slice(from, to + 1).map((line) => line.slice(indent));
}

Deno.test("rust client: a method per operation; a path parameter is an argument", () => {
  const lines = render(
    operation({ operationId: "notesList", response: NOTE }),
    operation({
      operationId: "notesUpdate",
      method: "PUT",
      path: "/notes/{id}",
      pathParams: [{ name: "id", catchAll: false }],
      body: NOTE,
      response: NOTE,
    }),
    operation({
      operationId: "filesRetrieve",
      path: "/files/{+path}",
      pathParams: [{ name: "path", catchAll: true }],
      response: NOTE,
    }),
    operation({ operationId: "notesClear", method: "DELETE" }),
  );

  assertEquals(block(lines, "pub async fn notes_list("), [
    "pub async fn notes_list(&self) -> Result<NotesListResponse, Error> {",
    '    let answer = self.send(Method::GET, "/notes", &[], None).await?;',
    "    answer.success()",
    "}",
  ]);
  // A parameter is one segment, and refused when it would name another
  // path; the body is written as JSON.
  assertEquals(block(lines, "pub async fn notes_update("), [
    "pub async fn notes_update(",
    "    &self,",
    "    id: &str,",
    "    body: &NotesUpdateBody,",
    ") -> Result<NotesUpdateResponse, Error> {",
    '    let path = format!("/notes/{}", runtime::segment(id)?);',
    "    let body = runtime::body(body)?;",
    "    let answer = self.send(Method::PUT, &path, &[], Some(body)).await?;",
    "    answer.success()",
    "}",
  ]);
  // A catch-all keeps its slashes.
  assertEquals(
    lines.includes(
      '        let path = format!("/files/{}", runtime::rest(path)?);',
    ),
    true,
  );
  // Without a response there is nothing to read.
  assertEquals(block(lines, "pub async fn notes_clear("), [
    "pub async fn notes_clear(&self) -> Result<(), Error> {",
    '    let answer = self.send(Method::DELETE, "/notes", &[], None).await?;',
    "    answer.done()",
    "}",
  ]);
});

Deno.test("rust client: a declared error is a variant of the operation's error type", () => {
  const lines = render(operation({
    operationId: "notesRetrieve",
    path: "/notes/{id}",
    pathParams: [{ name: "id", catchAll: false }],
    response: NOTE,
    errors: { 404: NOT_FOUND, 499: { type: "string" } },
  }));
  assertEquals(block(lines, "pub enum NotesRetrieveError"), [
    "pub enum NotesRetrieveError {",
    "    /// 404, with its body.",
    "    NotFound(NotesRetrieveError404),",
    "    /// 499, with its body.",
    "    Status499(String),",
    "    /// Not an error the operation declares.",
    "    Other(Error),",
    "}",
  ]);
  // The status decides the variant; any other failure converts.
  assertEquals(block(lines, "match answer.status() {"), [
    "match answer.status() {",
    "    404 => Err(NotesRetrieveError::NotFound(answer.declared()?)),",
    "    499 => Err(NotesRetrieveError::Status499(answer.declared()?)),",
    "    _ => Ok(answer.success()?),",
    "}",
  ]);
  assertEquals(
    lines.includes("impl From<Error> for NotesRetrieveError {"),
    true,
  );
  assertEquals(
    lines.includes("impl std::error::Error for NotesRetrieveError {"),
    true,
  );
});

Deno.test("rust client: a paginated list has pages and items, and its rule is data", () => {
  const page = {
    type: "object",
    properties: {
      items: { type: "array", items: NOTE },
      next: { type: "string" },
    },
    required: ["items"],
  };
  const lines = render(operation({
    operationId: "notesList",
    query: { type: "object", properties: { after: { type: "string" } } },
    response: page,
    pagination: {
      style: "cursor",
      items: "items",
      cursor: "next",
      cursorParam: "after",
    },
  }));
  const rule = lines.findIndex((line) =>
    line.startsWith("static NOTES_LIST_PAGINATION")
  );
  assertEquals(lines.slice(rule, rule + 5), [
    "static NOTES_LIST_PAGINATION: runtime::Pagination = runtime::Pagination::Cursor {",
    '    items: "items",',
    '    cursor: "next",',
    '    cursor_param: "after",',
    "};",
  ]);
  assertEquals(
    lines.filter((line) => line.includes("pub fn notes_list_")),
    [
      "    pub fn notes_list_pages(&self, query: &NotesListQuery) -> Pages<'_, NotesListResponse> {",
      "    pub fn notes_list_items(",
    ],
  );
  // The item is the type of the list's items.
  assertEquals(
    lines.includes(
      "    ) -> Items<'_, NotesListResponse, NotesListItem> {",
    ),
    true,
  );
  assertEquals(lines.includes("pub struct Pages<'a, P> {"), true);

  // Without a list there is none of it.
  const without = render(
    operation({ operationId: "notesList", response: NOTE }),
  );
  assertEquals(without.includes("pub struct Pages<'a, P> {"), false);
  assertEquals(without.includes("use std::marker::PhantomData;"), false);
});

Deno.test("rust client: an event stream is named in the documentation and left out", () => {
  const lines = render(
    operation({ operationId: "notesList", response: NOTE }),
    operation({
      operationId: "ticksList",
      path: "/ticks",
      events: { tick: { type: "object" } },
    }),
  );
  assertEquals(lines.some((line) => line.includes("ticks_list")), false);
  const at = lines.indexOf("//! # Not in this module");
  assertEquals(lines.slice(at + 2, at + 5), [
    "//! Server-sent event streams:",
    "//!",
    "//! - `GET /ticks`",
  ]);
});
