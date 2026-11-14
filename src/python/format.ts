/**
 * Python source laid out as `ruff format` lays it out.
 *
 * The generators build a statement as one line of text. A line that is
 * too wide is broken here the way the formatter breaks it, so that the
 * generated module is one the formatter leaves alone:
 *
 * - at the brackets that end it: what is between them moves to a line of
 *   its own, and if that is still too wide, each item to a line of its
 *   own, with a comma after the last
 * - a union with no bracket around it is put in parentheses, and broken
 *   before each `|` if it has to be
 *
 * Only the shapes the generators write are handled. That the result is
 * what the formatter writes is established by running the formatter over
 * the generated modules (`./scripts/test-python`).
 *
 * @module
 */

/** The widest line the formatter writes. */
export const WIDTH = 88;

const CLOSERS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

/**
 * The parts of a text between a separator, where the separator is not
 * inside brackets or a string literal.
 */
export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c in CLOSERS) {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    } else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** An expression that ends in brackets: `head(items)`, `head[items]`. */
interface Bracketed {
  readonly head: string;
  readonly open: string;
  readonly close: string;
  readonly items: readonly string[];
}

/** The expression as a head and what is in its last brackets, if it is one. */
function bracketed(text: string): Bracketed | undefined {
  const close = text.at(-1);
  if (close !== ")" && close !== "]" && close !== "}") return undefined;
  // The bracket that the last one closes.
  let depth = 0;
  let quote = "";
  let opened = -1;
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c in CLOSERS) {
      stack.push(i);
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      opened = stack.pop() ?? -1;
      depth--;
      // Closed before the end: the text is not one bracketed expression.
      if (depth === 0 && i < text.length - 1) opened = -1;
    }
  }
  if (opened < 0) return undefined;
  const head = text.slice(0, opened);
  // `a | b[c]` ends in brackets and is a union.
  if (splitTop(head, " | ").length > 1) return undefined;
  const inner = text.slice(opened + 1, -1);
  return {
    head,
    open: text[opened],
    close,
    items: inner === "" ? [] : splitTop(inner, ", "),
  };
}

/** What comes before the value of an item: `name=`, `key: `. */
function itemPrefix(item: string, open: string): string {
  if (open === "(") return /^\w+=/.exec(item)?.[0] ?? "";
  if (open === "{") {
    const [key, ...rest] = splitTop(item, ": ");
    return rest.length > 0 ? `${key}: ` : "";
  }
  return "";
}

/** The members of a union, each on a line of its own, `|` first. */
function unionLines(
  indent: number,
  prefix: string,
  members: readonly string[],
  suffix: string,
): string[] {
  return members.flatMap((member, i) =>
    fit(
      indent,
      i === 0 ? prefix : "| ",
      member,
      i === members.length - 1 ? suffix : "",
      true,
    )
  );
}

/**
 * `prefix` `text` `suffix` as lines no wider than the formatter writes,
 * where `text` is an expression.
 *
 * @param indent The columns the first line starts at.
 * @param inside Whether the expression is inside brackets already, where
 * a union needs no parentheses of its own.
 */
export function fit(
  indent: number,
  prefix: string,
  text: string,
  suffix = "",
  inside = false,
): string[] {
  const pad = " ".repeat(indent);
  const line = `${pad}${prefix}${text}${suffix}`;
  if (line.length <= WIDTH) return [line];

  const members = splitTop(text, " | ");
  if (members.length > 1) {
    if (inside) return unionLines(indent, prefix, members, suffix);
    const inner = `${pad}    ${text}`;
    return [
      `${pad}${prefix}(`,
      ...(inner.length <= WIDTH
        ? [inner]
        : unionLines(indent + 4, "", members, "")),
      `${pad})${suffix}`,
    ];
  }

  // A string too long for its line, as the pieces Python joins. In
  // parentheses: without them, two strings in a list read as two items
  // with a comma forgotten.
  if (inside && STRING.test(text)) {
    return [
      `${pad}${prefix}(`,
      ...stringPieces(text, WIDTH - indent - 4).map((piece) =>
        `${pad}    ${piece}`
      ),
      `${pad})${suffix}`,
    ];
  }

  const group = bracketed(text);
  if (!group || group.items.length === 0) return [line];
  const first = `${pad}${prefix}${group.head}${group.open}`;
  const last = `${pad}${group.close}${suffix}`;
  const inner = `${pad}    ${group.items.join(", ")}`;
  // The arguments of a call and the items of a subscript stay together
  // on a line if they fit; the items of a list or a dict never do.
  const display = group.head === "" || group.open === "{";
  if (!display && inner.length <= WIDTH) return [first, inner, last];
  // One item has no comma after it. (In a subscript it would make a tuple.)
  const comma = group.items.length === 1 ? "" : ",";
  return [
    first,
    ...group.items.flatMap((item) => {
      const lead = itemPrefix(item, group.open);
      return fit(indent + 4, lead, item.slice(lead.length), comma, true);
    }),
    last,
  ];
}

