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
  type FreshApiDef,
  type FreshApiMethodDef,
} from "./adapters/fresh.ts";
