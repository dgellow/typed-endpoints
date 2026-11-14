/**
 * The fixed part of a generated FastAPI module that reads a request.
 *
 * FastAPI validates a request with Pydantic, whose rules are not Zod's:
 * what it accepts, what it refuses and how it says so differ. A contract
 * says what a request has to be, so the generated module carries the
 * contract's schemas as Python data and this small interpreter for them,
 * a port of the one the Rust module has (`src/rust/runtime.ts`). A request
 * is checked as plain JSON first, with every issue collected and worded
 * as Zod words it, and only then built into the model a handler receives.
 *
 * The text is Python as `ruff format` writes it and passes every ruff
 * rule and pyright in strict mode: `./scripts/test-python` runs them over
 * the module it becomes part of. A block is written only into a module
 * that uses it, so that no module defines a name it does not use.
 *
 * @module
 */

/** What a request part is checked against. */
export const CONTRACT = `
type _Schema = dict[str, Any]


@dataclass(frozen=True)
class _Part[T]:
    """A part of a request: what the contract says it is, and its type."""

    schema: _Schema
    adapter: TypeAdapter[T]
`.trim();

/** The checker of JSON values against a schema of the contract. */
export const CHECKING = `
# A value that is not there. Not None, which is the null of JSON.
_MISSING: Final = object()

# The largest integer a JavaScript number holds exactly.
_MAX_SAFE_INTEGER = 9007199254740991

# How far a number may be from a multiple of a step and still be one: what
# binary floating point makes of 0.3 / 0.1.
_STEP_TOLERANCE = 1e-9

# A string format, as Zod names it in a message.
_FORMATS = {
    "date-time": "ISO datetime",
    "date": "ISO date",
    "time": "ISO time",
    "duration": "ISO duration",
    "email": "email address",
    "uuid": "UUID",
    "uri": "URL",
    "ipv4": "IPv4 address",
    "ipv6": "IPv6 address",
}

# The bounds of a number: the keyword, whether a number is outside the
# bound, and the code and the words of the issue.
_BOUNDS = (
    ("minimum", operator.lt, "too_small", "Too small", ">="),
    ("exclusiveMinimum", operator.le, "too_small", "Too small", ">"),
    ("maximum", operator.gt, "too_big", "Too big", "<="),
    ("exclusiveMaximum", operator.ge, "too_big", "Too big", "<"),
)


def _resolved(root: _Schema, schema: _Schema) -> _Schema:
    """Give the schema itself, or the one it refers to."""
    while "$ref" in schema:
        reference: str = schema["$ref"]
        name = reference.removeprefix("#/$defs/")
        schema = root if reference == "#" else root["$defs"][name]
    return schema


def _types(schema: _Schema) -> list[str]:
    """List the JSON types a schema allows; none listed means any."""
    allowed: str | list[str] = schema.get("type", [])
    return [allowed] if isinstance(allowed, str) else allowed


def _type_of(value: object) -> str:
    """Name the JSON type of a value, as Zod does in a message.

    A number is a number: whether it is an integer is a question about its
    value.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    return "array" if isinstance(value, list) else "object"


def _expected(schema: _Schema) -> str:
    """Name the type a schema asks for, as Zod words it in a message."""
    # With null: the other type.
    named = [name for name in _types(schema) if name != "null"]
    if not named:
        # No type: anything, which a missing value is not.
        return "nonoptional"
    if named[0] == "array" and "prefixItems" in schema:
        return "tuple"
    if named[0] == "object" and "properties" not in schema:
        return "record"
    return "number" if named[0] == "integer" else named[0]


def _fits(allowed: list[str], value: object) -> bool:
    """Whether a value has one of the JSON types listed.

    An integer is a number without a fraction. Infinity, which only text
    can be read as, is no number.
    """
    actual = _type_of(value)
    if actual != "number":
        return actual in allowed
    if "number" in allowed:
        return not (isinstance(value, float) and math.isinf(value))
    whole = isinstance(value, int) or cast("float", value).is_integer()
    return "integer" in allowed and whole


def _is_union(schema: _Schema) -> bool:
    """Whether a schema lists several types.

    Null beside one other type is that type, nullable; beside several it is
    a union.
    """
    return len([name for name in _types(schema) if name != "null"]) > 1


def _as_javascript(number: float) -> float:
    """Read a number as JavaScript does, which has one kind: 2.0 is 2."""
    whole = number.is_integer() and abs(number) <= _MAX_SAFE_INTEGER
    return int(number) if whole else number


def _is_literal(expected: object, value: object) -> bool:
    """Whether a value is the one a schema names: True is not 1."""
    return _type_of(expected) == _type_of(value) and expected == value


def _written(value: object) -> str:
    """Write a value a schema names as JSON, for a message."""
    return json.dumps(value, ensure_ascii=False)


class _Checker:
    """Checks JSON values against a schema and collects what is wrong.

    It reads the JSON Schema that a contract has, not all of JSON Schema,
    and gives an issue the code and the words Zod gives it. A value is only
    read, so trying an alternative of a union costs no copy.
    """

    def __init__(self, root: _Schema, *, text: bool) -> None:
        self.root = root
        # Whether the values arrived as text (a query, a path).
        self.text = text
        # Where the value being checked is: keys and indexes from the root.
        self.path: list[str | int] = []
        self.issues: list[InvalidRequestIssue] = []

    def issue(self, code: str, message: str) -> None:
        found = InvalidRequestIssue(path=list(self.path), message=message, code=code)
        self.issues.append(found)

    def fits(self, schema: _Schema, value: object) -> bool:
        trial = _Checker(self.root, text=self.text)
        trial.check(schema, value)
        return not trial.issues

    def check_at(self, step: str | int, schema: _Schema, value: object) -> None:
        self.path.append(step)
        self.check(schema, value)
        self.path.pop()

    def check(self, schema: _Schema, value: object) -> None:
        schema = _resolved(self.root, schema)
        alternatives: list[_Schema] | None = schema.get("anyOf", schema.get("oneOf"))
        # A value that is listed: a missing one is not.
        if "const" in schema:
            if not _is_literal(schema["const"], value):
                expected = _written(schema["const"])
                self.issue("invalid_value", f"Invalid input: expected {expected}")
        elif "enum" in schema:
            options: list[object] = schema["enum"]
            if not any(_is_literal(option, value) for option in options):
                listed = "|".join(_written(option) for option in options)
                self.issue("invalid_value", f"Invalid option: expected one of {listed}")
        elif alternatives is not None:
            self.check_alternatives(schema, alternatives, value)
        elif value is _MISSING:
            self.check_missing(schema)
        elif "allOf" in schema:
            for part in schema["allOf"]:
                self.check(part, value)
        elif self.has_type(schema, value):
            self.check_value(schema, value)

    def check_missing(self, schema: _Schema) -> None:
        if _is_union(schema):
            self.issue("invalid_union", "Invalid input")
        else:
            expected = _expected(schema)
            message = f"Invalid input: expected {expected}, received undefined"
            self.issue("invalid_type", message)

    def has_type(self, schema: _Schema, value: object) -> bool:
        allowed = _types(schema)
        if not allowed or _fits(allowed, value):
            return True
        received = self.received(allowed, value)
        if _is_union(schema):
            self.issue("invalid_union", "Invalid input")
        elif "integer" in allowed and received == "number":
            # The right kind and the wrong value.
            self.issue("invalid_type", "Invalid input: expected int, received number")
        else:
            expected = _expected(schema)
            message = f"Invalid input: expected {expected}, received {received}"
            self.issue("invalid_type", message)
        return False

    def received(self, allowed: list[str], value: object) -> str:
        # What Zod says it received: a type, or what the number is that
        # text was read as and that is none.
        if isinstance(value, float) and math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        numeric = "integer" in allowed or "number" in allowed
        if self.text and numeric and isinstance(value, str):
            return "NaN"
        return _type_of(value)

    def check_alternatives(
        self, schema: _Schema, alternatives: list[_Schema], value: object
    ) -> None:
        # T or null: what is wrong with a value that is not null is what is
        # wrong with it as a T.
        others = [
            alternative
            for alternative in alternatives
            if _types(_resolved(self.root, alternative)) != ["null"]
        ]
        tag: str | None = schema.get("discriminator", {}).get("propertyName")
        if len(others) == 1 and len(alternatives) > 1:
            if value is not None:
                self.check(others[0], value)
        elif tag is not None:
            self.check_tagged(tag, alternatives, value)
        # Each alternative is tried once. One that fits has nothing to
        # report, so it is not checked a second time: in a union that refers
        # to itself that would double the work at every level.
        elif value is _MISSING or not any(
            self.fits(alternative, value) for alternative in alternatives
        ):
            self.issue("invalid_union", "Invalid input")

    def check_tagged(
        self, tag: str, alternatives: list[_Schema], value: object
    ) -> None:
        # A member that tells the alternatives apart decides which one the
        # value is checked as. The contract names it.
        if not isinstance(value, dict):
            received = "undefined" if value is _MISSING else _type_of(value)
            message = f"Invalid input: expected object, received {received}"
            self.issue("invalid_type", message)
            return
        constants: list[object] = [
            _resolved(self.root, alternative)["properties"][tag]["const"]
            for alternative in alternatives
        ]
        members = cast("dict[str, object]", value)
        given = members.get(tag)
        if isinstance(given, str) and given in constants:
            self.check(alternatives[constants.index(given)], members)
            return
        listed = " | ".join(f"'{constant}'" for constant in constants)
        self.path.append(tag)
        message = f"Invalid discriminator value. Expected {listed}"
        self.issue("invalid_union", message)
        self.path.pop()

    def check_value(self, schema: _Schema, value: object) -> None:
        if isinstance(value, str):
            self.check_string(schema, value)
        elif isinstance(value, list):
            self.check_array(schema, cast("list[object]", value))
        elif isinstance(value, dict):
            self.check_object(schema, cast("dict[str, object]", value))
        elif isinstance(value, int | float) and not isinstance(value, bool):
            self.check_number(schema, value)

    def check_string(self, schema: _Schema, text: str) -> None:
        # In code points, as JSON Schema counts.
        minimum: int | None = schema.get("minLength")
        if minimum is not None and len(text) < minimum:
            message = f"Too small: expected string to have >={minimum} characters"
            self.issue("too_small", message)
        maximum: int | None = schema.get("maxLength")
        if maximum is not None and len(text) > maximum:
            message = f"Too big: expected string to have <={maximum} characters"
            self.issue("too_big", message)
        pattern: str | None = schema.get("pattern")
        if pattern is not None and not _pattern(pattern).search(text):
            # A format is written as a pattern; its name says what is wrong.
            form: str | None = schema.get("format")
            if form is None:
                message = f"Invalid string: must match pattern /{pattern}/"
            else:
                message = f"Invalid {_FORMATS.get(form, form)}"
            self.issue("invalid_format", message)

    def check_number(self, schema: _Schema, amount: float) -> None:
        # An integer is one a JavaScript number holds exactly. Zod says
        # "int" for that bound, before any bound the schema states.
        integer = "integer" in _types(schema)
        if integer and amount > _MAX_SAFE_INTEGER:
            message = f"Too big: expected int to be <={_MAX_SAFE_INTEGER}"
            self.issue("too_big", message)
        if integer and amount < -_MAX_SAFE_INTEGER:
            message = f"Too small: expected int to be >=-{_MAX_SAFE_INTEGER}"
            self.issue("too_small", message)
        for keyword, outside, code, words, sign in _BOUNDS:
            bound: float | None = schema.get(keyword)
            # The contract states that bound again for every integer.
            stated = integer and bound in {_MAX_SAFE_INTEGER, -_MAX_SAFE_INTEGER}
            if bound is not None and not stated and outside(amount, bound):
                self.issue(code, f"{words}: expected number to be {sign}{bound}")
        step: float | None = schema.get("multipleOf")
        if step:
            steps = amount / step
            if abs(steps - round(steps)) > _STEP_TOLERANCE:
                message = f"Invalid number: must be a multiple of {step}"
                self.issue("not_multiple_of", message)

    def check_array(self, schema: _Schema, items: list[object]) -> None:
        minimum: int | None = schema.get("minItems")
        if minimum is not None and len(items) < minimum:
            message = f"Too small: expected array to have >={minimum} items"
            self.issue("too_small", message)
        maximum: int | None = schema.get("maxItems")
        if maximum is not None and len(items) > maximum:
            message = f"Too big: expected array to have <={maximum} items"
            self.issue("too_big", message)
        # A tuple gives a schema per position; a list one for every item.
        positioned: list[_Schema] = schema.get("prefixItems", [])
        each: object = schema.get("items")
        for index, item in enumerate(items):
            member = positioned[index] if index < len(positioned) else each
            if isinstance(member, dict):
                self.check_at(index, cast("_Schema", member), item)

    def check_object(self, schema: _Schema, members: dict[str, object]) -> None:
        properties: dict[str, _Schema] = schema.get("properties", {})
        required: list[str] = schema.get("required", [])
        for name, member in properties.items():
            if name in members:
                self.check_at(name, member, members[name])
            elif name in required:
                self.check_at(name, member, _MISSING)
        # Members the schema does not name: refused by a closed object,
        # checked by a mapping, ignored otherwise.
        unknown = [name for name in members if name not in properties]
        additional: object = schema.get("additionalProperties")
        if isinstance(additional, dict):
            for name in unknown:
                self.check_at(name, cast("_Schema", additional), members[name])
        elif additional is False and unknown:
            noun = "key" if len(unknown) == 1 else "keys"
            listed = ", ".join(f'"{name}"' for name in unknown)
            self.issue("unrecognized_keys", f"Unrecognized {noun}: {listed}")


def _issues(schema: _Schema, value: object, *, text: bool) -> list[InvalidRequestIssue]:
    """List what is wrong with a value: nothing, if it fits its schema."""
    checker = _Checker(schema, text=text)
    checker.check(schema, value)
    return checker.issues
`.trim();