/** One string literal, and nothing else. */
const STRING = /^r?"(?:[^"\\]|\\.)*"$/;

/**
 * A string literal as literals no wider than `room`, which Python joins
 * when they follow each other. A piece ends after a space where it can,
 * and never inside an escape.
 */
function stringPieces(literal: string, room: number): string[] {
  const raw = literal.startsWith("r") ? "r" : "";
  const content = literal.slice(raw.length + 1, -1);
  // What cannot be cut: an escape, or one character.
  const units = content.match(/\\u[0-9a-fA-F]{4}|\\.|[^\\]/gu) ?? [];
  const width = Math.max(room - raw.length - 2, 1);
  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current.length + unit.length > width) {
      // Rather after the last space, if that is not far back.
      const space = current.lastIndexOf(" ") + 1;
      const cut = space > width - 24 ? space : current.length;
      pieces.push(current.slice(0, cut));
      current = current.slice(cut);
    }
    current += unit;
  }
  pieces.push(current);
  return pieces.map((piece) => {
    // Each piece has the quotes that need no escape in it, as the
    // formatter chooses them.
    const single = !raw && piece.includes('\\"') && !piece.includes("'");
    return single
      ? `'${piece.replace(/\\(.)/gu, (escape, c) => c === '"' ? c : escape)}'`
      : `${raw}"${piece}"`;
  });
}

/**
 * An assignment: `target = value`, `target: annotation`,
 * `target: annotation = value`.
 */
export function assignment(
  indent: number,
  target: string,
  annotation: string | undefined,
  value: string | undefined,
): string[] {
  const pad = " ".repeat(indent);
  const left = annotation === undefined ? target : `${target}: ${annotation}`;
  if (value === undefined) {
    return annotation === undefined
      ? [`${pad}${target}`]
      : fit(indent, `${target}: `, annotation);
  }
  const flat = `${pad}${left} = ${value}`;
  if (flat.length <= WIDTH) return [flat];
  // The value is broken first; the annotation when that is not enough.
  const broken = fit(indent, `${left} = `, value);
  if (annotation === undefined || broken[0].length <= WIDTH) return broken;
  return fit(indent, `${target}: `, annotation, ` = ${value}`);
}

/**
 * The first line or lines of a function: `head(parameters) -> returns:`.
 *
 * @param head Everything before the parameters: `async def name`.
 */
export function signature(
  indent: number,
  head: string,
  parameters: readonly string[],
  returns?: string,
): string[] {
  const pad = " ".repeat(indent);
  const end = `)${returns === undefined ? "" : ` -> ${returns}`}:`;
  const flat = `${pad}${head}(${parameters.join(", ")}${end}`;
  if (flat.length <= WIDTH || parameters.length === 0) return [flat];
  const inner = `${pad}    ${parameters.join(", ")}`;
  // One parameter gets a comma, and with it a line of its own.
  if (parameters.length > 1 && inner.length <= WIDTH) {
    return [`${pad}${head}(`, inner, `${pad}${end}`];
  }
  return [
    `${pad}${head}(`,
    ...parameters.flatMap((parameter) => {
      const [name, ...rest] = splitTop(parameter, ": ");
      return rest.length === 0
        ? [`${pad}    ${parameter},`]
        : fit(indent + 4, `${name}: `, rest.join(": "), ",", true);
    }),
    `${pad}${end}`,
  ];
}

/** A line of text as lines no wider than `width`, broken between words. */
export function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  // A code span is not broken.
  const words = text.match(/(?:`[^`]*`|\S)+/g) ?? [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current !== "" && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Text that ends as a sentence does. */
function ended(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A docstring. One line if the text is one line that fits; otherwise a
 * summary line, an empty line and the rest, with the closing quotes on a
 * line of their own.
 *
 * @param options.summary What the first line says when the text does not
 * start with a line that can be one.
 * @param options.verbatim Whether the text is kept as it is: no full
 * stop is added, and a long first line is broken, not replaced.
 */
export function docstring(
  indent: number,
  text: string,
  options: { summary?: string; verbatim?: boolean } = {},
): string[] {
  const pad = " ".repeat(indent);
  const width = WIDTH - indent;
  const lines = text.trim().replaceAll("\\", "\\\\").replaceAll(
    '"""',
    '\\"\\"\\"',
  ).split("\n").map((line) => line.trim());
  const end = (line: string) => options.verbatim ? line : ended(line);

  // A quote at the end would be read with the closing quotes.
  const one = end(lines[0]);
  if (lines.length === 1 && one.length + 6 <= width && !one.endsWith('"')) {
    return [`${pad}"""${one}"""`];
  }

  let head = one;
  let rest = lines.slice(1);
  if (options.verbatim) {
    // The text, broken where it has to be.
    [head, ...rest] = lines.flatMap((line) =>
      line === "" ? [""] : wrap(line, width - 3)
    );
  } else if (one.length + 3 > width || (rest.length > 0 && rest[0] !== "")) {
    // No line of the text can be the summary: it gets one.
    head = ended(options.summary ?? "See below");
    rest = ["", ...lines];
  }
  const body = rest.flatMap((line) => line === "" ? [""] : wrap(line, width));
  while (body.at(-1) === "") body.pop();
  return [
    `${pad}"""${head}`,
    ...body.map((line) => `${pad}${line}`),
    `${pad}"""`,
  ].map((line) => line.trimEnd());
}

/** A comment, broken between words. */
export function comment(indent: number, text: string): string[] {
  const pad = " ".repeat(indent);
  return wrap(text, WIDTH - indent - 2).map((line) => `${pad}# ${line}`);
}

