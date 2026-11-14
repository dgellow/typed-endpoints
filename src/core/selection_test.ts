import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import { arbitrary, seededRandom } from "./arbitrary.ts";
import { applyDependentResponse } from "./dependent.ts";
import {
  applySelection,
  parseSelect,
  selection,
  selectionIssues,
  selectOf,
  SelectSyntaxError,
} from "./selection.ts";
import type {
  ParseSelect,
  Selected,
  SelectError,
  SelectNode,
  SelectProblem,
} from "./selection_types.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

const Author = z.object({ id: z.string(), name: z.string() });
const Post = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  author: Author,
  reviewer: Author.nullable(),
  tags: z.array(z.string()),
  comments: z.array(z.object({ text: z.string(), by: Author })),
});
type Post = z.output<typeof Post>;

// -----------------------------------------------------------------------------
// The two parsers agree
// -----------------------------------------------------------------------------

/**
 * `expected` has to be a value of the type the type-level parser gives
 * for `text`, and the runtime parser has to return it: one literal checked
 * against both.
 */
function sameTree<const S extends string>(
  text: S,
  expected: ParseSelect<S>,
): void {
  assertEquals(parseSelect(text), expected as unknown as SelectNode[]);
}

const leaf = <const N extends string>(name: N) =>
  ({ name, children: undefined }) as const;

Deno.test("select: the type-level parser and the runtime parser give the same tree", () => {
  sameTree("id", [leaf("id")]);
  sameTree("id,title", [leaf("id"), leaf("title")]);
  sameTree(" id , title ", [leaf("id"), leaf("title")]);
  sameTree("*", [leaf("*")]);
  sameTree("author(name)", [{ name: "author", children: [leaf("name")] }]);
  sameTree("author ( id , name ) , id", [
    { name: "author", children: [leaf("id"), leaf("name")] },
    leaf("id"),
  ]);
  sameTree("a(b(c(d)))", [{
    name: "a",
    children: [{
      name: "b",
      children: [{ name: "c", children: [leaf("d")] }],
    }],
  }]);
  sameTree("id,author(name,posts(title)),comments(text,by(name))", [
    leaf("id"),
    {
      name: "author",
      children: [leaf("name"), {
        name: "posts",
        children: [leaf("title")],
      }],
    },
    {
      name: "comments",
      children: [leaf("text"), { name: "by", children: [leaf("name")] }],
    },
  ]);
  sameTree("snake_case,kebab-case,with.dot,UPPER,x1", [
    leaf("snake_case"),
    leaf("kebab-case"),
    leaf("with.dot"),
    leaf("UPPER"),
    leaf("x1"),
  ]);
});

/** The message of a type-level `SelectError`. */
type MessageOf<T> = T extends SelectError<infer M> ? M : never;

/**
 * `message` has to be the message the type-level parser gives for `text`,
 * and the runtime parser has to throw it.
 */
function sameError<const S extends string>(
  text: S,
  message: MessageOf<ParseSelect<S>>,
): void {
  const error = assertThrows(() => parseSelect(text), SelectSyntaxError);
  assertEquals(error.message.startsWith(message), true, error.message);
}

Deno.test("select: the two parsers reject the same strings for the same reason", () => {
  sameError("id,author(name", 'missing ")" after "author("');
  sameError("a(b(c)", 'missing ")" after "a("');
  sameError("id)", 'unexpected ")"');
  sameError("id name", 'unexpected "name"');
  sameError("author(name))", 'unexpected ")"');

  // Where a name is missing, the type says what follows; the runtime says
  // where. Both say a name was expected.
  for (const text of ["", " ", "id,", ",id", "id,,title", "author()", "(id)"]) {
    const error = assertThrows(() => parseSelect(text), SelectSyntaxError);
    assertEquals(error.message.startsWith("expected a field name"), true, text);
  }
  assertType<
    Equal<
      ParseSelect<"id,,title">,
      SelectError<'expected a field name at ",title"'>
    >
  >();
  assertType<
    Equal<ParseSelect<"">, SelectError<'expected a field name at ""'>>
  >();
  assertType<
    Equal<ParseSelect<"author()">, SelectError<'expected a field name at ")"'>>
  >();
});

Deno.test("select: a syntax error says where", () => {
  const error = assertThrows(
    () => parseSelect("id,author(name"),
    SelectSyntaxError,
  );
  assertEquals(error.position, 14);
  assertEquals(error.message, 'missing ")" after "author(" (at position 14)');
});

// -----------------------------------------------------------------------------
// Against a schema
// -----------------------------------------------------------------------------

/**
 * `expected` has to be the messages the types give for `text` against
 * `Post`, and the runtime check has to return them.
 */
function sameIssues<const S extends string>(
  text: S,
  ...expected: MessageOf<SelectProblem<Post, S>>[]
): void {
  assertEquals(
    selectionIssues(Post, parseSelect(text)).sort(),
    [...expected].sort(),
  );
}

