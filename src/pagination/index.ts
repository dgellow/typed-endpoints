import { z } from "zod";
import type {
  AnyPaginationMeta,
  CursorIdPaginationConfig,
  CursorIdPaginationMeta,
  CursorPaginationConfig,
  CursorPaginationMeta,
  MutableZodShape,
  OffsetPaginationConfig,
  OffsetPaginationMeta,
  PagePaginationConfig,
  PagePaginationMeta,
  PathToObject,
  UrlPaginationConfig,
  UrlPaginationMeta,
} from "./types.ts";

export * from "./types.ts";

// Alias for internal use
type MutableShape = MutableZodShape;

// =============================================================================
// Building a page
// =============================================================================

/** The extra response fields of a page, when the helper declares any. */
export type ExtraOf<TExtra> = TExtra extends MutableShape ? {
    /** The fields declared with `extraResponse`. */
    readonly extra: { readonly [K in keyof TExtra]: z.input<TExtra[K]> };
  }
  : unknown;

/** A page of a cursor-paginated endpoint. */
export type CursorPage<TItem extends z.ZodType, TExtra> = {
  /** The items of the page. */
  readonly items: readonly z.input<TItem>[];
  /** The cursor of the next page; absent or `null` on the last page. */
  readonly cursor?: string | null;
} & ExtraOf<TExtra>;

/** A page of an endpoint whose style needs the items only. */
export type ItemsPage<TItem extends z.ZodType, TExtra> = {
  /** The items of the page. */
  readonly items: readonly z.input<TItem>[];
} & ExtraOf<TExtra>;

/** A page of an offset-paginated endpoint. */
export type OffsetPage<TItem extends z.ZodType, TExtra> = {
  /** The items of the page. */
  readonly items: readonly z.input<TItem>[];
  /** How many items there are in all. */
  readonly total: number;
} & ExtraOf<TExtra>;

/** A page of a page-numbered endpoint. */
export type NumberedPage<
  TItem extends z.ZodType,
  TTotal,
  TTotalPages,
  TExtra,
> =
  & {
    /** The items of the page. */
    readonly items: readonly z.input<TItem>[];
  }
  & (TTotal extends string ? {
      /** How many items there are in all. */
      readonly total: number;
    }
    : unknown)
  & (TTotalPages extends string ? {
      /** How many pages there are. */
      readonly totalPages: number;
    }
    : unknown)
  & ExtraOf<TExtra>;

/** A page of a URL-paginated endpoint. */
export type UrlPage<TItem extends z.ZodType, TPrev, TExtra> =
  & {
    /** The items of the page. */
    readonly items: readonly z.input<TItem>[];
    /** URL of the next page; absent or `null` on the last page. */
    readonly next?: string | null;
  }
  & (TPrev extends string ? {
      /** URL of the previous page; absent or `null` on the first page. */
      readonly prev?: string | null;
    }
    : unknown)
  & ExtraOf<TExtra>;

/**
 * A pagination helper's result with its page builder.
 *
 * `page()` puts the items and the style's bookkeeping where the response
 * schema expects them, under the field names the helper was configured
 * with, so a handler does not repeat them:
 *
 * ```ts
 * const users = cursor.paginated({ item: User, names: { items: "data" } });
 *
 * GET: endpoint({
 *   ...users,
 *   handler: async (_ctx, { query }) => {
 *     const { rows, next } = await db.users(query.cursor, query.limit);
 *     return users.page({ items: rows, cursor: next });
 *   },
 * })
 * ```
 *
 * The builder is not enumerable: spreading the result into `endpoint()`
 * copies the schemas and the metadata only.
 */
export type WithPage<TDef extends { response: z.ZodType }, TParts> = TDef & {
  /**
   * Build a response of this endpoint from a page.
   *
   * @param parts The items, and what the pagination style needs.
   */
  page(parts: TParts): z.input<TDef["response"]>;
};

/** Set the value at a dot-notation path, creating the objects on the way. */
function setAt(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    current = (current[key] ??= {}) as Record<string, unknown>;
  }
  // An absent value leaves no key behind, only the objects on the way.
  if (value !== undefined) current[keys[keys.length - 1]] = value;
}

