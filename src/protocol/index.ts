/**
 * Protocol Schema DSL
 *
 * A type-safe DSL for defining multi-step protocols with dependent types.
 *
 * Inspired by André Videla's Container Morphisms research:
 * @see https://arxiv.org/abs/2407.16713
 *
 * Key concepts:
 * - Container: (req : Type) × (res : req → Type)
 * - Sequential Product (>>): response of step N shapes request of step N+1
 * - Kleene Star (*): zero or more repetitions
 * - Coproduct (+): choice between alternatives
 *
 * ## Type System Limitations
 *
 * True sequential product (>>) requires Σ (dependent sum) where the type of the
 * second component depends on the VALUE of the first. TypeScript lacks dependent
 * types, so our implementation is a pragmatic approximation:
 *
 * **Compile-time**: We track which step NAMES have completed via TDone union type.
 * AvailableSteps<TSteps, TDone> determines which steps can be executed next.
 *
 * **Runtime**: The `request: (prev) => Schema` function (a "suspended continuation")
 * receives the actual response value and constructs a schema with z.literal(prev.code).
 * Zod validates that the literal matches at runtime.
 *
 * The coproduct (+) IS fully expressible since TypeScript unions are structural.
 * This asymmetry is inherent - we get dependent protocol behavior through runtime
 * validation, with compile-time enforcement limited to step ordering.
 *
 * @example
 * ```typescript
 * import { step, dependentStep, protocol } from "./protocol";
 * import { z } from "zod";
 *
 * const authorizeStep = step({
 *   name: "authorize",
 *   request: z.object({ client_id: z.string() }),
 *   response: z.object({ code: z.string() }),
 * });
 *
 * const exchangeStep = dependentStep({
 *   name: "exchange",
 *   dependsOn: "authorize",
 *   request: (prev) => z.object({
 *     code: z.literal(prev.code), // Type-safe dependency!
 *   }),
 *   response: z.object({ access_token: z.string() }),
 * });
 *
 * const myProtocol = protocol({
 *   name: "OAuth",
 *   initial: "authorize",
 *   steps: { authorize: authorizeStep, exchange: exchangeStep },
 * });
 * ```
 *
 * @module
 */

// Core types
export type {
  AnyComposition,
  AnyProtocolElement,
  AnyStep,
  Branch,
  Choice,
  DependentStep,
  MappedStep,
  Parallel,
  Protocol,
  ProtocolMorphism,
  ProtocolState,
  Repeat,
  Sequence,
  SequenceState,
  Step,
  StepName,
  StepRequest,
  StepResponse,
  StepResult,
  ValidNextSteps,
} from "./types.ts";

// DSL functions
export {
  branch,
  buildDependencyGraph,
  choice,
  dependentStep,
  getStepDependencies,
  getStepNames,
  mappedStep,
  parallel,
  protocol,
  repeat,
  repeat1,
  sequence,
  step,
  topologicalSort,
  validateProtocol,
} from "./dsl.ts";

// DSL config types
export type {
  DependentStepConfig,
  MappedStepConfig,
  ProtocolConfig,
  StepConfig,
} from "./dsl.ts";

// Field mapping
export { fromStep, isFieldMapping } from "./mapping.ts";

// Field mapping types
export type { FieldMapping } from "./mapping.ts";

// OAuth 2.0 example (for reference)
export {
  // Schemas
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  // Steps
  authorizeStep,
  AuthorizeSuccessSchema,
  ExchangeResponseSchema,
  exchangeStep,
  // Protocol
  oauth2AuthCodeProtocol,
  OAuthErrorSchema,
  refreshStep,
  revokeStep,
  TokenErrorSchema,
  TokenResponseSchema,
} from "./oauth.ts";

// OAuth types
export type {
  AuthorizeRequest,
  AuthorizeResponse,
  ExchangeResponse,
  OAuth2Protocol,
  TokenResponse,
} from "./oauth.ts";

// Protocol client
export {
  createMockExecutor,
  createSession,
  ProtocolSession,
} from "./client.ts";

// Client types
export type {
  AvailableSteps,
  ExecuteResult,
  ExecutionContext,
  MockResponses,
  SessionState,
  StepExecutor,
} from "./client.ts";

// OpenAPI extensions
export {
  addProtocolsToSpec,
  addProtocolToSpec,
  protocolToOpenApi,
} from "./openapi.ts";

// OpenAPI extension types
export type { XProtocol, XProtocolStep } from "./openapi.ts";

// HTTP executor
export { createHttpExecutor, HttpError } from "./http.ts";

// HTTP executor types
export type { HttpExecutorConfig, RouteConfig } from "./http.ts";

// Type generation
export { generateProtocolTypes } from "./typegen.ts";

// Endpoint composition
export {
  fromEndpoint,
  fromEndpointDependent,
  fromEndpointMapped,
} from "./compose.ts";

// Composition types
export type {
  FromEndpointDependentOptions,
  FromEndpointMappedOptions,
  FromEndpointOptions,
  HandlerWithApiDef,
} from "./compose.ts";