Deno.test("select: types and runtime find the same problems in a selection", () => {
  sameIssues("id,nope", '"nope" is not a field');
  sameIssues("author(age)", '"author.age" is not a field');
  sameIssues("comments(by(phone))", '"comments.by.phone" is not a field');
  sameIssues("title(length)", '"title" has no fields to select');
  sameIssues("tags(x)", '"tags" has no fields to select');
  sameIssues(
    "nope,author(age),tags(x)",
    '"nope" is not a field',
    '"author.age" is not a field',
    '"tags" has no fields to select',
  );

  // Nothing wrong: no problem type, no issue.
  assertType<
    Equal<SelectProblem<Post, "id,author(name),reviewer(id)">, never>
  >();
  assertEquals(
    selectionIssues(Post, parseSelect("id,author(name),reviewer(id)")),
    [],
  );
  assertType<Equal<SelectProblem<Post, "*,comments(*)">, never>>();
  assertEquals(selectionIssues(Post, parseSelect("*,comments(*)")), []);
  // A string that is not a literal: nothing can be said at compile time.
  assertType<Equal<SelectProblem<Post, string>, never>>();
});

Deno.test("select: the selected type is what the selected value has", () => {
  const post: Post = {
    id: "p1",
    title: "T",
    body: "B",
    author: { id: "u1", name: "Ada" },
    reviewer: null,
    tags: ["a"],
    comments: [{ text: "hi", by: { id: "u2", name: "Grace" } }],
  };

  /** Apply a selection, typed by the type-level result. */
  const pick = <const S extends string>(
    text: S,
  ): Selected<Post, Extract<ParseSelect<S>, readonly SelectNode[]>> =>
    applySelection(post, parseSelect(text)) as never;

  const a = pick("id,author(name),comments(by(name))");
  assertType<
    Equal<
      typeof a,
      {
        id: string;
        author: { name: string };
        comments: { by: { name: string } }[];
      }
    >
  >();
  assertEquals(a, {
    id: "p1",
    author: { name: "Ada" },
    comments: [{ by: { name: "Grace" } }],
  });

  const b = pick("body,reviewer(name)");
  assertType<
    Equal<typeof b, { body?: string; reviewer: { name: string } | null }>
  >();
  assertEquals(b, { body: "B", reviewer: null });

  const c = pick("*,author(id)");
  assertEquals(c.author, { id: "u1" });
  assertEquals(c.title, "T");
  assertEquals(Object.keys(c).sort(), Object.keys(post).sort());

  // The order of the string does not matter; a name listed twice counts
  // once, the last selection winning.
  assertEquals(pick("title,id"), { id: "p1", title: "T" });
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

Deno.test("selectOf: the query schema refuses a string that does not fit", () => {
  const schema = z.object({ select: selectOf(Post) });

  assertEquals(schema.safeParse({}).success, true);
  assertEquals(schema.safeParse({ select: "id,author(name)" }).success, true);

  const messages = (select: string) => {
    const result = schema.safeParse({ select });
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };
  assertEquals(messages("id,nope"), ['"nope" is not a field']);
  assertEquals(messages("author(age),tags(x)"), [
    '"author.age" is not a field',
    '"tags" has no fields to select',
  ]);
  assertEquals(messages("id,author(name"), [
    'missing ")" after "author(" (at position 14)',
  ]);
});

Deno.test("selection: the schema accepts every selection of the object", () => {
  const schema = selection(Post, "select");
  const random = seededRandom(11);

  /** A random selection of what a schema describes. */
  const pickSome = (shape: Record<string, z.ZodType>): SelectNode[] => {
    const nodes: SelectNode[] = [];
    for (const [name, field] of Object.entries(shape)) {
      if (random() < 0.4) continue;
      let inner: z.ZodType = field;
      while (!(inner instanceof z.ZodObject)) {
        if (inner instanceof z.ZodArray) inner = inner.element as z.ZodType;
        else if (inner instanceof z.ZodNullable) {
          inner = inner.unwrap() as z.ZodType;
        } else break;
      }
      const children = inner instanceof z.ZodObject && random() < 0.7
        ? pickSome(inner.shape)
        : undefined;
      // An empty selection cannot be written.
      nodes.push({
        name,
        children: children && children.length > 0 ? children : undefined,
      });
    }
    return nodes;
  };
  const write = (nodes: readonly SelectNode[]): string =>
    nodes.map((node) =>
      node.children ? `${node.name}(${write(node.children)})` : node.name
    ).join(",");

  for (let i = 0; i < 200; i++) {
    const nodes = pickSome(Post.shape);
    if (nodes.length === 0) continue;
    const text = write(nodes);

    // Written and read back, a selection is itself.
    assertEquals(parseSelect(text), nodes, text);
    assertEquals(selectionIssues(Post, nodes), [], text);

    // Any post, cut down to it, is a valid response.
    const post = Post.parse(arbitrary(Post, { random }));
    const cut = applySelection(post, nodes);
    assertEquals(schema.safeParse(cut).success, true, text);

    // What the handler path does with a complete object is the same.
    assertEquals(
      applyDependentResponse(schema, post, { select: text }),
      cut,
      text,
    );
  }
});

Deno.test("selection: without a select string the response is left as it is", () => {
  const schema = z.object({ data: z.array(selection(Post, "select")) });
  const post = Post.parse(arbitrary(Post, { seed: 3 }));
  assertEquals(applyDependentResponse(schema, { data: [post] }, {}), {
    data: [post],
  });
  assertEquals(
    applyDependentResponse(schema, { data: [post] }, { select: "id" }),
    { data: [{ id: post.id }] },
  );
});
