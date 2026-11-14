/**
 * Builders for responses whose type depends on the request.
 *
 * Each builder returns an ordinary Zod schema: the one that holds for every
 * request. Validation, OpenAPI generation and the flat type output use it
 * as is. It also carries the rule, as a type (`Dependent`) and as data
 * (`DependentDescriptor`); the client type generator turns that into a
 * response type computed from each call's arguments.
 *
 * @example
 * ```ts
 * const User = z.object({ id: z.string(), name: z.string(), email: z.string() });
 *
 * GET: endpoint({
 *   query: z.object({ fields: fieldsOf(User) }),
 *   response: z.object({ data: z.array(projection(User, "fields")) }),
 *   handler: (_ctx, { query }) =>
 *     Response.json({ data: users.map((u) => select(u, query.fields)) }),
 * })
 *
 * // Generated client:
 * const page = await client.users.list({ query: { fields: ["id", "name"] } });
 * page.data[0].name;  // string
 * page.data[0].email; // compile error: not requested
 * ```
 *
 * @module
 */

import { z } from "zod";
import {
  DEPENDENT,
  type Dependent,
  type DependentDescriptor,
  type Expansion,
  type Projection,
} from "./dependent_types.ts";

function carry<T extends z.ZodType>(
  schema: T,
  descriptor: DependentDescriptor,
): T {
  Object.defineProperty(schema, DEPENDENT, { value: descriptor });
  return schema;
}

/** The output types of a record of schemas. */
export type OutputOf<T extends Readonly<Record<string, z.ZodType>>> = {
  [K in keyof T]: z.output<T[K]>;
};

/** Schema returned by `projection()`. */
export type ProjectionSchema<
  TSchema extends z.ZodObject,
  TParam extends string,
> = z.ZodType<
  Dependent<Projection<z.output<TSchema>, TParam>, Partial<z.output<TSchema>>>,
  Partial<z.input<TSchema>>
>;

/**
 * A response object that has the properties the request asked for.
 *
 * The schema is `schema.partial()`: any subset of the properties is valid.
 * The generated client types a call by its arguments: with
 * `{ query: { [param]: ["id", "name"] } }` the type is
 * `Pick<T, "id" | "name">`, without the parameter it is `T`.
 *
 * Schema methods that copy the schema (`.optional()`, `.describe()`) drop
 * the rule; wrap the result of `projection()` instead of calling them on it.
 *
 * @param schema Schema of the complete object.
 * @param param Name of the query parameter that lists the properties.
 */
export function projection<
  TSchema extends z.ZodObject,
  const TParam extends string,
>(schema: TSchema, param: TParam): ProjectionSchema<TSchema, TParam> {
  return carry(
    schema.partial() as unknown as ProjectionSchema<TSchema, TParam>,
    { kind: "projection", param, base: schema },
  );
}

/** Schema returned by `expansion()`. */
export type ExpansionSchema<
  TSchema extends z.ZodObject,
  TParam extends string,
  TRelations extends Readonly<Record<string, z.ZodType>>,
> = z.ZodType<
  Dependent<
    Expansion<z.output<TSchema>, TParam, OutputOf<TRelations>>,
    z.output<TSchema> & Partial<OutputOf<TRelations>>
  >,
  & z.input<TSchema>
  & Partial<{ [K in keyof TRelations]: z.input<TRelations[K]> }>
>;

/**
 * A response object with related objects the request asked to include.
 *
 * The schema is the base with every relation optional. The generated
 * client types a call by its arguments: with
 * `{ query: { [param]: ["team"] } }` the type is `T & { team: Team }`,
 * without the parameter it is `T`.
 *
 * @param schema Schema of the object without relations.
 * @param param Name of the query parameter that lists the relations.
 * @param relations Schema of each relation, by property name.
 */
export function expansion<
  TSchema extends z.ZodObject,
  const TParam extends string,
  const TRelations extends Readonly<Record<string, z.ZodType>>,
>(
  schema: TSchema,
  param: TParam,
  relations: TRelations,
): ExpansionSchema<TSchema, TParam, TRelations> {
  const optional = Object.fromEntries(
    Object.entries(relations).map(([name, s]) => [name, s.optional()]),
  );
  return carry(
    schema.extend(optional) as unknown as ExpansionSchema<
      TSchema,
      TParam,
      TRelations
    >,
    { kind: "expansion", param, base: schema, relations },
  );
}

/** Schema of a query parameter that lists names: an optional array. */
export type NamesSchema<TName extends string> = z.ZodOptional<
  z.ZodArray<z.ZodEnum<{ [K in TName]: K }>>
>;

function names<TName extends string>(keys: string[]): NamesSchema<TName> {
  if (keys.length === 0) {
    throw new Error("A list of names needs at least one name to choose from");
  }
  return z.array(z.enum(keys as [string, ...string[]]))
    .optional() as unknown as NamesSchema<TName>;
}

/**
 * Schema of the query parameter for `projection()`: an optional list of
 * property names of `schema`.
 */
export function fieldsOf<TSchema extends z.ZodObject>(
  schema: TSchema,
): NamesSchema<keyof z.output<TSchema> & string> {
  return names(Object.keys(schema.shape));
}

/**
 * Schema of the query parameter for `expansion()`: an optional list of
 * relation names.
 */
export function relationsOf<
  const TRelations extends Readonly<Record<string, z.ZodType>>,
>(relations: TRelations): NamesSchema<keyof TRelations & string> {
  return names(Object.keys(relations));
}

/**
 * The properties of `value` that `fields` lists; all of them when `fields`
 * is absent or empty. What a handler returns for a `projection()` response.
 */
export function select<T extends object, K extends keyof T = keyof T>(
  value: T,
  fields: readonly K[] | undefined,
): Pick<T, K> {
  if (fields === undefined || fields.length === 0) return value;
  const picked = {} as Pick<T, K>;
  for (const field of fields) {
    if (field in value) picked[field] = value[field];
  }
  return picked;
}
