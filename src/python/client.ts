/**
 * A Python client from a contract.
 *
 * The generated module holds a Pydantic model for every request part,
 * response and declared error body, and two classes, `Client` and
 * `AsyncClient` (httpx), with for every operation:
 *
 * - `<operation>(...)`: the response, parsed by its model. Any status
 *   outside 200-299 raises `ApiError`
 * - `<operation>_result(...)`, when the operation declares error
 *   responses: the response, or a `Fail` with the status and the parsed
 *   body of a declared error. A status the operation does not declare
 *   still raises
 * - `<operation>_pages(...)` and `<operation>_items(...)`, when the
 *   operation is paginated: every page, or every item, asking for the next
 *   page the way the endpoint's pagination style says
 *
 * The same three things the TypeScript client has (`method()`,
 * `method.result()`, `list.pages()` / `list.items()`), with the names a
 * language without callable objects with members gives them.
 *
 * @module
 */

import type {
  Contract,
  ContractOperation,
  JsonSchema,
} from "../contract/index.ts";
import {
  pascalCase,
  pythonLiteral,
  PythonModels,
  snakeCase,
} from "./models.ts";

/** What the generated module needs to be told. */
export interface PythonClientOptions {
  /** Where the routes came from, for the module's docstring. */
  readonly source?: string;
}

const PRELUDE = `
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Generic, Literal, TypeVar, cast
from urllib.parse import quote, urljoin, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

StatusT = TypeVar("StatusT", bound=int)
BodyT = TypeVar("BodyT")
_T = TypeVar("_T")

# An integer JavaScript represents exactly: what Zod's int() accepts.
SafeInt = Annotated[int, Field(ge=-9007199254740991, le=9007199254740991)]


@dataclass(frozen=True)
class Fail(Generic[StatusT, BodyT]):
    """An error response the operation declares: its status and its body."""

    status: StatusT
    body: BodyT


class ApiError(Exception):
    """A response with a status outside 200-299 that was not asked for as a
    value: any such status for a plain call, a status the operation does
    not declare for a \`_result\` call."""

    def __init__(self, status: int, body: Any) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body
`.trimStart();