/** What answers a request that does not reach its handler. */
export const REFUSING = `
type _PartName = Literal["body", "query", "params"]

_PREFIX = {
    "body": "Validation error",
    "query": "Query validation error",
    "params": "Params validation error",
}


# In a path: a percent sign that does not start an escape.
_NO_ESCAPE = re.compile(rb"%(?![0-9A-Fa-f]{2})")


class _RefusedError(Exception):
    """A request that does not reach its handler: the response that answers it."""

    def __init__(self, response: Response) -> None:
        super().__init__(response.status_code)
        self.response = response


class _Route(APIRoute):
    """A route that answers a request that is refused.

    The answer is the router's own, whatever application it is included in:
    no exception handler has to be installed for it.
    """

    @override
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handle = super().get_route_handler()

        async def answer(request: Request) -> Response:
            # Before anything is read: the path is what led here.
            if _is_malformed(request.scope.get("raw_path")):
                return JSONResponse({"error": "Malformed URL path"}, status_code=400)
            try:
                return await handle(request)
            except _RefusedError as refused:
                return refused.response

        return answer


def _is_malformed(path: object) -> bool:
    """Whether a path, as it was sent, cannot be decoded.

    The server has decoded it all the same, and has put U+FFFD where it
    could not.
    """
    if not isinstance(path, bytes):
        # The server does not say what was sent.
        return False
    if _NO_ESCAPE.search(path):
        return True
    try:
        unquote_to_bytes(path).decode()
    except UnicodeDecodeError:
        return True
    return False


def _refusal(
    status: int,
    error: str,
    part: Literal["body", "query", "params", "json", "content-type"],
    issues: list[InvalidRequestIssue],
) -> JSONResponse:
    """Answer a request that is refused: which part, and each issue."""
    body = InvalidRequest(error=error, part=part, issues=issues)
    return JSONResponse(body.model_dump(by_alias=True), status_code=status)


def _invalid(name: _PartName, issues: list[InvalidRequestIssue]) -> JSONResponse:
    """Answer a request that fails validation, as the TypeScript handlers do."""
    listed = ", ".join(
        f"{'.'.join(str(key) for key in issue.path)}: {issue.message}"
        if issue.path
        else issue.message
        for issue in issues
    )
    return _refusal(400, f"{_PREFIX[name]}: {listed}", name, issues)


def _typed[T](name: _PartName, part: _Part[T], value: object) -> T:
    """Give a part of a request as its type, if the contract accepts it."""
    issues = _issues(part.schema, value, text=name != "body")
    if issues:
        raise _RefusedError(_invalid(name, issues))
    try:
        # By the names of the contract only, and with the types the contract
        # checked: a list for a tuple.
        return part.adapter.validate_python(
            None if value is _MISSING else value,
            strict=False,
            by_alias=True,
            by_name=False,
        )
    except ValidationError:
        # The contract accepts the value and its type does not: the two
        # were generated from the same contract and disagree.
        logger.exception("the %s the contract accepts does not fit its type", name)
        raise _RefusedError(_internal_error()) from None
`.trim();

