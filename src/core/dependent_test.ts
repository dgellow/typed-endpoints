import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  expansion,
  fieldsOf,
  projection,
  relationsOf,
  select,
} from "./dependent.ts";
import {
  type Apply,
  type CertainNames,
  type Dependent,
  dependentDescriptor,
  type Expansion,
  type IsUnion,
  type Projection,
  type Requires,
  type Resolve,
  type ResponseFamily,
} from "./dependent_types.ts";
import type { SelectError, Selection } from "./selection_types.ts";
import { zodToTypeString } from "../tsgen/zod.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  age: z.number().optional(),
});
const Team = z.object({ id: z.string(), title: z.string() });
type User = z.output<typeof User>;
type Team = z.output<typeof Team>;

// =============================================================================
// Type-level functions
// =============================================================================

Deno.test("Apply supplies the request to a family", () => {
  interface ListOf extends ResponseFamily {
    readonly response: this["request"][];
  }

  assertType<Equal<Apply<ListOf, "hello">, "hello"[]>>();
  assertType<Equal<Apply<ListOf, 42>[number], 42>>();
});

Deno.test("CertainNames: only a tuple of single names is certain", () => {
  assertType<Equal<CertainNames<readonly ["id", "name"]>, "id" | "name">>();
  assertType<Equal<CertainNames<["id"]>, "id">>();
  // An array may hold any subset.
  assertType<Equal<CertainNames<("id" | "name")[]>, never>>();
  // A union element holds one of several names.
  assertType<Equal<CertainNames<readonly ["id", "name" | "email"]>, "id">>();
  assertType<Equal<CertainNames<readonly []>, never>>();

  assertType<Equal<IsUnion<"a" | "b">, true>>();
  assertType<Equal<IsUnion<"a">, false>>();
  assertType<Equal<IsUnion<never>, false>>();
});

Deno.test("Projection picks the listed properties", () => {
  type P = Projection<User, "fields">;

  assertType<
    Equal<
      Apply<P, { query: { fields: readonly ["id", "name"] } }>,
      { id: string; name: string }
    >
  >();
  // Absent or empty: everything.
  assertType<Equal<Apply<P, { query: { limit: 3 } }>, User>>();
  assertType<Equal<Apply<P, Record<never, never>>, User>>();
  assertType<Equal<Apply<P, { query: { fields: readonly [] } }>, User>>();
  // Content not pinned down: optional.
  assertType<
    Equal<
      Apply<P, { query: { fields: ("id" | "email")[] } }>,
      { id?: string; email?: string }
    >
  >();
  // Another parameter name is another parameter.
  assertType<
    Equal<Apply<P, { query: { select: readonly ["id"] } }>, User>
  >();
});

Deno.test("Expansion adds the listed relations", () => {
  type E = Expansion<User, "expand", { team: Team; manager: User }>;

  assertType<
    Equal<
      Apply<E, { query: { expand: readonly ["team"] } }>,
      User & { team: Team }
    >
  >();
  assertType<Equal<Apply<E, { query: Record<never, never> }>, User>>();
  assertType<
    Equal<
      Apply<E, { query: { expand: ("team" | "manager")[] } }>,
      User & { team?: Team; manager?: User }
    >
  >();
});

Deno.test("Resolve applies families inside arrays and objects, and leaves the rest", () => {
  type Hole = Dependent<Projection<User, "fields">, Partial<User>>;
  type Page = { data: Hole[]; total: number; meta: { first?: Hole } };
  type R = { query: { fields: readonly ["id"] } };

  assertType<
    Equal<
      Resolve<Page, R>,
      {
        data: { id: string }[];
        total: number;
        meta: { first?: { id: string } };
      }
    >
  >();
  // A type without dependent places is unchanged.
  assertType<
    Equal<Resolve<{ a: string; b: number[] }, R>, { a: string; b: number[] }>
  >();
  assertType<Equal<Resolve<string, R>, string>>();
});

// =============================================================================
// Builders
// =============================================================================

Deno.test("Requires: what the families of a response ask of the request", () => {
  /** Exactly `unknown`: nothing is asked. */
  type AsksNothing<T> = unknown extends T ? true : false;
  type Fields = { query: { fields: ["id"] } };
  type Picked = Dependent<Projection<User, "fields">, Partial<User>>;
  type Chosen = Dependent<Selection<User, "select">, Partial<User>>;

  // A projection asks for nothing, wherever it stands.
  assertType<AsksNothing<Requires<Picked, Fields>>>();
  assertType<
    AsksNothing<Requires<{ data: Picked[]; total: number }, Fields>>
  >();
  assertType<AsksNothing<Requires<{ id: string }, Fields>>>();

  // An optional property next to a family does not turn the requirement
  // into `never`, which would reject every call.
  assertType<
    AsksNothing<Requires<{ data: Picked[]; nextCursor?: string }, Fields>>
  >();
  assertType<
    AsksNothing<
      Requires<{ data?: Picked[]; meta?: { note?: string } }, Fields>
    >
  >();

  // A selection asks for a valid select string, also next to optional
  // properties.
  assertType<
    Equal<
      Requires<
        { data: Chosen[]; nextCursor?: string },
        { query: { select: "id,nope" } }
      >,
      {
        readonly query: {
          readonly select: SelectError<'"nope" is not a field'>;
        };
      }
    >
  >();
  assertType<
    AsksNothing<
      Requires<
        { data: Chosen[]; nextCursor?: string },
        { query: { select: "id" } }
      >
    >
  >();
});

