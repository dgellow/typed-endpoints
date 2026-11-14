import type { z } from "zod";

/** Mutable shape type for config (z.ZodRawShape is readonly in Zod 4) */
export type MutableZodShape = { [k: string]: z.ZodType };

/**
 * Converts a dot-notation path string into a nested object type.
 * @example
 * PathToObject<"items", number[]> // { items: number[] }
 * PathToObject<"links.next", string> // { links: { next: string } }
 * PathToObject<"meta.pagination.cursor", string> // { meta: { pagination: { cursor: string } } }
 */
export type PathToObject<Path extends string, T> = Path extends
  `${infer K}.${infer R}` ? { [Key in K]: PathToObject<R, T> }
  : { [Key in Path]: T };

/**
 * Deeply merges multiple PathToObject types into a single nested object.
 * @example
 * MergeDeep<{ a: { b: string } }, { a: { c: number } }> // { a: { b: string; c: number } }
 */
export type MergeDeep<T, U> = T extends object ? U extends object ? {
      [K in keyof T | keyof U]: K extends keyof T
        ? K extends keyof U ? MergeDeep<T[K], U[K]>
        : T[K]
        : K extends keyof U ? U[K]
        : never;
    }
  : U
  : U;

/**
 * Flattens a nested object path to its value type.
 * Inverse of PathToObject.
 * @example
 * PathValue<{ links: { next: string } }, "links.next"> // string
 */
export type PathValue<T, Path extends string> = Path extends
  `${infer K}.${infer R}` ? K extends keyof T ? PathValue<T[K], R>
  : never
  : Path extends keyof T ? T[Path]
  : never;

/**
 * Converts a dot-notation path to a nested Zod object shape.
 * Similar to PathToObject but for Zod schema types.
 * @example
 * PathToZodShape<"items", z.ZodArray<...>> // { items: z.ZodArray<...> }
 * PathToZodShape<"links.next", z.ZodString> // { links: z.ZodObject<{ next: z.ZodString }> }
 */
export type PathToZodShape<Path extends string, T extends z.ZodType> =
  Path extends `${infer K}.${infer R}`
    ? { [Key in K]: z.ZodObject<PathToZodShape<R, T>> }
    : { [Key in Path]: T };

/**
 * Deeply merges Zod shapes, combining nested ZodObjects.
 */
export type MergeZodShapes<T, U> = {
  [K in keyof T | keyof U]: K extends keyof T
    ? K extends keyof U
      ? T[K] extends z.ZodObject<infer TA>
        ? U[K] extends z.ZodObject<infer UA>
          ? z.ZodObject<MergeZodShapes<TA, UA>>
        : U[K]
      : U[K]
    : T[K]
    : K extends keyof U ? U[K]
    : never;
};

/** Pagination styles supported */
export type PaginationStyle =
  | "cursor"
  | "cursorId"
  | "offset"
  | "page"
  | "url";

/** Base pagination metadata attached to endpoints */
export interface PaginationMeta {
  readonly style: PaginationStyle;
  readonly items: string;
  readonly limitParam?: string;
}

/** Cursor-based pagination metadata */
export interface CursorPaginationMeta extends PaginationMeta {
  readonly style: "cursor";
  readonly cursor: string;
  readonly cursorParam: string;
}

/** Cursor ID pagination (last item ID becomes cursor) */
export interface CursorIdPaginationMeta extends PaginationMeta {
  readonly style: "cursorId";
  readonly cursorIdParam: string;
  readonly idField: string;
}

/** Offset-based pagination metadata */
export interface OffsetPaginationMeta extends PaginationMeta {
  readonly style: "offset";
  readonly total: string;
  readonly offsetParam: string;
}

/** Page number pagination metadata */
export interface PagePaginationMeta extends PaginationMeta {
  readonly style: "page";
  readonly total?: string;
  readonly totalPages?: string;
  readonly pageParam: string;
  readonly perPageParam?: string;
}

/** URL-based pagination (like GitHub API) */
export interface UrlPaginationMeta extends PaginationMeta {
  readonly style: "url";
  readonly nextUrl: string;
  readonly prevUrl?: string;
}

/** Union of all pagination metadata types */
export type AnyPaginationMeta =
  | CursorPaginationMeta
  | CursorIdPaginationMeta
  | OffsetPaginationMeta
  | PagePaginationMeta
  | UrlPaginationMeta;