/** Query and path values, which arrive as text. */
export const TEXT = `
# A number as JavaScript reads it from text: a decimal one, or an integer
# in another base.
_DECIMAL = re.compile(
    r"[+-]?(?:Infinity|(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
)

_OTHER_BASE = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")


def _number_from_text(text: str) -> float | None:
    """Give the number a text is, as JavaScript converts text to a number.

    Blank text is 0, and 0x, 0o and 0b start a hexadecimal, octal or binary
    integer. A number too large to be one is infinity, which the checker
    refuses by that name.
    """
    text = text.strip()
    if not text:
        return 0
    if _OTHER_BASE.fullmatch(text):
        return int(text, 0)
    return _as_javascript(float(text)) if _DECIMAL.fullmatch(text) else None


def _from_text(root: _Schema, schema: _Schema, value: object) -> object:
    """Turn a value that arrived as text into what its schema asks for.

    Query and path values are text. Where the schema asks for a number, a
    boolean or a list, the text becomes one before it is checked; text that
    is not one stays as it is and fails the check.
    """
    schema = _resolved(root, schema)
    if isinstance(value, str):
        return _text_as(root, schema, value)
    if isinstance(value, dict):
        return _members_from_text(root, schema, cast("dict[str, object]", value))
    if isinstance(value, list):
        items = cast("list[object]", value)
        each: object = schema.get("items")
        if isinstance(each, dict):
            item = cast("_Schema", each)
            return [_from_text(root, item, one) for one in items]
        return items
    return value


def _text_as(root: _Schema, schema: _Schema, text: str) -> object:
    allowed = _types(schema)
    numeric = "integer" in allowed or "number" in allowed
    number = _number_from_text(text) if numeric else None
    if number is not None:
        return number
    if "boolean" in allowed and text in {"true", "false"}:
        return text == "true"
    # One occurrence of a key that takes a list.
    return _from_text(root, schema, [text]) if "array" in allowed else text


def _members_from_text(
    root: _Schema, schema: _Schema, members: dict[str, object]
) -> dict[str, object]:
    properties: dict[str, _Schema] = schema.get("properties", {})
    shaped = {
        name: _from_text(root, properties[name], member)
        if name in properties
        else member
        for name, member in members.items()
    }
    # No occurrence of a key that takes a list, and has to be there.
    for name in schema.get("required", []):
        if name not in shaped and "array" in _types(_resolved(root, properties[name])):
            shaped[name] = []
    return shaped
`.trim();