Deno.test("projection: the schema accepts any subset and carries the rule", () => {
  const schema = projection(User, "fields");

  assertEquals(schema.parse({ id: "1" }), { id: "1" });
  assertEquals(schema.parse({}), {});
  assertEquals(schema.safeParse({ id: 1 }).success, false);

  assertEquals(dependentDescriptor(schema)?.kind, "projection");
  assertEquals(dependentDescriptor(schema)?.param, "fields");
  assertEquals(dependentDescriptor(schema)?.base, User);
  // The rule is not enumerable: it does not leak into spreads or JSON.
  assertEquals(Object.getOwnPropertySymbols(schema).length > 0, true);
  assertEquals(dependentDescriptor(User), undefined);
  assertEquals(dependentDescriptor("fields"), undefined);

  // The static type is the fallback: every property optional.
  assertType<Equal<z.output<typeof schema>["id"], string | undefined>>();
});

Deno.test("expansion: the schema is the base with optional relations", () => {
  const schema = expansion(User, "expand", { team: Team, manager: User });
  const user = { id: "1", name: "Ada", email: "a@example.test" };

  assertEquals(schema.parse(user), user);
  assertEquals(
    schema.parse({ ...user, team: { id: "t", title: "T" } }).team,
    { id: "t", title: "T" },
  );
  assertEquals(schema.safeParse({ ...user, team: { id: "t" } }).success, false);
  assertEquals(schema.safeParse({ id: "1" }).success, false);

  const descriptor = dependentDescriptor(schema);
  assertEquals(descriptor?.kind, "expansion");
  assertEquals(Object.keys(descriptor?.relations ?? {}), ["team", "manager"]);
});

Deno.test("fieldsOf and relationsOf: an optional list of known names", () => {
  const fields = fieldsOf(User);
  assertEquals(fields.parse(undefined), undefined);
  assertEquals(fields.parse(["id", "age"]), ["id", "age"]);
  assertEquals(fields.safeParse(["password"]).success, false);
  assertType<
    Equal<
      z.output<typeof fields>,
      ("id" | "name" | "email" | "age")[] | undefined
    >
  >();

  const relations = relationsOf({ team: Team, manager: User });
  assertEquals(relations.parse(["team"]), ["team"]);
  assertEquals(relations.safeParse(["owner"]).success, false);
  assertType<
    Equal<z.output<typeof relations>, ("team" | "manager")[] | undefined>
  >();

  assertThrows(() => fieldsOf(z.object({})), Error, "at least one name");
});

Deno.test("select: the listed properties, or all of them", () => {
  const user = { id: "1", name: "Ada", email: "a@example.test" };

  const picked = select(user, ["id", "name"]);
  assertEquals(picked, { id: "1", name: "Ada" });
  assertType<Equal<typeof picked, { id: string; name: string }>>();

  assertEquals(select(user, undefined), user);
  assertEquals(select(user, []), user);
  // A property the value does not have is left out, not set to undefined.
  const sparse: { id: string; age?: number } = { id: "1" };
  assertEquals(Object.keys(select(sparse, ["id", "age"])), ["id"]);
});

// =============================================================================
// Type text
// =============================================================================

Deno.test("zodToTypeString: a dependent place is its fallback unless families are asked for", () => {
  const schema = z.object({ data: z.array(projection(User, "fields")) });

  assertEquals(
    zodToTypeString(schema),
    "{ data: { id?: string | undefined; name?: string | undefined; email?: string | undefined; age?: number | undefined; }[]; }",
  );
});

Deno.test("zodToTypeString: families name the rule, the parameter and the base", async () => {
  const { TypeDeclarations } = await import("../tsgen/zod.ts");
  const declarations = new TypeDeclarations();

  const text = zodToTypeString(
    expansion(z.object({ id: z.string() }), "include", {
      "team-lead": z.object({ name: z.string() }),
    }),
    { dependent: "families", declarations },
  );

  assertEquals(
    text,
    'Dependent<Expansion<{ id: string; }, "include", { "team-lead": { name: string; }; }>, { id: string; "team-lead"?: { name: string; } | undefined; }>',
  );
  assertEquals([...declarations.helpers].sort(), ["Dependent", "Expansion"]);
});
