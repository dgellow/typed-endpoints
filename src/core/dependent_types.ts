/**
 * Response types that depend on the request.
 *
 * `GET /users?fields=id,name` returns objects with two properties;
 * `GET /users/1?expand=team` returns a user with its team. The type of the
 * response is a function of the value of the request. This module holds
 * the type-level part of that: a way to write such a function as a type
 * (`ResponseFamily`), to embed it in a response type (`Dependent`) and to
 * apply it once the request is known (`Resolve`).
 *
 * It has no imports and no runtime dependencies besides one symbol: the
 * typed client and the type generator both use it, and the generator
 * imports it by URL into a subprocess.
 *
 * @module
 */

/**
 * A function from request types to response types, written as an interface.
 *
 * TypeScript has no type-level lambda. An interface can stand in for one:
 * `response` refers to `this["request"]`, and `Apply` supplies the argument
 * by intersecting the interface with `{ request: R }`.
 *
 * @example
 * ```ts
 * interface ListOf extends ResponseFamily {
 *   readonly response: this["request"][];
 * }
 * type T = Apply<ListOf, "hello">; // "hello"[]
 * ```
 */
export interface ResponseFamily {
  /** The argument: the type of the request, as the client passes it. */
  readonly request: unknown;
  /** The result: the type of the response to that request. */
  readonly response: unknown;
}

/** The response type family `F` gives for request type `R`. */
export type Apply<F extends ResponseFamily, R> =
  (F & { readonly request: R })["response"];

/**
 * A place in a response type whose type depends on the request.
 *
 * It is `TFallback` (what holds for every request) carrying the family in
 * a property that never exists at runtime. Code that does not know the
 * request sees `TFallback`; `Resolve` replaces the whole type by the
 * family's answer.
 */
export type Dependent<F extends ResponseFamily, TFallback> = TFallback & {
  readonly "~responseFamily"?: F;
};

/**
 * `T` with every `Dependent` place replaced by what its family gives for
 * request type `R`. Looks inside arrays and objects.
 */
export type Resolve<T, R> = T extends { readonly "~responseFamily"?: infer F }
  ? [F] extends [ResponseFamily] ? Apply<F, R>
  : ResolveIn<T, R>
  : ResolveIn<T, R>;

/** `Resolve` for the members of an array or object. */
export type ResolveIn<T, R> = T extends readonly (infer E)[] ? Resolve<E, R>[]
  : T extends object ? { [K in keyof T]: Resolve<T[K], R> }
  : T;

/** An object type written out, so hovers show properties, not helpers. */
export type Flatten<T> = { [K in keyof T]: T[K] } & unknown;

/** The list a query parameter named `TParam` carries in request `R`. */
export type QueryList<R, TParam extends string> = R extends
  { readonly query: infer Q }
  ? Q extends { readonly [K in TParam]: infer L extends readonly unknown[] } ? L
  : never
  : never;

/** Whether `T` is a union of more than one member. */
export type IsUnion<T, TAll = T> = [T] extends [never] ? false
  : T extends unknown ? [TAll] extends [T] ? false : true
  : never;

/**
 * The names in a list type that are certain to be in the list.
 *
 * Only a tuple says what a list contains: `["id", "name"]` contains both.
 * An array type `("id" | "name")[]` may hold any subset, and a tuple
 * element typed as a union (`["id", "name" | "email"]`) holds one of
 * several names; those are not certain.
 */
export type CertainNames<L extends readonly unknown[]> = number extends
  L["length"] ? never
  : {
    [I in keyof L]: IsUnion<L[I]> extends true ? never : L[I];
  }[number];

/** The names a list type may contain. */
export type PossibleNames<L extends readonly unknown[]> = L[number];

/**
 * Sparse fieldsets: the response has the properties of `TBase` that the
 * query parameter `TParam` lists, or all of them when it is absent or empty.
 *
 * - `{ query: { fields: ["id", "name"] } }`: `Pick<TBase, "id" | "name">`
 * - a list whose content the types do not pin down (`Field[]`): the
 *   properties it may name, each optional
 */
export interface Projection<TBase, TParam extends string>
  extends ResponseFamily {
  /** The listed properties. */
  readonly response: [QueryList<this["request"], TParam>] extends [never]
    ? TBase
    : QueryList<this["request"], TParam> extends readonly [] ? TBase
    : Flatten<
      & Pick<
        TBase,
        CertainNames<QueryList<this["request"], TParam>> & keyof TBase
      >
      & Partial<
        Pick<
          TBase,
          & Exclude<
            PossibleNames<QueryList<this["request"], TParam>>,
            CertainNames<QueryList<this["request"], TParam>>
          >
          & keyof TBase
        >
      >
    >;
}

/**
 * Expansions: the response is `TBase` plus the properties of `TRelations`
 * that the query parameter `TParam` lists.
 *
 * - `{ query: { expand: ["team"] } }`: `TBase & { team: Team }`
 * - a list whose content the types do not pin down: the relations it may
 *   name, each optional
 */
export interface Expansion<TBase, TParam extends string, TRelations>
  extends ResponseFamily {
  /** The base plus the listed relations. */
  readonly response: [QueryList<this["request"], TParam>] extends [never]
    ? TBase
    : Flatten<
      & TBase
      & {
        [
          K in
            & CertainNames<QueryList<this["request"], TParam>>
            & keyof TRelations
        ]: TRelations[K];
      }
      & {
        [
          K in
            & Exclude<
              PossibleNames<QueryList<this["request"], TParam>>,
              CertainNames<QueryList<this["request"], TParam>>
            >
            & keyof TRelations
        ]?: TRelations[K];
      }
    >;
}

/**
 * `T` with every array and object property readonly, at any depth.
 *
 * The constraint of a `const` type parameter: a literal argument is then
 * inferred as readonly tuples, which is what tells a list written in the
 * call apart from one computed elsewhere.
 */
export type ReadonlyDeep<T> = T extends readonly (infer E)[]
  ? readonly ReadonlyDeep<E>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
  : T;

// =============================================================================
// Runtime marker
// =============================================================================

/**
 * Property under which a schema carries its `DependentDescriptor`.
 *
 * A registered symbol, so that two copies of this module (the package as
 * the route files import it, and as the generator runs it) agree on it.
 */
export const DEPENDENT: unique symbol = Symbol.for(
  "typed-endpoints.dependent-response",
) as never;

/** How a schema's type depends on the request. Read by the generators. */
export interface DependentDescriptor {
  /** The rule. */
  readonly kind: "projection" | "expansion";
  /** Name of the query parameter the response depends on. */
  readonly param: string;
  /** Schema of the value before the rule is applied. */
  readonly base: unknown;
  /** Expansion: schema of each relation, by name. */
  readonly relations?: Readonly<Record<string, unknown>>;
}

/** The descriptor a schema carries, if it is a dependent place. */
export function dependentDescriptor(
  schema: unknown,
): DependentDescriptor | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  return (schema as { [DEPENDENT]?: DependentDescriptor })[DEPENDENT];
}