/** Reading a JSON body. */
export const BODY = `
def _not_json(content_type: str | None) -> JSONResponse:
    """Answer a body that is not JSON.

    A body is taken to be meant as JSON when its Content-Type says so, says
    text/plain or is not there: a client that sets no header sends a text
    body as text/plain.
    """
    media = (content_type or "").split(";")[0].strip().lower()
    if media in {"", "application/json", "text/plain"} or media.endswith("+json"):
        return _refusal(400, "Invalid JSON body", "json", [])
    error = f'Unsupported content type "{content_type}": the body has to be JSON'
    return _refusal(415, error, "content-type", [])


class _NotJsonError(ValueError):
    """A number Python's parser reads and JSON does not have."""


def _json_number(text: str) -> float:
    number = float(text)
    if math.isinf(number):
        # Too large to be a number, and JSON has no infinity.
        raise _NotJsonError(text)
    return _as_javascript(number)


def _json_constant(name: str) -> float:
    # NaN and the infinities.
    raise _NotJsonError(name)


async def _body[T](request: Request, part: _Part[T]) -> T:
    """Read the JSON body of a request as its type.

    A request without a body is checked as a missing value.
    """
    content_type = request.headers.get("content-type")
    # As JavaScript reads a body: a byte that is not UTF-8 is U+FFFD.
    text = (await request.body()).decode(errors="replace")
    try:
        value: object = _MISSING
        if text.strip():
            value = json.loads(
                text, parse_float=_json_number, parse_constant=_json_constant
            )
        return _typed("body", part, value)
    except (json.JSONDecodeError, _NotJsonError, RecursionError):
        # Not JSON, or nested deeper than this server follows it.
        raise _RefusedError(_not_json(content_type)) from None
`.trim();

