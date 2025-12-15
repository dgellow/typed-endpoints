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
export type { DependentStepConfig, ProtocolConfig, StepConfig } from "./dsl.ts";

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
  ResponseOf,
  SessionState,
  StepExecutor,
} from "./client.ts";