/** Merge `extra` into `target`, object by object. */
function mergeInto(
  target: Record<string, unknown>,
  extra: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(extra)) {
    const existing = target[key];
    if (
      isPlainObject(existing) && isPlainObject(value)
    ) {
      mergeInto(existing, value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** What `page()` is given, whatever the style. */
interface AnyPage {
  readonly items: readonly unknown[];
  readonly cursor?: string | null;
  readonly total?: number;
  readonly totalPages?: number;
  readonly next?: string | null;
  readonly prev?: string | null;
  readonly extra?: Record<string, unknown>;
}

/** The response object of a page, for the given pagination metadata. */
function buildPage(
  meta: AnyPaginationMeta,
  parts: AnyPage,
): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  setAt(response, meta.items, [...parts.items]);

  switch (meta.style) {
    case "cursor":
      if (parts.cursor != null) setAt(response, meta.cursor, parts.cursor);
      break;
    case "cursorId":
      break;
    case "offset":
      setAt(response, meta.total, parts.total);
      break;
    case "page":
      if (meta.total) setAt(response, meta.total, parts.total);
      if (meta.totalPages) setAt(response, meta.totalPages, parts.totalPages);
      break;
    case "url":
      // A link that is absent still has its parent object in the schema
      // (`links` for `links.next`): a page without links needs `links: {}`.
      setAt(response, meta.nextUrl, parts.next ?? undefined);
      if (meta.prevUrl) setAt(response, meta.prevUrl, parts.prev ?? undefined);
      break;
  }

  if (parts.extra) mergeInto(response, parts.extra);
  return response;
}

/** Give a helper's result its `page()` builder, out of the way of spreads. */
function attachPage<TDef extends { __pagination: AnyPaginationMeta }>(
  def: TDef,
): TDef {
  Object.defineProperty(def, "page", {
    value: (parts: AnyPage) => buildPage(def.__pagination, parts),
    enumerable: false,
  });
  return def;
}

/**
 * Build a nested Zod object shape from a dot-notation path.
 * @example
 * buildNestedShape("links.next", z.string()) → { links: z.object({ next: z.string() }) }
 * buildNestedShape("items", z.array(...)) → { items: z.array(...) }
 */
function buildNestedShape(path: string, schema: z.ZodType): MutableShape {
  const parts = path.split(".");
  if (parts.length === 1) {
    return { [path]: schema };
  }

  // Build from innermost to outermost
  let current: z.ZodType = schema;
  for (let i = parts.length - 1; i > 0; i--) {
    current = z.object({ [parts[i]]: current });
  }

  return { [parts[0]]: current };
}

/**
 * Deeply merge two Zod shapes, combining nested objects.
 * If both shapes have the same key with object schemas, merge them recursively.
 */
function mergeShapes(a: MutableShape, b: MutableShape): MutableShape {
  const result: MutableShape = { ...a };

  for (const [key, bSchema] of Object.entries(b)) {
    if (key in result) {
      const aSchema = result[key];
      // If both are ZodObjects, merge their shapes
      if (
        aSchema instanceof z.ZodObject &&
        bSchema instanceof z.ZodObject
      ) {
        const mergedShape = mergeShapes(
          aSchema.shape as MutableShape,
          bSchema.shape as MutableShape,
        );
        result[key] = z.object(mergedShape);
      } else {
        // Overwrite with b
        result[key] = bSchema;
      }
    } else {
      result[key] = bSchema;
    }
  }

  return result;
}

/**
 * Cursor-based pagination helper.
 *
 * Generates query and response schemas with proper types.
 * Spread the result into endpoint().
 *
 * @example
 * ```ts
 * GET: endpoint({
 *   ...cursor.paginated({
 *     item: UserSchema,
 *     names: { items: "data", cursor: "nextCursor" },
 *   }),
 *   handler: (ctx, { query }) => { ... },
 * })
 * ```
 */
export const cursor = {
  paginated<
    TItem extends z.ZodType,
    TExtraQuery extends MutableShape | undefined = undefined,
    TExtraResponse extends MutableShape | undefined = undefined,
    TItemsField extends string = "items",
    TCursorField extends string = "cursor",
    TCursorParam extends string = "cursor",
    TLimitParam extends string = "limit",
  >(
    config: CursorPaginationConfig<TItem, TExtraQuery, TExtraResponse> & {
      names?: {
        items?: TItemsField;
        cursor?: TCursorField;
        cursorParam?: TCursorParam;
        limitParam?: TLimitParam;
      };
    },
  ): WithPage<{
    query: z.ZodObject<
      & { [K in TCursorParam]: z.ZodOptional<z.ZodString> }
      & { [K in TLimitParam]: z.ZodDefault<z.ZodNumber> }
      & (TExtraQuery extends MutableShape ? TExtraQuery : object)
    >;
    response: z.ZodObject<
      & { [K in TItemsField]: z.ZodArray<TItem> }
      & { [K in TCursorField]: z.ZodOptional<z.ZodString> }
      & (TExtraResponse extends MutableShape ? TExtraResponse : object)
    >;
    __pagination: CursorPaginationMeta;
  }, CursorPage<TItem, TExtraResponse>> {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const cursorField = (names.cursor ?? "cursor") as TCursorField;
    const cursorParam = (names.cursorParam ?? "cursor") as TCursorParam;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [cursorParam]: z.string().optional(),
      [limitParam]: z.coerce.number().int().min(1).max(maxLimit).default(
        defaultLimit,
      ),
    };

    if (config.extraQuery) {
      Object.assign(queryShape, config.extraQuery);
    }

    const responseShape: MutableShape = {
      [itemsField]: z.array(config.item),
      [cursorField]: z.string().optional(),
    };

    if (config.extraResponse) {
      Object.assign(responseShape, config.extraResponse);
    }

    return attachPage({
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "cursor",
        items: itemsField,
        cursor: cursorField,
        cursorParam,
        limitParam,
      },
      // deno-lint-ignore no-explicit-any
    }) as any;
  },
};

