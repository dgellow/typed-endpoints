import { z } from "zod";
import type {
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
  ): {
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
  } {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const cursorField = (names.cursor ?? "cursor") as TCursorField;
    const cursorParam = (names.cursorParam ?? "cursor") as TCursorParam;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [cursorParam]: z.string().optional(),
      [limitParam]: z.coerce.number().min(1).max(maxLimit).default(
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

    // deno-lint-ignore no-explicit-any
    return {
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "cursor",
        items: itemsField,
        cursor: cursorField,
        cursorParam,
        limitParam,
      },
    } as any;
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
  ): {
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
  } {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const cursorIdParam = (names.cursorIdParam ?? "after") as TCursorIdParam;
    const idField = (names.idField ?? "id") as TIdField;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [cursorIdParam]: z.string().optional(),
      [limitParam]: z.coerce.number().min(1).max(maxLimit).default(
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

    // deno-lint-ignore no-explicit-any
    return {
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "cursorId",
        items: itemsField,
        cursorIdParam,
        idField,
        limitParam,
      },
    } as any;
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
  ): {
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
  } {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const totalField = (names.total ?? "total") as TTotalField;
    const offsetParam = (names.offsetParam ?? "offset") as TOffsetParam;
    const limitParam = (names.limitParam ?? "limit") as TLimitParam;
    const defaultLimit = config.defaultLimit ?? 20;
    const maxLimit = config.maxLimit ?? 100;

    const queryShape: MutableShape = {
      [offsetParam]: z.coerce.number().min(0).default(0),
      [limitParam]: z.coerce.number().min(1).max(maxLimit).default(
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

    // deno-lint-ignore no-explicit-any
    return {
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "offset",
        items: itemsField,
        total: totalField,
        offsetParam,
        limitParam,
      },
    } as any;
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
  ): {
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
  } {
    const names = config.names ?? {};
    const itemsField = (names.items ?? "items") as TItemsField;
    const totalField = names.total as TTotalField;
    const totalPagesField = names.totalPages as TTotalPagesField;
    const pageParam = (names.pageParam ?? "page") as TPageParam;
    const perPageParam = (names.perPageParam ?? "perPage") as TPerPageParam;
    const defaultPerPage = config.defaultPerPage ?? 20;
    const maxPerPage = config.maxPerPage ?? 100;

    const queryShape: MutableShape = {
      [pageParam]: z.coerce.number().min(1).default(1),
      [perPageParam]: z.coerce
        .number()
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

    // deno-lint-ignore no-explicit-any
    return {
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
    } as any;
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
  ): {
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
  } {
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

    if (config.extraResponse) {
      Object.assign(responseShape, config.extraResponse);
    }

    // deno-lint-ignore no-explicit-any
    return {
      query: z.object(queryShape),
      response: z.object(responseShape),
      __pagination: {
        style: "url",
        items: itemsField,
        nextUrl: nextUrlField,
        prevUrl: prevUrlField,
      },
    } as any;
  },
};
