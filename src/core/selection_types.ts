/**
 * Selections written as one string.
 *
 * `GET /posts?select=id,author(name,posts(title))` names the properties
 * the response has, with nesting, in one query parameter. The type of the
 * response is a function of that string. This module parses the string at
 * the type level and applies it to the type of the complete object:
 *
 * - `ParseSelect<"id,author(name)">` is the syntax tree, as a tuple type
 * - `Selected<Post, Tree>` is `Post` cut down to the tree
 * - `SelectProblem<Post, "id,author(nope)">` is the reason a string does
 *   not fit `Post`, as a type that no string is assignable to
 *
 * The parser is a recursive descent over template literal types: each
 * production returns what it parsed and the rest of the string, the way
 * postgrest-js types its `select()` argument.
 *
 * Grammar: `select = item ("," item)*`, `item = name | name "(" select ")"`,
 * `*` for every property of the level. Spaces around items are ignored.
 *
 * No runtime code and no imports besides types: the type generator imports
 * it by URL into a subprocess.
 *
 * @module
 */

import type { Flatten, ResponseFamily } from "./dependent_types.ts";

// =============================================================================
// Syntax
// =============================================================================

/** A selected property and, for a nested object, what is selected in it. */
export interface SelectNode {
  /** Name of the property; `*` for every property. */
  readonly name: string;
  /** The selection inside the property, if one was written. */
  readonly children: readonly SelectNode[] | undefined;
}

/**
 * Why a select string is not valid. No string is assignable to it, so a
 * parameter of this type rejects the string and shows the message.
 */
export interface SelectError<TMessage extends string> {
  /** The message. */
  readonly "~selectError": TMessage;
}

/** `S` without leading and trailing spaces. */
export type TrimSpaces<S extends string> = S extends ` ${infer R}`
  ? TrimSpaces<R>
  : S extends `${infer R} ` ? TrimSpaces<R>
  : S;

/** The characters that end a name. */
export type SelectDelimiter = "," | "(" | ")" | " ";

/** The name at the start of `S` and the rest of `S`. */
export type TakeName<S extends string, TName extends string = ""> = S extends
  `${infer C}${infer R}`
  ? C extends SelectDelimiter ? [TName, S] : TakeName<R, `${TName}${C}`>
  : [TName, ""];

/** One item at the start of `S`: `[node, rest]`, or a `SelectError`. */
export type ParseItem<S extends string> = TrimSpaces<S> extends
  infer T extends string
  ? TakeName<T> extends [infer TName extends string, infer TRest extends string]
    ? TName extends "" ? SelectError<`expected a field name at "${T}"`>
    : TrimSpaces<TRest> extends `(${infer TInner}`
      ? ParseItems<TInner> extends infer TParsed ? TParsed extends [
          infer TChildren extends readonly SelectNode[],
          infer TAfter extends string,
        ]
          ? TAfter extends `)${infer TAfterParen}`
            ? [{ name: TName; children: TChildren }, TAfterParen]
          : SelectError<`missing ")" after "${TName}("`>
        : TParsed
      : never
    : [{ name: TName; children: undefined }, TRest]
  : never
  : never;

/** The items at the start of `S`: `[nodes, rest]`, or a `SelectError`. */
export type ParseItems<
  S extends string,
  TNodes extends readonly SelectNode[] = [],
> = ParseItem<S> extends infer TItem
  ? TItem extends [infer TNode extends SelectNode, infer TRest extends string]
    ? TrimSpaces<TRest> extends `,${infer TMore}`
      ? ParseItems<TMore, [...TNodes, TNode]>
    : [[...TNodes, TNode], TrimSpaces<TRest>]
  : TItem
  : never;

/** The syntax tree of a select string, or a `SelectError`. */
export type ParseSelect<S extends string> = ParseItems<S> extends infer TParsed
  ? TParsed extends
    [infer TNodes extends readonly SelectNode[], infer TRest extends string]
    ? TRest extends "" ? TNodes : SelectError<`unexpected "${TRest}"`>
  : TParsed
  : never;

// =============================================================================
// Application
// =============================================================================

/** The selection written inside property `K`, if `K` is listed. */
export type ChildrenOf<TNodes extends readonly SelectNode[], K> = Extract<
  TNodes[number],
  { readonly name: K }
>["children"];

/**
 * `T` cut down to a selection: the listed properties, and inside those
 * with a selection of their own, the same again. Arrays are cut down
 * element by element; `null` and `undefined` stay.
 */