/**
 * Cursor ID pagination helper (last item's ID becomes cursor).
 *
 * @example
 * ```ts
 * GET: endpoint({
 *   ...cursorId.paginated({
 *     item: UserSchema,
 *     names: { cursorIdParam: "after" },
 *   }),
 *   handler: (ctx, { query }) => { ... },
 * })
 * ```
 */
export const cursorId = {
  paginated<
    TItem extends z.ZodType,
    TExtraQuery extends MutableShape | undefined = undefined,
    TExtraResponse extends MutableShape | undefined = undefined,
    TItemsField extends string = "items",
    TCursorIdParam extends string = "after",
    TIdField extends string = "id",
    TLimitParam extends string = "limit",
  >(
    config: CursorIdPaginationConfig<TItem, TExtraQuery, TExtraResponse> & {
      names?: {
        items?: TItemsField;
        cursorIdParam?: TCursorIdParam;
        idField?: TIdField;
        limitParam?: TLimitParam;
      };
    },
  ): WithPage<{
    query: z.ZodObject<
      & { [K in TCursorIdParam]: z.ZodOptional<z.ZodString> }
      & { [K in TLimitParam]: z.ZodDefault<z.ZodNumber> }
      & (TExtraQuery extends MutableShape ? TExtraQuery : object)
    >;
    response: z.ZodObject<
      & { [K in TItemsField]: z.ZodArray<TItem> }
      & (TExtraResponse extends MutableShape ? TExtraResponse : object)
    >;
    __pagination: CursorIdPaginationMeta;
  }, ItemsPage<TItem, TExtraResponse>> {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const cursorIdParam = (names.cursorIdParam ?? "after") as TCursorIdParam;
    const idField = (names.idField ?? "id") as TIdField;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [cursorIdParam]: z.string().optional(),
      [limitParam]: z.coerce.number().int().min(1).max(maxLimit).default(
        defaultLimit,
      ),
    };

    if (config.extraQuery) {
      Object.assign(queryShape, config.extraQuery);
    }

    const responseShape: MutableShape = {
      [itemsField]: z.array(config.item),
    };

    if (config.extraResponse) {
      Object.assign(responseShape, config.extraResponse);
    }

    return attachPage({
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "cursorId",
        items: itemsField,
        cursorIdParam,
        idField,
        limitParam,
      },
      // deno-lint-ignore no-explicit-any
    }) as any;
  },
};

