// Core types
export type {
  ApiDef,
  ApiMethodDef,
  HttpMethod,
  InferBody,
  InferParams,
  InferQuery,
  ValidatedRequest,
} from "./core/types.ts";

// Validation
export {
  parseSearchParams,
  type RawRequest,
  validateRequest,
  type ValidationError,
  type ValidationOutcome,
  type ValidationResult,
} from "./core/validation.ts";

// OpenAPI generation
export {
  filePathToOpenApiPath,
  generateOpenApiSpec,
  type GeneratorOptions,
  type OpenApiInfo,
  type OpenApiServer,
  type RouteModule,
} from "./core/openapi.ts";

// TypeScript generation
export { generateTypes, type TypeGenOptions } from "./tsgen/mod.ts";

// Vite plugin
export { openApiPlugin, type OpenApiPluginOptions } from "./vite-plugin.ts";

// Fresh adapter
export {
  createApiHandlers,
  endpoint,
  type FreshApiMethodDef,
} from "./adapters/fresh.ts";

// Protocol type generation
export { generateProtocolTypes } from "./protocol/typegen.ts";

// Pagination helpers
export {
  type AnyPaginationMeta,
  cursor,
  cursorId,
  type CursorIdPaginationConfig,
  type CursorIdPaginationMeta,
  type CursorIdPaginationNames,
  type CursorPaginationConfig,
  type CursorPaginationMeta,
  type CursorPaginationNames,
  offset,
  type OffsetPaginationConfig,
  type OffsetPaginationMeta,
  type OffsetPaginationNames,
  page,
  type PagePaginationConfig,
  type PagePaginationMeta,
  type PagePaginationNames,
  type PaginatedEndpointDef,
  type PaginationMeta,
  type PaginationStyle,
  url,
  type UrlPaginationConfig,
  type UrlPaginationMeta,
  type UrlPaginationNames,
} from "./pagination/index.ts";