export type Selected<T, TNodes extends readonly SelectNode[]> = T extends
  readonly (infer E)[] ? Selected<E, TNodes>[]
  : T extends object ? Flatten<
      {
        [
          K in keyof T as "*" extends TNodes[number]["name"] ? K
            : K extends TNodes[number]["name"] ? K
            : never
        ]: ChildrenOf<TNodes, K> extends infer C ? [C] extends [never] ? T[K]
          : [C] extends [readonly SelectNode[]] ? Selected<T[K], C>
          : T[K]
          : never;
      }
    >
  : T;

/** The object type a selection inside `T` applies to; `never` if none. */
export type SelectableIn<T> = T extends readonly (infer E)[] ? SelectableIn<E>
  : T extends object ? T
  : never;

/**
 * What is wrong with a selection of `T`: a union of messages, `never` if
 * nothing is. `TPath` is the path to `T`, for the messages.
 */
export type SelectIssues<
  T,
  TNodes extends readonly SelectNode[],
  TPath extends string = "",
> = [SelectableIn<T>] extends [never] ? never : {
  [I in keyof TNodes]: TNodes[I] extends {
    readonly name: infer TName extends string;
    readonly children: infer TChildren;
  } ? TName extends "*" ? never
    : TName extends keyof SelectableIn<T>
      ? TChildren extends readonly SelectNode[]
        ? [SelectableIn<SelectableIn<T>[TName]>] extends [never]
          ? `"${TPath}${TName}" has no fields to select`
        : SelectIssues<SelectableIn<T>[TName], TChildren, `${TPath}${TName}.`>
      : never
    : `"${TPath}${TName}" is not a field`
    : never;
}[number];

/**
 * Why select string `S` does not fit `T`, as a `SelectError`; `never` when
 * it fits, or when `S` is not a literal and nothing can be said.
 */
export type SelectProblem<T, S extends string> = [S] extends [never] ? never
  : string extends S ? never
  : ParseSelect<S> extends infer TParsed
    ? TParsed extends readonly SelectNode[]
      ? [SelectIssues<T, TParsed>] extends [never] ? never
      : SelectError<SelectIssues<T, TParsed> & string>
    : TParsed
  : never;

/** `T` with every property optional, at every depth. */
export type PartialDeep<T> = T extends readonly (infer E)[] ? PartialDeep<E>[]
  : T extends object ? { [K in keyof T]?: PartialDeep<T[K]> }
  : T;

/** `T` cut down to select string `S`. */
export type SelectedBy<T, S extends string> = S extends string
  // A string the types do not pin down may select anything.
  ? string extends S ? PartialDeep<T>
  : ParseSelect<S> extends infer TParsed
    ? TParsed extends readonly SelectNode[] ? Selected<T, TParsed>
      // An invalid string is rejected where it is written (`requires`);
      // the response type is then of no interest.
    : PartialDeep<T>
  : never
  : never;

/** The text a query parameter named `TParam` carries in request `R`. */
export type QueryText<R, TParam extends string> = R extends
  { readonly query: infer Q }
  ? Q extends { readonly [K in TParam]: infer S extends string } ? S : never
  : never;

/**
 * Selection: the response has the properties of `TBase` that the query
 * parameter `TParam` names in a select string, nested selections included;
 * all of them when the parameter is absent.
 *
 * - `{ query: { select: "id,author(name)" } }`:
 *   `{ id: string; author: { name: string } }`
 * - a string the types do not pin down: every property optional, at every
 *   depth
 * - a literal that names an unknown property is rejected where it is
 *   written, with the reason in the error
 */
export interface Selection<TBase, TParam extends string>
  extends ResponseFamily {
  /** The selected properties. */
  readonly response: [QueryText<this["request"], TParam>] extends [never]
    ? TBase
    : SelectedBy<TBase, QueryText<this["request"], TParam>>;
  /** A valid select string. */
  readonly requires: SelectRequirement<
    TBase,
    TParam,
    QueryText<this["request"], TParam>
  >;
}

/**
 * What `Selection` requires of a request whose parameter `TParam` is `S`:
 * nothing when `S` fits `TBase`; otherwise a parameter type that rejects
 * `S` and carries the reason.
 */
export type SelectRequirement<TBase, TParam extends string, S extends string> =
  [SelectProblem<TBase, S>] extends [never] ? unknown
    : {
      readonly query: { readonly [K in TParam]: SelectProblem<TBase, S> };
    };