/**
 * Offset-based pagination helper.
 *
 * @example
 * ```ts
 * GET: endpoint({
 *   ...offset.paginated({
 *     item: UserSchema,
 *     names: { items: "data", total: "count" },
 *   }),
 *   handler: (ctx, { query }) => { ... },
 * })
 * ```
 */
export const offset = {
  paginated<
    TItem extends z.ZodType,
    TExtraQuery extends MutableShape | undefined = undefined,
    TExtraResponse extends MutableShape | undefined = undefined,
    TItemsField extends string = "items",
    TTotalField extends string = "total",
    TOffsetParam extends string = "offset",
    TLimitParam extends string = "limit",
  >(
    config: OffsetPaginationConfig<TItem, TExtraQuery, TExtraResponse> & {
      names?: {
        items?: TItemsField;
        total?: TTotalField;
        offsetParam?: TOffsetParam;
        limitParam?: TLimitParam;
      };
    },
  ): WithPage<{
    query: z.ZodObject<
      & { [K in TOffsetParam]: z.ZodDefault<z.ZodNumber> }
      & { [K in TLimitParam]: z.ZodDefault<z.ZodNumber> }
      & (TExtraQuery extends MutableShape ? TExtraQuery : object)
    >;
    response: z.ZodObject<
      & { [K in TItemsField]: z.ZodArray<TItem> }
      & { [K in TTotalField]: z.ZodNumber }
      & (TExtraResponse extends MutableShape ? TExtraResponse : object)
    >;
    __pagination: OffsetPaginationMeta;
  }, OffsetPage<TItem, TExtraResponse>> {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const totalField = (names.total ?? "total") as TTotalField;
    const offsetParam = (names.offsetParam ?? "offset") as TOffsetParam;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [offsetParam]: z.coerce.number().int().min(0).default(0),
      [limitParam]: z.coerce.number().int().min(1).max(maxLimit).default(
        defaultLimit,
      ),
    };

    if (config.extraQuery) {
      Object.assign(queryShape, config.extraQuery);
    }

    const responseShape: MutableShape = {
      [itemsField]: z.array(config.item),
      [totalField]: z.number(),
    };

    if (config.extraResponse) {
      Object.assign(responseShape, config.extraResponse);
    }

    return attachPage({
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "offset",
        items: itemsField,
        total: totalField,
        offsetParam,
        limitParam,
      },
      // deno-lint-ignore no-explicit-any
    }) as any;
  },
};

/**
 * Page number pagination helper.
 *
 * @example
 * ```ts
 * GET: endpoint({
 *   ...page.paginated({
 *     item: UserSchema,
 *     names: { items: "results", totalPages: "pages" },
 *   }),
 *   handler: (ctx, { query }) => { ... },
 * })
 * ```
 */
export const page = {
  paginated<
    TItem extends z.ZodType,
    TExtraQuery extends MutableShape | undefined = undefined,
    TExtraResponse extends MutableShape | undefined = undefined,
    TItemsField extends string = "items",
    TTotalField extends string | undefined = undefined,
    TTotalPagesField extends string | undefined = undefined,
    TPageParam extends string = "page",
    TPerPageParam extends string = "perPage",
  >(
    config: PagePaginationConfig<TItem, TExtraQuery, TExtraResponse> & {
      names?: {
        items?: TItemsField;
        total?: TTotalField;
        totalPages?: TTotalPagesField;
        pageParam?: TPageParam;
        perPageParam?: TPerPageParam;
      };
    },
  ): WithPage<{
    query: z.ZodObject<
      & { [K in TPageParam]: z.ZodDefault<z.ZodNumber> }
      & { [K in TPerPageParam]: z.ZodDefault<z.ZodNumber> }
      & (TExtraQuery extends MutableShape ? TExtraQuery : object)
    >;
    response: z.ZodObject<
      & { [K in TItemsField]: z.ZodArray<TItem> }
      & (TTotalField extends string ? { [K in TTotalField]: z.ZodNumber }
        : object)
      & (TTotalPagesField extends string
        ? { [K in TTotalPagesField]: z.ZodNumber }
        : object)
      & (TExtraResponse extends MutableShape ? TExtraResponse : object)
    >;
    __pagination: PagePaginationMeta;
  }, NumberedPage<TItem, TTotalField, TTotalPagesField, TExtraResponse>> {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const totalField = names.total as TTotalField;
    const totalPagesField = names.totalPages as TTotalPagesField;
    const pageParam = (names.pageParam ?? "page") as TPageParam;
    const perPageParam = (names.perPageParam ?? "perPage") as TPerPageParam;
    const defaultPerPage = config.defaultPerPage ?? 20;
    const maxPerPage = config.maxPerPage ?? 100;

    const queryShape: MutableShape = {
      [pageParam]: z.coerce.number().int().min(1).default(1),
      [perPageParam]: z.coerce
        .number()
        .int()
        .min(1)
        .max(maxPerPage)
        .default(defaultPerPage),
    };

    if (config.extraQuery) {
      Object.assign(queryShape, config.extraQuery);
    }

    const responseShape: MutableShape = {
      [itemsField]: z.array(config.item),
    };

    if (totalField) {
      responseShape[totalField] = z.number();
    }
    if (totalPagesField) {
      responseShape[totalPagesField] = z.number();
    }

    if (config.extraResponse) {
      Object.assign(responseShape, config.extraResponse);
    }

    return attachPage({
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "page",
        items: itemsField,
        total: totalField,
        totalPages: totalPagesField,
        pageParam,
        perPageParam,
      },
      // deno-lint-ignore no-explicit-any
    }) as any;
  },
};

