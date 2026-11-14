// Core types
export type {
  ApiDef,
  ApiMethodDef,
  HttpMethod,
  InferBody,
  InferParams,
  InferQuery,
  SseEvent,
  SseEventDef,
  SseMethodDef,
  ValidatedRequest,
} from "./core/types.ts";

// Responses whose type depends on the request
export {
  expansion,
  type ExpansionSchema,
  fieldsOf,
  type NamesSchema,
  type OutputOf,
  projection,
  type ProjectionSchema,
  relationsOf,
  select,
} from "./core/dependent.ts";
export type {
  Apply,
  CertainNames,
  Dependent,
  DependentDescriptor,
  Expansion,
  Flatten,
  IsUnion,
  PossibleNames,
  Projection,
  QueryList,
  ReadonlyDeep,
  Resolve,
  ResolveIn,
  ResponseFamily,
} from "./core/dependent_types.ts";

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
export {
  openApiPlugin,
  type OpenApiPluginOptions,
  protocolTypesPlugin,
  type ProtocolTypesPluginOptions,
} from "./integrations/vite.ts";

// Route handlers for any framework
export {
  buildHandlers,
  type BuildHandlersOptions,
  type HandlerMethodDef,
  type Handlers,
  type HandlerSseMethodDef,
  type RequestAccess,
} from "./core/handlers.ts";

// Fresh adapter
export {
  type ApiDefOf,
  type ApiHandlers,
  createApiHandlers,
  endpoint,
  type FreshApiMethodDef,
  type FreshSseMethodDef,
  sseEndpoint,
} from "./integrations/fresh.ts";

// Protocol type generation
export {
  generateProtocolTypes,
  generateProtocolTypesFromModule,
} from "./protocol/typegen.ts";

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
  type MutableZodShape,
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