/** Reading a query string. */
export const QUERY = `
def _query[T](request: Request, part: _Part[T]) -> T:
    """Read the query string of a request as its type.

    A key that occurs several times is a list.
    """
    given = request.query_params
    members: dict[str, object] = {}
    for name in given:
        values = given.getlist(name)
        members[name] = values[0] if len(values) == 1 else values
    return _typed("query", part, _from_text(part.schema, part.schema, members))
`.trim();

/** Reading path parameters. */
export const PARAMS = `
def _params[T](request: Request, part: _Part[T]) -> T:
    """Read the path parameters of a request as their type."""
    members = dict(request.path_params)
    return _typed("params", part, _from_text(part.schema, part.schema, members))
`.trim();

/** The request of an operation, for the description FastAPI serves. */
export const DESCRIBED = `
# What is not a schema in a schema: the values it names.
_VALUES = frozenset({"const", "default", "enum", "required"})


def _inlined(root: _Schema, schema: object, inside: tuple[str, ...] = ()) -> object:
    """Give a schema without references, for where they would not resolve.

    A schema that refers to itself is described down to that reference.
    """
    if isinstance(schema, list):
        return [_inlined(root, each, inside) for each in cast("list[object]", schema)]
    if not isinstance(schema, dict):
        return schema
    rules = cast("_Schema", schema)
    reference: str | None = rules.get("$ref")
    if reference is not None:
        if reference in inside:
            return {}
        return _inlined(root, _resolved(root, rules), (*inside, reference))
    described: _Schema = {}
    for keyword, value in rules.items():
        if keyword == "properties":
            described[keyword] = {
                name: _inlined(root, member, inside)
                for name, member in cast("dict[str, object]", value).items()
            }
        elif keyword != "$defs":
            keep = keyword in _VALUES
            described[keyword] = value if keep else _inlined(root, value, inside)
    return described


def _parameters(place: str, part: _Part[Any] | None) -> list[dict[str, Any]]:
    if part is None:
        return []
    schema = _resolved(part.schema, part.schema)
    required: list[str] = schema.get("required", [])
    properties: dict[str, _Schema] = schema.get("properties", {})
    return [
        {
            "name": name,
            "in": place,
            "required": place == "path" or name in required,
            "schema": _inlined(part.schema, member),
        }
        for name, member in properties.items()
    ]


def _described(
    *,
    params: _Part[Any] | None = None,
    query: _Part[Any] | None = None,
    body: _Part[Any] | None = None,
) -> dict[str, Any]:
    """Describe the request of an operation, for the description FastAPI serves.

    FastAPI describes a request from the arguments of a route function. The
    route functions here take the request as it is, and the contract says
    what it has to be.
    """
    described: dict[str, Any] = {}
    parameters = [*_parameters("path", params), *_parameters("query", query)]
    if parameters:
        described["parameters"] = parameters
    if body is not None:
        schema = _inlined(body.schema, body.schema)
        described["requestBody"] = {
            # Unless the contract accepts a request without a body.
            "required": bool(_issues(body.schema, _MISSING, text=False)),
            "content": {"application/json": {"schema": schema}},
        }
    return described
`.trim();
