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

import {
  type Contract,
  type ContractOperation,
  itemsSchema,
  type JsonSchema,
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
  argumentName,
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

/** What the module may import: the names its source uses are imported. */
const IMPORTS: readonly ImportTable[] = [
  [
    ["re", []],
    ["collections.abc", ["AsyncIterator", "Iterator", "Mapping"]],
    ["dataclasses", ["dataclass"]],
    ["types", ["TracebackType"]],
    ["typing", ["Annotated", "Any", "Literal", "Self", "cast"]],
    ["urllib.parse", ["quote"]],
  ],
  [
    ["httpx", []],
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

const PRELUDE = `
@dataclass(frozen=True)
class Fail[StatusT: int, BodyT]:
    """An error response the operation declares: its status and its body."""

    status: StatusT
    body: BodyT


class ApiError(Exception):
    """A response outside 200-299 that was not asked for as a value.

    Any such status for a plain call; a status the operation does not
    declare for a \`_result\` call.
    """

    def __init__(self, status: int, body: object) -> None:
        """Keep the status and the parsed body of the response."""
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


class ResponseError(ApiError):
    """A response whose body is not what its operation declares."""


class PaginationError(RuntimeError):
    """A paginated list cannot be followed to its next page."""


class PathError(ValueError):
    """A path parameter that would make the request go to another path."""
`.trim();

const RUNTIME = `
# Where the next page is: a query to ask with, a URL to ask, or nowhere.
type _Step = tuple[Literal["query"], dict[str, Any]] | tuple[Literal["url"], str] | None


def _segment(value: str) -> str:
    """Encode a path parameter.

    Empty, \`.\` and \`..\` are refused: a URL with such a segment is the URL
    of another path, whatever the encoding.
    """
    if value in {"", ".", ".."}:
        message = f"{value!r} cannot be a segment of a path"
        raise PathError(message)
    return quote(value, safe="")


def _rest(value: str) -> str:
    """Encode a catch-all path parameter: it keeps its slashes."""
    if any(segment in {".", ".."} for segment in value.split("/")):
        message = f"{value!r} has a segment that is \`.\` or \`..\`"
        raise PathError(message)
    return quote(value, safe="/")


def _query(query: BaseModel | None) -> dict[str, Any]:
    """Write query parameters as httpx takes them; a list repeats its key."""
    if query is None:
        return {}
    values: dict[str, Any] = query.model_dump(
        mode="json", by_alias=True, exclude_unset=True
    )
    return {key: value for key, value in values.items() if value is not None}


def _body(adapter: TypeAdapter[Any], body: object) -> object:
    # Fields that were not set stay absent: absent and null are different.
    return adapter.dump_python(body, mode="json", by_alias=True, exclude_unset=True)


def _content(response: httpx.Response) -> object:
    """Read the body of a response: parsed JSON, the text, or None when empty."""
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _parse[T](status: int, content: object, adapter: TypeAdapter[T]) -> T:
    """Read a body as its type; one that is something else raises."""
    try:
        return adapter.validate_python(content)
    except ValidationError as error:
        raise ResponseError(status, content) from error


def _expect[T](response: httpx.Response, adapter: TypeAdapter[T]) -> T:
    """Parse the body of a success; any other status raises."""
    if not response.is_success:
        raise ApiError(response.status_code, _content(response))
    return _parse(response.status_code, _content(response), adapter)


def _result[T](
    response: httpx.Response,
    adapter: TypeAdapter[T],
    errors: Mapping[int, TypeAdapter[Any]],
) -> T | Fail[Any, Any]:
    """Parse the body of a success, or a declared error as a value."""
    declared = errors.get(response.status_code)
    if declared is None:
        return _expect(response, adapter)
    content = _content(response)
    try:
        return Fail(response.status_code, declared.validate_python(content))
    except ValidationError:
        # The status, from something that is not this API: a proxy, a
        # framework's own answer.
        raise ApiError(response.status_code, content) from None


def _at(value: object, path: str | None) -> object:
    """Find the value at a dot-notation path of a response."""
    if path is None:
        return None
    for key in path.split("."):
        if not isinstance(value, dict):
            return None
        value = cast("dict[str, Any]", value).get(key)
    return value


def _page_items(page: object, meta: Mapping[str, Any]) -> list[Any]:
    found = _at(page, meta.get("items"))
    return cast("list[Any]", found) if isinstance(found, list) else []


def _stuck(call: str, what: str) -> PaginationError:
    return PaginationError(
        f"{call}: the server answered with the {what} it was asked for; "
        "there is no next page to ask for"
    )


def _after_cursor(
    call: str, meta: Mapping[str, Any], page: object, query: Mapping[str, Any]
) -> _Step:
    cursor = _at(page, meta["cursor"])
    if cursor is None or cursor == "":
        return None
    if cursor == query.get(meta["cursorParam"]):
        raise _stuck(call, "cursor")
    return "query", {**query, meta["cursorParam"]: cursor}


def _after_item(
    call: str, meta: Mapping[str, Any], page: object, query: Mapping[str, Any]
) -> _Step:
    items = _page_items(page, meta)
    if not items:
        return None
    # A page shorter than the size asked for is the last one.
    limit = query.get(meta.get("limitParam", ""))
    if isinstance(limit, int) and len(items) < limit:
        return None
    last = _at(items[-1], meta["idField"])
    if last is None:
        field = meta["idField"]
        message = f'{call}: the last item of the page has no "{field}" to continue from'
        raise PaginationError(message)
    if str(last) == query.get(meta["cursorIdParam"]):
        raise _stuck(call, "item")
    return "query", {**query, meta["cursorIdParam"]: str(last)}


def _after_offset(
    meta: Mapping[str, Any], page: object, query: Mapping[str, Any]
) -> _Step:
    count = len(_page_items(page, meta))
    if count == 0:
        return None
    offset = int(query.get(meta["offsetParam"], 0)) + count
    total = _at(page, meta.get("total"))
    if isinstance(total, int) and offset >= total:
        return None
    return "query", {**query, meta["offsetParam"]: offset}


def _after_page(
    meta: Mapping[str, Any], page: object, query: Mapping[str, Any], page_size: int
) -> _Step:
    count = len(_page_items(page, meta))
    current = int(query.get(meta["pageParam"], 1))
    size = int(query.get(meta.get("perPageParam", ""), 0)) or page_size
    total_pages = _at(page, meta.get("totalPages"))
    total = _at(page, meta.get("total"))
    last = (
        count == 0
        or count < size
        or (isinstance(total_pages, int) and current >= total_pages)
        or (isinstance(total, int) and (current - 1) * size + count >= total)
    )
    return None if last else ("query", {**query, meta["pageParam"]: current + 1})


def _after_url(meta: Mapping[str, Any], page: object) -> _Step:
    url = _at(page, meta["nextUrl"])
    return ("url", url) if isinstance(url, str) and url != "" else None


def _next_page(
    call: str,
    meta: Mapping[str, Any],
    page: object,
    query: Mapping[str, Any],
    page_size: int,
) -> _Step:
    """Find where the page after \`page\` is, by pagination style."""
    style = meta["style"]
    if style == "cursor":
        return _after_cursor(call, meta, page, query)
    if style == "cursorId":
        return _after_item(call, meta, page, query)
    if style == "offset":
        return _after_offset(meta, page, query)
    if style == "page":
        return _after_page(meta, page, query, page_size)
    if style == "url":
        return _after_url(meta, page)
    message = f'{call}: unknown pagination style "{style}"'
    raise TypeError(message)


def _same_origin(call: str, page: httpx.URL, url: str) -> httpx.URL:
    """Resolve the URL of a next page against the page that names it.

    It has to be on the same origin: the client's headers are sent with it.
    """
    resolved = page.join(url)
    # A port that is the scheme's own is no port: \`http://h:80\` is \`http://h\`.
    origins = [(at.scheme, at.host, at.port) for at in (page, resolved)]
    if origins[0] != origins[1]:
        message = (
            f"{call}: the next page is on another origin ({resolved}); "
            "it is not followed"
        )
        raise PaginationError(message)
    return resolved
`.trim();

/** One operation, with the Python names the module gives its parts. */
interface Rendered {
  readonly operation: ContractOperation;
  /** `GET /notes/{id}`. */
  readonly label: string;
  readonly method: string;
  readonly query?: string;
  readonly body?: string;
  readonly response?: string;
  readonly errors: ReadonlyMap<string, string>;
  /** What `_result` returns, when the operation declares errors. */
  readonly result?: string;
  /** Type of one item of a paginated list. */
  readonly item?: string;
}

/** A banner between the parts of the module. */
function banner(title: string): string[] {
  const rule = `# ${"=".repeat(77)}`;
  return [rule, `# ${title}`, rule, "", ""];
}

/**
 * Render a contract as the source of a Python client module.
 *
 * Operations that stream server-sent events are listed in the module's
 * docstring and left out.
 */
export function renderPythonClient(
  contract: Contract,
  options: PythonClientOptions = {},
): string {
  const models = new PythonModels();
  const rendered: Rendered[] = [];
  const skipped: ContractOperation[] = [];
  /** What each `_result` returns: defined after the models. */
  const results: string[] = [];

  for (const operation of contract.operations) {
    if (operation.events) {
      skipped.push(operation);
      continue;
    }
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

    const response = part("Response", "response", operation.response, true);
    const itemSchema = operation.pagination && operation.response
      ? itemsSchema(operation.response, operation.pagination.items)
      : undefined;
    const query = part("Query", "query", operation.query, false);
    const body = part("Body", "body", operation.body, true);
    const errors = new Map(
      Object.entries(operation.errors ?? {}).map(([status, schema]) => [
        status,
        part(`Error${status}`, `${status} body`, schema, true)!,
      ]),
    );
    const item = part("Item", "items", itemSchema, true);

    // What a call that takes errors as values returns has a name.
    const result = errors.size > 0 ? `${base}Result` : undefined;
    if (result) {
      results.push(
        ...assignment(
          0,
          `type ${result}`,
          undefined,
          [
            response ?? "Any",
            ...[...errors].map(([status, type]) =>
              `Fail[Literal[${status}], ${type}]`
            ),
          ].join(" | "),
        ),
      );
    }

    rendered.push({
      operation,
      label,
      method: snakeCase(operation.operationId),
      ...(query && { query }),
      ...(body && { body }),
      ...(response && { response }),
      errors,
      ...(result && { result }),
      ...(item && { item }),
    });
  }

  const body: string[] = [
    PRELUDE,
    "",
    "",
    ...banner("Models"),
    ...models.render(),
    ...banner("Client"),
    ...(results.length > 0
      ? [
        "# What a call returns that takes the declared errors as values.",
        ...results,
        "",
      ]
      : []),
  ];
  for (const item of rendered) body.push(...adapters(item));
  body.push("", "", RUNTIME, "", "", ...clientClass(rendered, false));
  body.push("", "", ...clientClass(rendered, true));

  const source = body.join("\n");
  return [
    ...docstring(
      0,
      [
        `API models and client${
          options.source ? ` for ${options.source}` : ""
        }.`,
        "",
        "Generated by typed-endpoints. Do not edit.",
        "",
        "Needs Python 3.12.",
        ...(skipped.length > 0
          ? [
            "",
            "Not in this module: server-sent event streams (" +
            skipped.map((operation) =>
              `\`${operation.method} ${operation.path}\``
            ).join(", ") + ").",
          ]
          : []),
      ].join("\n"),
    ),
    "",
    ...imports(source, IMPORTS),
    "",
    // Two empty lines before a class.
    ...(models.usesSafeInt ? [SAFE_INT, "", ""] : [""]),
    source,
    "",
  ].join("\n");
}

function adapters(item: Rendered): string[] {
  const name = item.method.toUpperCase();
  const lines: string[] = [];
  if (item.body) {
    lines.push(
      ...assignment(
        0,
        `_${name}_BODY`,
        "TypeAdapter[Any]",
        `TypeAdapter(${item.body})`,
      ),
    );
  }
  // Without a response schema the body is returned as it was parsed.
  lines.push(
    ...assignment(
      0,
      `_${name}_RESPONSE`,
      `TypeAdapter[${item.response ?? "Any"}]`,
      `TypeAdapter(${item.response ?? "Any"})`,
    ),
  );
  if (item.errors.size > 0) {
    lines.push(
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
    );
  }
  if (item.operation.pagination) {
    lines.push(
      ...assignment(
        0,
        `_${name}_PAGINATION`,
        "dict[str, Any]",
        pythonLiteral(item.operation.pagination),
      ),
    );
    if (item.item) {
      lines.push(
        ...assignment(
          0,
          `_${name}_ITEM`,
          `TypeAdapter[${item.item}]`,
          `TypeAdapter(${item.item})`,
        ),
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
      `{${rest ? "_rest" : "_segment"}(${argumentName(name)})}`,
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
    '        """Send requests to `base_url`, with `http` if it is given.',
    "",
    "        A client that is given its `http` leaves it open when it is closed:",
    "        it belongs to whoever made it.",
    '        """',
    '        self._base_url = base_url.rstrip("/")',
    "        self._owns_http = http is None",
    `        self._http = http if http is not None else ${http}()`,
    "        self._headers = dict(headers or {})",
    "",
    `    ${def} ${isAsync ? "aclose" : "close"}(self) -> None:`,
    '        """Close the HTTP client, if this client made it."""',
    "        if self._owns_http:",
    `            ${wait}self._http.${isAsync ? "aclose" : "close"}()`,
    "",
    `    ${def} ${isAsync ? "__aenter__" : "__enter__"}(self) -> Self:`,
    '        """Use the client in a `with` statement, which closes it."""',
    "        return self",
    "",
    `    ${def} ${isAsync ? "__aexit__" : "__exit__"}(`,
    "        self,",
    "        kind: type[BaseException] | None,",
    "        error: BaseException | None,",
    "        traceback: TracebackType | None,",
    "    ) -> None:",
    '        """Close the client."""',
    `        ${wait}self.${isAsync ? "aclose" : "close"}()`,
    "",
    `    ${def} _send(`,
    "        self,",
    "        method: str,",
    "        path: str,",
    "        query: Mapping[str, Any] | None = None,",
    "        body: object = None,",
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
    `    ) -> ${iterator}[object]:`,
    '        """Yield every page of a list, as parsed JSON."""',
    "        url: httpx.URL | None = None",
    "        size: int | None = None",
    "        while True:",
    "            if url is None:",
    `                response = ${wait}self._send(method, path, query)`,
    "            else:",
    ...fit(
      16,
      "response = ",
      `${wait}self._http.request(method, url, headers=self._headers)`,
    ),
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
    "                url = _same_origin(call, response.url, step[1])",
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
  const { operation, label } = item;
  const { def, wait, iterator, loop } = words;
  const constant = item.method.toUpperCase();
  const response = item.response ?? "Any";

  const parameters = [
    "self",
    ...operation.pathParams.map(({ name }) => `${argumentName(name)}: str`),
    ...(item.body ? [`body: ${item.body}`] : []),
    ...(item.query ? [`query: ${item.query} | None = None`] : []),
  ];
  const send = `${wait}self._send(${
    [
      JSON.stringify(operation.method),
      pathExpression(operation),
      ...(item.query ? ["_query(query)"] : item.body ? ["None"] : []),
      ...(item.body ? [`_body(_${constant}_BODY, body)`] : []),
    ].join(", ")
  })`;
  const summary = (operation.summary ?? operation.description)?.trim();

  const lines: string[] = [
    ...signature(4, `${def} ${item.method}`, parameters, response),
    ...docstring(8, `Call \`${label}\`.${summary ? `\n\n${summary}` : ""}`),
    ...fit(8, "response = ", send),
    ...fit(8, "return ", `_expect(response, _${constant}_RESPONSE)`),
  ];

  if (item.result) {
    lines.push(
      "",
      ...signature(4, `${def} ${item.method}_result`, parameters, item.result),
      ...docstring(
        8,
        `Call \`${label}\`, with the declared errors as values.`,
      ),
      ...fit(8, "response = ", send),
      ...fit(
        8,
        "return ",
        `_result(response, _${constant}_RESPONSE, _${constant}_ERRORS)`,
      ),
    );
  }

  if (operation.pagination && item.response) {
    const pages = `self._pages(${
      [
        JSON.stringify(item.method),
        JSON.stringify(operation.method),
        pathExpression(operation),
        item.query ? "_query(query)" : "{}",
        `_${constant}_PAGINATION`,
      ].join(", ")
    })`;
    lines.push(
      "",
      ...signature(
        4,
        `${def} ${item.method}_pages`,
        parameters,
        `${iterator}[${item.response}]`,
      ),
      ...docstring(
        8,
        `Yield every page of \`${label}\`, from the one the query asks for.`,
      ),
      ...fit(8, `${loop} page in `, pages, ":"),
      `            yield _parse(200, page, _${constant}_RESPONSE)`,
    );
    if (item.item) {
      lines.push(
        "",
        ...signature(
          4,
          `${def} ${item.method}_items`,
          parameters,
          `${iterator}[${item.item}]`,
        ),
        ...docstring(8, `Yield every item of \`${label}\`, across its pages.`),
        ...fit(8, `${loop} page in `, pages, ":"),
        // The page is read as a page first: something else is not an
        // empty list.
        `            _parse(200, page, _${constant}_RESPONSE)`,
        `            for item in _page_items(page, _${constant}_PAGINATION):`,
        `                yield _parse(200, item, _${constant}_ITEM)`,
      );
    }
  }

  return lines;
}
