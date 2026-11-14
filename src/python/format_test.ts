/**
 * Python statements, laid out as `ruff format` lays them out.
 *
 * These tests state the rules. That the formatter agrees with them is
 * established by `./scripts/test-python`, which runs it over the
 * generated modules.
 */

import { assertEquals } from "@std/assert";

import {
  assignment,
  docstring,
  fit,
  fromImport,
  imports,
  signature,
  splitTop,
  stringConstant,
  stringLiteral,
} from "./format.ts";

const LONG = "VeryLongClassNameNumberOne";
const LONGER = "VeryLongClassNameNumberTwo";

Deno.test("python format: a text is split outside brackets and strings only", () => {
  assertEquals(splitTop("a, b[c, d], e", ", "), ["a", "b[c, d]", "e"]);
  assertEquals(splitTop('f(x, "a, b"), g', ", "), ['f(x, "a, b")', "g"]);
  assertEquals(splitTop("A | list[B | C] | None", " | "), [
    "A",
    "list[B | C]",
    "None",
  ]);
});

Deno.test("python format: a call that is too wide breaks at its brackets, then at each argument", () => {
  // What fits stays on one line.
  assertEquals(fit(4, "x = ", "Field(default=None)"), [
    "    x = Field(default=None)",
  ]);
  // The arguments on a line of their own, without a comma after the last.
  assertEquals(
    assignment(
      4,
      "model_config",
      undefined,
      'ConfigDict(strict=True, extra="forbid", populate_by_name=True, regex_engine="python-re")',
    ),
    [
      "    model_config = ConfigDict(",
      '        strict=True, extra="forbid", populate_by_name=True, regex_engine="python-re"',
      "    )",
    ],
  );
  // An argument per line, with a comma after the last.
  assertEquals(
    assignment(
      4,
      "class_",
      "str | None",
      'Field(default=None, validation_alias="class", serialization_alias="class", description="A long description")',
    ),
    [
      "    class_: str | None = Field(",
      "        default=None,",
      '        validation_alias="class",',
      '        serialization_alias="class",',
      '        description="A long description",',
      "    )",
    ],
  );
});

Deno.test("python format: the items of a dict or a list never share a line once it breaks", () => {
  assertEquals(
    assignment(
      0,
      "_EVENTS",
      "dict[str, TypeAdapter[Any]]",
      '{"tick": TypeAdapter(TicksListTickData), "done": TypeAdapter(TicksListDoneData)}',
    ),
    [
      "_EVENTS: dict[str, TypeAdapter[Any]] = {",
      '    "tick": TypeAdapter(TicksListTickData),',
      '    "done": TypeAdapter(TicksListDoneData),',
      "}",
    ],
  );
});

Deno.test("python format: a union with no bracket around it is put in parentheses", () => {
  assertEquals(
    assignment(
      0,
      "type Json",
      undefined,
      `str | float | bool | list[Json] | dict[str, Json] | ${LONG}Type | None`,
    ),
    [
      "type Json = (",
      "    str",
      "    | float",
      "    | bool",
      "    | list[Json]",
      "    | dict[str, Json]",
      `    | ${LONG}Type`,
      "    | None",
      ")",
    ],
  );
  // In the parentheses on one line, when that fits.
  assertEquals(
    assignment(
      0,
      "type Json",
      undefined,
      `str | bool | list[Json] | dict[str, Json] | ${LONG} | OtherType`,
    ),
    [
      "type Json = (",
      `    str | bool | list[Json] | dict[str, Json] | ${LONG} | OtherType`,
      ")",
    ],
  );
  // Too wide for one line: a member per line, the operator first.
  assertEquals(
    assignment(
      4,
      "shape",
      `${LONG} | ${LONGER} | ${LONG}2 | ${LONGER}2 | None`,
      "None",
    ),
    [
      "    shape: (",
      `        ${LONG}`,
      `        | ${LONGER}`,
      `        | ${LONG}2`,
      `        | ${LONGER}2`,
      "        | None",
      "    ) = None",
    ],
  );
  // The value is broken before the annotation is.
  assertEquals(
    assignment(
      4,
      "shape",
      `${LONG} | ${LONGER}`,
      'Field(discriminator="kind")',
    ),
    [
      `    shape: ${LONG} | ${LONGER} = Field(`,
      '        discriminator="kind"',
      "    )",
    ],
  );
  // One item of a subscript has no comma: with one it would be a tuple.
  assertEquals(
    assignment(4, "items", `list[${LONG}${LONGER}${LONG}${LONGER}]`, undefined),
    [
      "    items: list[",
      `        ${LONG}${LONGER}${LONG}${LONGER}`,
      "    ]",
    ],
  );
});