/**
 * URL-based pagination helper (like GitHub API).
 *
 * Supports dot-notation paths for nested response structure:
 * - `nextUrl: "links.next"` creates `{ links: { next?: string } }`
 *
 * @example
 * ```ts
 * GET: endpoint({
 *   ...url.paginated({
 *     item: RepoSchema,
 *     names: { nextUrl: "links.next", prevUrl: "links.prev" },
 *   }),
 *   handler: (ctx) => { ... },
 * })
 * // Response type: { items: Repo[]; links: { next?: string; prev?: string } }
 * ```
 */
export const url = {
  paginated<
    TItem extends z.ZodType,
    TExtraResponse extends MutableShape | undefined = undefined,
    TItemsField extends string = "items",
    TNextUrlField extends string = "next",
    TPrevUrlField extends string | undefined = undefined,
  >(
    config: UrlPaginationConfig<TItem, TExtraResponse> & {
      names?: {
        items?: TItemsField;
        nextUrl?: TNextUrlField;
        prevUrl?: TPrevUrlField;
      };
    },
  ): WithPage<{
    query: z.ZodObject<MutableShape>;
    // Response type uses PathToObject for inferred value types (not Zod schema types)
    // The runtime schema correctly builds nested objects from dot-notation paths
    response: z.ZodType<
      & PathToObject<TItemsField, z.infer<TItem>[]>
      & PathToObject<TNextUrlField, string | undefined>
      & (TPrevUrlField extends string
        ? PathToObject<TPrevUrlField, string | undefined>
        : object)
      & (TExtraResponse extends MutableShape
        ? { [K in keyof TExtraResponse]: z.infer<TExtraResponse[K]> }
        : object)
    >;
    __pagination: UrlPaginationMeta;
  }, UrlPage<TItem, TPrevUrlField, TExtraResponse>> {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const nextUrlField = (names.nextUrl ?? "next") as TNextUrlField;
    const prevUrlField = names.prevUrl as TPrevUrlField;

    // URL pagination typically doesn't have query params for pagination
    // (the URLs are in the response)
    const queryShape: MutableShape = {};

    // Build nested response shape using dot-notation paths
    let responseShape = buildNestedShape(itemsField, z.array(config.item));
    responseShape = mergeShapes(
      responseShape,
      buildNestedShape(nextUrlField, z.string().optional()),
    );

    if (prevUrlField) {
      responseShape = mergeShapes(
        responseShape,
        buildNestedShape(prevUrlField, z.string().optional()),
      );
    }

    // Merged, not assigned: an extra field may share a parent object with a
    // pagination path (`links.self` next to `links.next`).
    if (config.extraResponse) {
      responseShape = mergeShapes(responseShape, config.extraResponse);
    }

    return attachPage({
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "url",
        items: itemsField,
        nextUrl: nextUrlField,
        prevUrl: prevUrlField,
      },
      // deno-lint-ignore no-explicit-any
    }) as any;
  },
};