/** Whether a character is one a raw string cannot show. */
function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** A string as a Python literal: raw when that reads better. */
export function stringLiteral(value: string): string {
  const raw = value.includes("\\") && !value.includes('"') &&
    !value.endsWith("\\") && ![...value].some(isControl);
  return raw ? `r"${value}"` : JSON.stringify(value);
}

/**
 * `target = "text"`, with a text that is too long written as literals
 * that Python joins, in parentheses.
 *
 * @param call A function the text is the argument of: `target = call("text")`.
 */
export function stringConstant(
  indent: number,
  target: string,
  value: string,
  call = "",
): string[] {
  const pad = " ".repeat(indent);
  const flat = call === ""
    ? `${pad}${target} = ${stringLiteral(value)}`
    : `${pad}${target} = ${call}(${stringLiteral(value)})`;
  if (flat.length <= WIDTH) return [flat];
  const room = WIDTH - indent - 4;
  // Every piece is written the way the whole text is: raw, or not.
  const raw = stringLiteral(value).startsWith("r");
  const literal = (piece: string) =>
    raw ? `r"${piece}"` : JSON.stringify(piece);
  const pieces: string[] = [];
  let rest = value;
  while (rest !== "") {
    // The longest piece whose literal fits and that can be a raw one.
    let size = Math.min(rest.length, room);
    while (
      size > 1 &&
      (literal(rest.slice(0, size)).length > room ||
        rest[size - 1] === "\\")
    ) size--;
    // Rather after an alternative or a group than in the middle of one.
    if (size < rest.length) {
      const cut = Math.max(
        rest.lastIndexOf("|", size - 1),
        rest.lastIndexOf(")", size - 1),
      );
      if (cut >= size - 24 && cut > 0) size = cut + 1;
    }
    pieces.push(literal(rest.slice(0, size)));
    rest = rest.slice(size);
  }
  return [
    `${pad}${target} = ${call}(`,
    ...pieces.map((piece) => `${pad}    ${piece}`),
    `${pad})`,
  ];
}

/** The order the formatter's import sorting gives names: by kind, then name. */
function importOrder(a: string, b: string): number {
  const kind = (name: string) =>
    /^[A-Z0-9_]+$/.test(name) ? 0 : /^[A-Z]/.test(name) ? 1 : 2;
  return kind(a) - kind(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** `from module import a, b`, broken when it is too long. */
export function fromImport(module: string, names: readonly string[]): string[] {
  const sorted = [...names].sort(importOrder);
  const flat = `from ${module} import ${sorted.join(", ")}`;
  if (flat.length <= WIDTH) return [flat];
  return [
    `from ${module} import (`,
    ...sorted.map((name) => `    ${name},`),
    ")",
  ];
}

/** The names a module may import, by where they come from. */
export type ImportTable = readonly (readonly [
  module: string,
  names: readonly string[],
])[];

/**
 * The import lines for what a module's source names: of each table entry,
 * the names that occur in the source. An entry with no name is
 * `import module`, written when the source names the module.
 *
 * @param sections The standard library first, then other packages.
 */
export function imports(
  source: string,
  sections: readonly ImportTable[],
): string[] {
  const used = (name: string) =>
    new RegExp(`(?<![\\w.])${name.replaceAll(".", "\\.")}\\b`).test(source);
  // A module is used through one of its members: its name alone is also a
  // word of a docstring, or a string.
  const usedModule = (name: string) =>
    new RegExp(`(?<![\\w.])${name.replaceAll(".", "\\.")}\\.\\w`).test(source);
  const lines: string[] = [];
  for (const section of sections) {
    const plain = section
      .filter(([module, names]) => names.length === 0 && usedModule(module))
      .map(([module]) => `import ${module}`);
    const from = section.flatMap(([module, names]) => {
      const needed = names.filter(used);
      return needed.length > 0 ? fromImport(module, needed) : [];
    });
    if (plain.length + from.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(...plain, ...from);
  }
  return lines;
}