Deno.test("python format: a signature keeps its parameters together while they fit on a line", () => {
  assertEquals(
    signature(4, "async def f", ["self", "params: P"], "R"),
    ["    async def f(self, params: P) -> R:"],
  );
  assertEquals(
    signature(
      4,
      "async def notes_delete",
      ["self", "params: NotesDeleteParams", "body: NotesDeleteBody"],
      "NotesDeleteResult",
    ),
    [
      "    async def notes_delete(",
      "        self, params: NotesDeleteParams, body: NotesDeleteBody",
      "    ) -> NotesDeleteResult:",
    ],
  );
  // One parameter gets a comma, and with it a line of its own.
  assertEquals(
    signature(
      4,
      "async def one_parameter_that_is_long_enough_to_need_a_line",
      [`parameter_name_one: ${LONG}${LONGER}`],
      "None",
    ),
    [
      "    async def one_parameter_that_is_long_enough_to_need_a_line(",
      `        parameter_name_one: ${LONG}${LONGER},`,
      "    ) -> None:",
    ],
  );
});

Deno.test("python format: a docstring is a summary line, then the rest", () => {
  // A full stop is added; one line stays one line.
  assertEquals(docstring(4, "A note"), ['    """A note."""']);
  assertEquals(docstring(4, "Is it?"), ['    """Is it?"""']);
  // More than a line: the closing quotes on a line of their own.
  assertEquals(docstring(4, "A note.\n\nKept until deleted."), [
    '    """A note.',
    "",
    "    Kept until deleted.",
    '    """',
  ]);
  // A first line that cannot be a summary gets one.
  const long = "word ".repeat(30).trim();
  assertEquals(docstring(4, long, { summary: "The words" }).slice(0, 3), [
    '    """The words.',
    "",
    // 84 columns: the 88 of a line, less the indentation.
    `    ${"word ".repeat(17).trim()}`,
  ]);
  // Kept as it is: the text of a description is the user's.
  assertEquals(docstring(4, "Where it is kept", { verbatim: true }), [
    '    """Where it is kept"""',
  ]);
});

Deno.test("python format: a string is raw when it has backslashes, and in pieces when it is long", () => {
  assertEquals(stringLiteral("^\\d+$"), 'r"^\\d+$"');
  assertEquals(stringLiteral("plain"), '"plain"');
  // A raw string cannot hold a quote or end in a backslash.
  assertEquals(stringLiteral('\\d"'), '"\\\\d\\""');

  const pattern = "^(alpha|beta|gamma)-" + "[0-9a-f]{4}-".repeat(8) + "end$";
  const lines = stringConstant(0, "_PATTERN", pattern);
  assertEquals(lines[0], "_PATTERN = (");
  assertEquals(lines.at(-1), ")");
  assertEquals(lines.every((line) => line.length <= 88), true);
  // The pieces are the text.
  assertEquals(
    lines.slice(1, -1).map((line) => JSON.parse(line.trim())).join(""),
    pattern,
  );
});

Deno.test("python format: imports are what the source names, in the formatter's order", () => {
  assertEquals(fromImport("typing", ["cast", "Any", "TYPE_CHECKING"]), [
    "from typing import TYPE_CHECKING, Any, cast",
  ]);
  assertEquals(
    imports(
      "x: Any = json.loads(text)\nlogger = logging.getLogger()\nField()\n",
      [
        [["json", []], ["logging", []], ["typing", ["Any", "Literal"]]],
        [["httpx", []], ["pydantic", ["BaseModel", "Field"]]],
      ],
    ),
    [
      "import json",
      "import logging",
      "from typing import Any",
      "",
      "from pydantic import Field",
    ],
  );
});
