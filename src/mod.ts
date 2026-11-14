// Core types
export type {
  ApiDef,
  ApiMethodDef,
  DeclaredResponse,
  ErrorStatus,
  HttpMethod,
  InferBody,
  InferParams,
  InferQuery,
  ResponsesDef,
  SseEvent,
  SseEventDef,
  SseMethodDef,
  ValidatedRequest,
} from "./core/types.ts";

// Responses whose type depends on the request
export {
  applyDependentResponse,
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
  AllOf,
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
  Requires,
  RequiresIn,
  Resolve,
  ResolveIn,
  ResponseFamily,
} from "./core/dependent_types.ts";

// Selections written as one string: ?select=id,author(name)
export {
  applySelection,
  parseSelect,
  selection,
  selectionIssues,
  type SelectionSchema,
  selectOf,
  SelectSyntaxError,
} from "./core/selection.ts";
export type {
  ChildrenOf,
  ParseItem,
  ParseItems,
  ParseSelect,
  PartialDeep,
  QueryText,
  SelectableIn,
  SelectDelimiter,
  Selected,
  SelectedBy,
  SelectError,
  Selection,
  SelectIssues,
  SelectNode,
  SelectProblem,
  SelectRequirement,
  TakeName,
  TrimSpaces,
} from "./core/selection_types.ts";

// Values from schemas
export {
  arbitrary,
  ArbitraryError,
  type ArbitraryOptions,
  type Random,
  seededRandom,
} from "./core/arbitrary.ts";

// Lens laws of a resource, checked against a server
export {
  checkResourceLaws,
  formatResourceLawsReport,
  type LawDifference,
  type LawExchange,
  type LawRefusal,
  type LawResult,
  type LawSkip,
  type LawViolation,
  type NotAResource,
  type Resource,
  RESOURCE_LAWS,
  type ResourceLaw,
  type ResourceLawsOptions,
  type ResourceLawsReport,
  type UpdateMethod,
} from "./core/laws.ts";

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

// The routes as language-neutral data, and code for other languages
export {
  type Contract,
  type ContractOperation,
  type ContractOptions,
  type ContractPathParam,
  generateContract,
  type JsonSchema,
} from "./contract/index.ts";
export {
  generateFastApi,
  type GenerateFastApiOptions,
} from "./python/index.ts";

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
  type DeclaredFailure,
  defineIntegration,
  fail,
  Failure,
  type HandlerMethodDef,
  type HandlerResult,
  type Handlers,
  type HandlerSseMethodDef,
  type Integration,
  type RawParams,
  type RequestAccess,
  type RouteHandler,
} from "./core/handlers.ts";

// Route file layouts
export {
  ROUTE_CONVENTIONS,
  type RouteConvention,
  type RouteOfFile,
  routeOfFile,
} from "./core/routes.ts";

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
export type {
  AnyComposition,
  AnyStep,
  Branch,
  Choice,
  DependentStep,
  MappedStep,
  Parallel,
  Protocol,
  ProtocolNode,
  Repeat,
  RequestLocation,
  RequestLocations,
  Sequence,
  Step,
} from "./protocol/types.ts";
export type { FieldMapping } from "./protocol/mapping.ts";

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