const RUNTIME = `
def _segment(value: str) -> str:
    """A path parameter, percent-encoded."""
    return quote(value, safe="")


def _rest(value: str) -> str:
    """A catch-all path parameter: it keeps its slashes."""
    return quote(value, safe="/")


def _query(query: BaseModel | None) -> dict[str, Any]:
    """Query parameters as httpx takes them; a list repeats its key."""
    if query is None:
        return {}
    values: dict[str, Any] = query.model_dump(
        mode="json", by_alias=True, exclude_unset=True
    )
    return {key: value for key, value in values.items() if value is not None}


def _body(adapter: TypeAdapter[Any], body: Any) -> Any:
    # Fields that were not set stay absent: absent and null are different.
    return adapter.dump_python(body, mode="json", by_alias=True, exclude_unset=True)


def _content(response: httpx.Response) -> Any:
    """The body of a response: parsed JSON, the text, or None when empty."""
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _expect(response: httpx.Response, adapter: TypeAdapter[_T]) -> _T:
    """The parsed body of a success; any other status raises."""
    if not response.is_success:
        raise ApiError(response.status_code, _content(response))
    return adapter.validate_python(_content(response))


def _result(
    response: httpx.Response,
    adapter: TypeAdapter[_T],
    errors: Mapping[int, TypeAdapter[Any]],
) -> _T | Fail[Any, Any]:
    """The parsed body of a success, or a declared error as a value."""
    declared = errors.get(response.status_code)
    if declared is not None:
        return Fail(response.status_code, declared.validate_python(_content(response)))
    return _expect(response, adapter)


def _at(value: Any, path: str | None) -> Any:
    """The value at a dot-notation path of a response."""
    if path is None:
        return None
    for key in path.split("."):
        if not isinstance(value, dict):
            return None
        value = cast("dict[str, Any]", value).get(key)
    return value


def _next_page(
    call: str,
    meta: Mapping[str, Any],
    page: Any,
    query: Mapping[str, Any],
    page_size: int,
) -> tuple[Literal["query"], dict[str, Any]] | tuple[Literal["url"], str] | None:
    """Where the page after \`page\` is, by pagination style."""
    items = _page_items(page, meta)
    count = len(items)

    def stuck(what: str) -> Exception:
        return RuntimeError(
            f"{call}: the server answered with the {what} it was asked for; "
            "there is no next page to ask for"
        )

    style = meta["style"]
    if style == "cursor":
        cursor = _at(page, meta["cursor"])
        if cursor is None or cursor == "":
            return None
        if cursor == query.get(meta["cursorParam"]):
            raise stuck("cursor")
        return "query", {**query, meta["cursorParam"]: cursor}

    if style == "cursorId":
        if count == 0:
            return None
        # A page shorter than the size asked for is the last one.
        limit = query.get(meta.get("limitParam", ""))
        if isinstance(limit, int) and count < limit:
            return None
        last = _at(items[-1], meta["idField"])
        if last is None:
            raise RuntimeError(
                f"{call}: the last item of the page has no "
                f"\\"{meta['idField']}\\" to continue from"
            )
        if str(last) == query.get(meta["cursorIdParam"]):
            raise stuck("item")
        return "query", {**query, meta["cursorIdParam"]: str(last)}

    if style == "offset":
        if count == 0:
            return None
        offset = int(query.get(meta["offsetParam"], 0)) + count
        total = _at(page, meta.get("total"))
        if isinstance(total, int) and offset >= total:
            return None
        return "query", {**query, meta["offsetParam"]: offset}

    if style == "page":
        if count == 0:
            return None
        current = int(query.get(meta["pageParam"], 1))
        total_pages = _at(page, meta.get("totalPages"))
        if isinstance(total_pages, int) and current >= total_pages:
            return None
        size = int(query.get(meta.get("perPageParam", ""), 0)) or page_size
        total = _at(page, meta.get("total"))
        if isinstance(total, int) and (current - 1) * size + count >= total:
            return None
        if count < size:
            return None
        return "query", {**query, meta["pageParam"]: current + 1}

    if style == "url":
        url = _at(page, meta["nextUrl"])
        return ("url", url) if isinstance(url, str) and url != "" else None

    raise TypeError(f"{call}: unknown pagination style \\"{style}\\"")


def _same_origin(call: str, base_url: str, url: str) -> str:
    """The URL of a next page, which has to be on the server asked first:
    the client's headers are sent with it."""
    resolved = urljoin(base_url + "/", url)
    base, target = urlsplit(base_url), urlsplit(resolved)
    if (base.scheme, base.netloc) != (target.scheme, target.netloc):
        raise RuntimeError(
            f"{call}: the next page is on another origin ({resolved}); "
            "it is not followed"
        )
    return resolved


def _page_items(page: Any, meta: Mapping[str, Any]) -> list[Any]:
    found = _at(page, meta.get("items"))
    return cast("list[Any]", found) if isinstance(found, list) else []
`.trimStart();

/** One operation, with the Python names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  readonly method: string;
  readonly query?: string;
  readonly body?: string;
  readonly response?: string;
  readonly errors: ReadonlyMap<string, string>;
  /** Type of one item of a paginated list. */
  readonly item?: string;
}