/** Field names for cursor pagination */
export interface CursorPaginationNames {
  /** Response field containing items array (default: "items") */
  readonly items?: string;
  /** Response field containing next cursor (default: "cursor") */
  readonly cursor?: string;
  /** Query param for cursor (default: "cursor") */
  readonly cursorParam?: string;
  /** Query param for limit (default: "limit") */
  readonly limitParam?: string;
}

/** Field names for cursor ID pagination */
export interface CursorIdPaginationNames {
  /** Response field containing items array (default: "items") */
  readonly items?: string;
  /** Query param for cursor ID (default: "after") */
  readonly cursorIdParam?: string;
  /** Field on item used as cursor ID (default: "id") */
  readonly idField?: string;
  /** Query param for limit (default: "limit") */
  readonly limitParam?: string;
}

/** Field names for offset pagination */
export interface OffsetPaginationNames {
  /** Response field containing items array (default: "items") */
  readonly items?: string;
  /** Response field containing total count (default: "total") */
  readonly total?: string;
  /** Query param for offset (default: "offset") */
  readonly offsetParam?: string;
  /** Query param for limit (default: "limit") */
  readonly limitParam?: string;
}

/** Field names for page pagination */
export interface PagePaginationNames {
  /** Response field containing items array (default: "items") */
  readonly items?: string;
  /** Response field containing total count */
  readonly total?: string;
  /** Response field containing total pages */
  readonly totalPages?: string;
  /** Query param for page number (default: "page") */
  readonly pageParam?: string;
  /** Query param for per page (default: "perPage") */
  readonly perPageParam?: string;
}

/** Field names for URL pagination */
export interface UrlPaginationNames {
  /** Response field containing items array (default: "items") */
  readonly items?: string;
  /** Response field containing next URL (default: "next") */
  readonly nextUrl?: string;
  /** Response field containing previous URL (default: "prev") */
  readonly prevUrl?: string;
}

/** Configuration for cursor pagination */
export interface CursorPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  readonly item: TItem;
  /** Custom field names (all have sensible defaults) */
  readonly names?: CursorPaginationNames;
  /** Additional query parameters */
  readonly extraQuery?: TExtraQuery;
  /** Additional response fields */
  readonly extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  readonly defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  readonly maxLimit?: number;
}

/** Configuration for cursor ID pagination */
export interface CursorIdPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  readonly item: TItem;
  /** Custom field names (all have sensible defaults) */
  readonly names?: CursorIdPaginationNames;
  /** Additional query parameters */
  readonly extraQuery?: TExtraQuery;
  /** Additional response fields */
  readonly extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  readonly defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  readonly maxLimit?: number;
}

/** Configuration for offset pagination */
export interface OffsetPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  readonly item: TItem;
  /** Custom field names (all have sensible defaults) */
  readonly names?: OffsetPaginationNames;
  /** Additional query parameters */
  readonly extraQuery?: TExtraQuery;
  /** Additional response fields */
  readonly extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  readonly defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  readonly maxLimit?: number;
}

/** Configuration for page pagination */
export interface PagePaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  readonly item: TItem;
  /** Custom field names (all have sensible defaults) */
  readonly names?: PagePaginationNames;
  /** Additional query parameters */
  readonly extraQuery?: TExtraQuery;
  /** Additional response fields */
  readonly extraResponse?: TExtraResponse;
  /** Default per page value (default: 20) */
  readonly defaultPerPage?: number;
  /** Maximum per page value (default: 100) */
  readonly maxPerPage?: number;
}

/** Configuration for URL pagination */
export interface UrlPaginationConfig<
  TItem extends z.ZodType,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  readonly item: TItem;
  /** Custom field names (all have sensible defaults) */
  readonly names?: UrlPaginationNames;
  /** Additional response fields */
  readonly extraResponse?: TExtraResponse;
}

/** Result of a pagination helper - spread into endpoint() */
export interface PaginatedEndpointDef<
  TQuery extends z.ZodType,
  TResponse extends z.ZodType,
  TMeta extends AnyPaginationMeta,
> {
  readonly query: TQuery;
  readonly response: TResponse;
  readonly __pagination: TMeta;
}
