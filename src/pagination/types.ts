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
  style: PaginationStyle;
  items: string;
  limitParam?: string;
}

/** Cursor-based pagination metadata */
export interface CursorPaginationMeta extends PaginationMeta {
  style: "cursor";
  cursor: string;
  cursorParam: string;
}

/** Cursor ID pagination (last item ID becomes cursor) */
export interface CursorIdPaginationMeta extends PaginationMeta {
  style: "cursorId";
  cursorIdParam: string;
  idField: string;
}

/** Offset-based pagination metadata */
export interface OffsetPaginationMeta extends PaginationMeta {
  style: "offset";
  total: string;
  offsetParam: string;
}

/** Page number pagination metadata */
export interface PagePaginationMeta extends PaginationMeta {
  style: "page";
  total?: string;
  totalPages?: string;
  pageParam: string;
  perPageParam?: string;
}

/** URL-based pagination (like GitHub API) */
export interface UrlPaginationMeta extends PaginationMeta {
  style: "url";
  nextUrl: string;
  prevUrl?: string;
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
  items?: string;
  /** Response field containing next cursor (default: "cursor") */
  cursor?: string;
  /** Query param for cursor (default: "cursor") */
  cursorParam?: string;
  /** Query param for limit (default: "limit") */
  limitParam?: string;
}

/** Field names for cursor ID pagination */
export interface CursorIdPaginationNames {
  /** Response field containing items array (default: "items") */
  items?: string;
  /** Query param for cursor ID (default: "after") */
  cursorIdParam?: string;
  /** Field on item used as cursor ID (default: "id") */
  idField?: string;
  /** Query param for limit (default: "limit") */
  limitParam?: string;
}

/** Field names for offset pagination */
export interface OffsetPaginationNames {
  /** Response field containing items array (default: "items") */
  items?: string;
  /** Response field containing total count (default: "total") */
  total?: string;
  /** Query param for offset (default: "offset") */
  offsetParam?: string;
  /** Query param for limit (default: "limit") */
  limitParam?: string;
}

/** Field names for page pagination */
export interface PagePaginationNames {
  /** Response field containing items array (default: "items") */
  items?: string;
  /** Response field containing total count */
  total?: string;
  /** Response field containing total pages */
  totalPages?: string;
  /** Query param for page number (default: "page") */
  pageParam?: string;
  /** Query param for per page (default: "perPage") */
  perPageParam?: string;
}

/** Field names for URL pagination */
export interface UrlPaginationNames {
  /** Response field containing items array (default: "items") */
  items?: string;
  /** Response field containing next URL (default: "next") */
  nextUrl?: string;
  /** Response field containing previous URL (default: "prev") */
  prevUrl?: string;
}

/** Configuration for cursor pagination */
export interface CursorPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  item: TItem;
  /** Custom field names (all have sensible defaults) */
  names?: CursorPaginationNames;
  /** Additional query parameters */
  extraQuery?: TExtraQuery;
  /** Additional response fields */
  extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  maxLimit?: number;
}

/** Configuration for cursor ID pagination */
export interface CursorIdPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  item: TItem;
  /** Custom field names (all have sensible defaults) */
  names?: CursorIdPaginationNames;
  /** Additional query parameters */
  extraQuery?: TExtraQuery;
  /** Additional response fields */
  extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  maxLimit?: number;
}

/** Configuration for offset pagination */
export interface OffsetPaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  item: TItem;
  /** Custom field names (all have sensible defaults) */
  names?: OffsetPaginationNames;
  /** Additional query parameters */
  extraQuery?: TExtraQuery;
  /** Additional response fields */
  extraResponse?: TExtraResponse;
  /** Default limit value (default: 20) */
  defaultLimit?: number;
  /** Maximum limit value (default: 100) */
  maxLimit?: number;
}

/** Configuration for page pagination */
export interface PagePaginationConfig<
  TItem extends z.ZodType,
  TExtraQuery extends MutableZodShape | undefined = undefined,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  item: TItem;
  /** Custom field names (all have sensible defaults) */
  names?: PagePaginationNames;
  /** Additional query parameters */
  extraQuery?: TExtraQuery;
  /** Additional response fields */
  extraResponse?: TExtraResponse;
  /** Default per page value (default: 20) */
  defaultPerPage?: number;
  /** Maximum per page value (default: 100) */
  maxPerPage?: number;
}

/** Configuration for URL pagination */
export interface UrlPaginationConfig<
  TItem extends z.ZodType,
  TExtraResponse extends MutableZodShape | undefined = undefined,
> {
  /** Schema for each item in the paginated list */
  item: TItem;
  /** Custom field names (all have sensible defaults) */
  names?: UrlPaginationNames;
  /** Additional response fields */
  extraResponse?: TExtraResponse;
}

/** Result of a pagination helper - spread into endpoint() */
export interface PaginatedEndpointDef<
  TQuery extends z.ZodType,
  TResponse extends z.ZodType,
  TMeta extends AnyPaginationMeta,
> {
  query: TQuery;
  response: TResponse;
  __pagination: TMeta;
}