/** The schema of the items of a paginated response, at a dotted path. */
function itemsSchema(
  response: JsonSchema,
  path: string,
): JsonSchema | undefined {
  const defs = (response.$defs ?? {}) as Record<string, JsonSchema>;
  const resolve = (schema: JsonSchema | undefined): JsonSchema | undefined => {
    if (schema && typeof schema.$ref === "string") {
      return schema.$ref === "#"
        ? response
        : defs[schema.$ref.replace(/^#\/\$defs\//, "")];
    }
    return schema;
  };

  let current = resolve(response);
  for (const key of path.split(".")) {
    const properties = current?.properties as
      | Record<string, JsonSchema>
      | undefined;
    current = resolve(properties?.[key]);
  }
  const items = current?.items;
  if (!items || typeof items !== "object") return undefined;
  return { ...(items as JsonSchema), $defs: defs };
}

/**
 * Render a contract as the source of a Python client module.
 *
 * Operations that stream server-sent events are listed in a comment and
 * left out.
 */
export function renderPythonClient(
  contract: Contract,
  options: PythonClientOptions = {},
): string {
  const models = new PythonModels();
  const rendered: Rendered[] = [];
  const skipped: ContractOperation[] = [];

  for (const operation of contract.operations) {
    if (operation.events) {
      skipped.push(operation);
      continue;
    }
    const base = pascalCase(operation.operationId);
    const response = operation.response &&
      models.define(`${base}Response`, operation.response, true);
    const item = operation.pagination && operation.response
      ? itemsSchema(operation.response, operation.pagination.items)
      : undefined;

    rendered.push({
      operation,
      method: snakeCase(operation.operationId),
      ...(operation.query && {
        query: models.define(`${base}Query`, operation.query, false),
      }),
      ...(operation.body && {
        body: models.define(`${base}Body`, operation.body, true),
      }),
      ...(response && { response }),
      errors: new Map(
        Object.entries(operation.errors ?? {}).map(([status, schema]) => [
          status,
          models.define(`${base}Error${status}`, schema, true),
        ]),
      ),
      ...(item && { item: models.define(`${base}Item`, item, true) }),
    });
  }

  const rule = "# " + "=".repeat(77);
  const lines: string[] = [
    `"""API models and client${
      options.source ? ` for ${options.source}` : ""
    }.`,
    "",
    "Generated by typed-endpoints. Do not edit.",
    '"""',
    "",
    PRELUDE,
    "",
    rule,
    "# Models",
    rule,
    "",
    "",
    ...models.render(),
    rule,
    "# Client",
    rule,
    "",
    "",
  ];

  for (const item of rendered) lines.push(...adapters(item));
  if (skipped.length > 0) {
    lines.push("", "# Not generated: server-sent event streams.");
    for (const operation of skipped) {
      lines.push(`#   ${operation.method} ${operation.path}`);
    }
  }
  lines.push("", "", RUNTIME, "", ...clientClass(rendered, false));
  lines.push("", "", ...clientClass(rendered, true), "");

  return lines.join("\n");
}

function adapters(item: Rendered): string[] {
  const name = item.method.toUpperCase();
  const lines: string[] = [];
  if (item.body) {
    lines.push(`_${name}_BODY: TypeAdapter[Any] = TypeAdapter(${item.body})`);
  }
  // Without a response schema the body is returned as it was parsed.
  lines.push(
    item.response
      ? `_${name}_RESPONSE: TypeAdapter[${item.response}] = TypeAdapter(${item.response})`
      : `_${name}_RESPONSE: TypeAdapter[Any] = TypeAdapter(Any)`,
  );
  if (item.errors.size > 0) {
    lines.push(
      `_${name}_ERRORS: dict[int, TypeAdapter[Any]] = {${
        [...item.errors].map(([status, type]) =>
          `${status}: TypeAdapter(${type})`
        ).join(", ")
      }}`,
    );
  }
  if (item.operation.pagination) {
    lines.push(
      `_${name}_PAGINATION: dict[str, Any] = ${
        pythonLiteral(item.operation.pagination)
      }`,
    );
    if (item.item) {
      lines.push(
        `_${name}_ITEM: TypeAdapter[${item.item}] = TypeAdapter(${item.item})`,
      );
    }
  }
  return lines;
}

/** The path of an operation as a Python f-string. */
function pathExpression(operation: ContractOperation): string {
  const path = operation.path.replace(
    /\{(\+?)(\w+)\}/g,
    (_, rest: string, name: string) =>
      `{${rest ? "_rest" : "_segment"}(${snakeCase(name)})}`,
  );
  return `${operation.pathParams.length > 0 ? "f" : ""}${JSON.stringify(path)}`;
}

function clientClass(
  rendered: readonly Rendered[],
  isAsync: boolean,
): string[] {
  const name = isAsync ? "AsyncClient" : "Client";
  const http = isAsync ? "httpx.AsyncClient" : "httpx.Client";
  const def = isAsync ? "async def" : "def";
  const wait = isAsync ? "await " : "";
  const iterator = isAsync ? "AsyncIterator" : "Iterator";
  const loop = isAsync ? "async for" : "for";

  const lines: string[] = [
    `class ${name}:`,
    `    """The operations as ${isAsync ? "coroutines" : "methods"}.`,
    "",
    "    A plain call returns the parsed response and raises `ApiError` for a",
    "    status outside 200-299. `_result` returns a declared error as a `Fail`.",
    "    `_pages` and `_items` follow a paginated list to its end.",
    '    """',
    "",
    "    def __init__(",
    "        self,",
    "        base_url: str,",
    "        *,",
    `        http: ${http} | None = None,`,
    "        headers: Mapping[str, str] | None = None,",
    "    ) -> None:",
    '        self._base_url = base_url.rstrip("/")',
    `        self._http = http if http is not None else ${http}()`,
    "        self._headers = dict(headers or {})",
    "",
    `    ${def} ${isAsync ? "aclose" : "close"}(self) -> None:`,
    `        ${wait}self._http.${isAsync ? "aclose" : "close"}()`,
    "",
    `    ${def} _send(`,
    "        self,",
    "        method: str,",
    "        path: str,",
    "        query: Mapping[str, Any] | None = None,",
    "        body: Any = None,",
    "    ) -> httpx.Response:",
    `        return ${wait}self._http.request(`,
    "            method,",
    "            self._base_url + path,",
    "            params=query or None,",
    "            json=body,",
    "            headers=self._headers,",
    "        )",
    "",
    `    ${def} _pages(`,
    "        self,",
    "        call: str,",
    "        method: str,",
    "        path: str,",
    "        query: dict[str, Any],",
    "        meta: Mapping[str, Any],",
    `    ) -> ${iterator}[Any]:`,
    '        """Every page of a list, as parsed JSON."""',
    "        url: str | None = None",
    "        size: int | None = None",
    "        while True:",
    "            if url is None:",
    `                response = ${wait}self._send(method, path, query)`,
    "            else:",
    `                response = ${wait}self._http.request(method, url, headers=self._headers)`,
    "            if not response.is_success:",
    "                raise ApiError(response.status_code, _content(response))",
    "            page = _content(response)",
    "            yield page",
    "            if size is None:",
    "                size = len(_page_items(page, meta))",
    "            step = _next_page(call, meta, page, query, size)",
    "            if step is None:",
    "                return",
    '            if step[0] == "query":',
    "                query = step[1]",
    "            else:",
    "                url = _same_origin(call, self._base_url, step[1])",
  ];

  for (const item of rendered) {
    lines.push("", ...operationMethods(item, { def, wait, iterator, loop }));
  }
  return lines;
}

function operationMethods(
  item: Rendered,
  words: { def: string; wait: string; iterator: string; loop: string },
): string[] {
  const { operation } = item;
  const { def, wait, iterator, loop } = words;
  const constant = item.method.toUpperCase();
  const response = item.response ?? "Any";

  const parameters = [
    ...operation.pathParams.map(({ name }) => `${snakeCase(name)}: str`),
    ...(item.body ? [`body: ${item.body}`] : []),
    ...(item.query ? [`query: ${item.query} | None = None`] : []),
  ];
  const signature = (name: string, returns: string) => [
    `    ${def} ${name}(`,
    "        self,",
    ...parameters.map((parameter) => `        ${parameter},`),
    `    ) -> ${returns}:`,
  ];
  const send = [
    `${wait}self._send(`,
    `    ${JSON.stringify(operation.method)},`,
    `    ${pathExpression(operation)},`,
    ...(item.query ? ["    _query(query),"] : item.body ? ["    None,"] : []),
    ...(item.body ? [`    _body(_${constant}_BODY, body),`] : []),
    ")",
  ];
  const title = `${operation.method} ${operation.path}`;
  const summary = operation.summary ?? operation.description;
  const doc = `${title}${
    summary ? `: ${summary.replaceAll('"""', "'''")}` : ""
  }`;

  const lines: string[] = [
    ...signature(item.method, response),
    `        """${doc}"""`,
    `        response = ${send[0]}`,
    ...send.slice(1).map((line) => `        ${line}`),
    `        return _expect(response, _${constant}_RESPONSE)`,
  ];

  if (item.errors.size > 0) {
    const failures = [...item.errors].map(([status, type]) =>
      `Fail[Literal[${status}], ${type}]`
    );
    lines.push(
      "",
      ...signature(
        `${item.method}_result`,
        [response, ...failures].join(" | "),
      ),
      `        """${title}, with the declared errors as values."""`,
      `        response = ${send[0]}`,
      ...send.slice(1).map((line) => `        ${line}`),
      `        return _result(response, _${constant}_RESPONSE, _${constant}_ERRORS)`,
    );
  }

  if (operation.pagination && item.response) {
    const pages = [
      `self._pages(`,
      `    ${JSON.stringify(item.method)},`,
      `    ${JSON.stringify(operation.method)},`,
      `    ${pathExpression(operation)},`,
      `    ${item.query ? "_query(query)" : "{}"},`,
      `    _${constant}_PAGINATION,`,
      `)`,
    ];
    lines.push(
      "",
      ...signature(`${item.method}_pages`, `${iterator}[${item.response}]`),
      `        """Every page of ${title}, from the one the query asks for."""`,
      `        ${loop} page in ${pages[0]}`,
      ...pages.slice(1, -1).map((line) => `        ${line}`),
      "        ):",
      `            yield _${constant}_RESPONSE.validate_python(page)`,
    );
    if (item.item) {
      lines.push(
        "",
        ...signature(`${item.method}_items`, `${iterator}[${item.item}]`),
        `        """Every item of ${title}, across its pages."""`,
        `        ${loop} page in ${pages[0]}`,
        ...pages.slice(1, -1).map((line) => `        ${line}`),
        "        ):",
        `            for item in _page_items(page, _${constant}_PAGINATION):`,
        `                yield _${constant}_ITEM.validate_python(item)`,
      );
    }
  }

  return lines;
}
