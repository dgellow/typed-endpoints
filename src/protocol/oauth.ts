/**
 * OAuth 2.0 Authorization Code Flow - Protocol Schema Example
 *
 * This demonstrates how container morphisms can model real-world
 * authentication protocols where each step depends on the previous.
 *
 * The key insight: the `exchange` step's request DEPENDS ON the `authorize`
 * step's response (the authorization code).
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
 */

import { z } from "zod";
import { dependentStep, protocol, step } from "./dsl.ts";

// =============================================================================
// Schema Definitions
// =============================================================================

/** OAuth 2.0 Error Response */
export const OAuthErrorSchema = z.object({
  error: z.enum([
    "invalid_request",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable",
  ]),
  error_description: z.string().optional(),
  error_uri: z.url().optional(),
  state: z.string().optional(),
});

/** Authorization Request (Step 1) */
export const AuthorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.url().optional(),
  scope: z.string().optional(),
  state: z.string(),
});

/** Authorization Response - Success (redirected to client) */
export const AuthorizeSuccessSchema = z.object({
  code: z.string(),
  state: z.string(),
});

/** Authorization Response - discriminated union */
export const AuthorizeResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }).extend(AuthorizeSuccessSchema.shape),
  z.object({ type: z.literal("error") }).extend(OAuthErrorSchema.shape),
]);

/** Token Response (for both exchange and refresh) */
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

/** Token Error Response */
export const TokenErrorSchema = z.object({
  error: z.enum([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
  ]),
  error_description: z.string().optional(),
  error_uri: z.url().optional(),
});

/** Token Exchange Response - discriminated union */
export const ExchangeResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }).extend(TokenResponseSchema.shape),
  z.object({ type: z.literal("error") }).extend(TokenErrorSchema.shape),
]);

// =============================================================================
// Protocol Steps
// =============================================================================

/**
 * Step 1: Authorization Request
 *
 * Client redirects user to authorization server.
 * User authenticates and grants permission.
 * Server redirects back with authorization code.
 */
export const authorizeStep = step({
  name: "authorize",
  description: "Redirect user to authorization server for authentication",
  request: AuthorizeRequestSchema,
  response: AuthorizeResponseSchema,
});

/**
 * Step 2: Token Exchange
 *
 * Client exchanges authorization code for access token.
 * The request DEPENDS ON the authorize response (uses the code).
 *
 * This is the key demonstration of container morphisms:
 * the request schema is a function of the previous response.
 *
 * `when` states which authorize responses the step can follow. TypeScript
 * infers the type guard from the predicate, so `prev` in `request` is the
 * success variant and `prev.code` needs no check.
 */
export const exchangeStep = dependentStep({
  name: "exchange",
  dependsOn: authorizeStep,
  description: "Exchange authorization code for access token",
  when: (prev) => prev.type === "success",
  request: (prev) =>
    z.object({
      grant_type: z.literal("authorization_code"),
      code: z.literal(prev.code), // THE KEY: code comes from authorize response
      redirect_uri: z.url().optional(),
      client_id: z.string(),
      client_secret: z.string(),
    }),
  response: ExchangeResponseSchema,
});

/** A successful token response. */
type TokenSuccess = Extract<
  z.infer<typeof ExchangeResponseSchema>,
  { type: "success" }
>;

/**
 * Step 3: Token Refresh
 *
 * Client uses refresh token to get new access token.
 * Can be called multiple times (Kleene star pattern).
 *
 * Needs a successful exchange that issued a refresh token. The guard
 * combines two conditions, which TypeScript does not infer a type guard
 * from, so the guard type is written out.
 */
export const refreshStep = dependentStep({
  name: "refresh",
  dependsOn: exchangeStep,
  description: "Refresh access token using refresh token",
  when: (prev): prev is TokenSuccess & { refresh_token: string } =>
    prev.type === "success" && prev.refresh_token !== undefined,
  request: (prev) =>
    z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.literal(prev.refresh_token), // From exchange response
      client_id: z.string(),
      client_secret: z.string().optional(),
      scope: z.string().optional(),
    }),
  response: ExchangeResponseSchema,
});

/**
 * Step 4: Token Revocation
 *
 * Client revokes access or refresh token.
 */
export const revokeStep = dependentStep({
  name: "revoke",
  dependsOn: exchangeStep,
  description: "Revoke access or refresh token",
  when: (prev) => prev.type === "success",
  request: () =>
    z.object({
      token: z.string(), // access_token or refresh_token
      token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      client_id: z.string(),
      client_secret: z.string().optional(),
    }),
  response: z.object({
    // RFC 7009 - revocation response is empty on success
    revoked: z.literal(true),
  }),
});

// =============================================================================
// Complete Protocol
// =============================================================================

/**
 * OAuth 2.0 Authorization Code Flow Protocol
 *
 * State machine:
 *   [initial] → authorize → [has_code | error]
 *   [has_code] → exchange → [authenticated | error]
 *   [authenticated] → refresh → [authenticated | error]
 *   [authenticated] → revoke → [revoked]
 *
 * Enforced at compile time:
 * 1. You can't call `exchange` without first calling `authorize`
 * 2. You can't call `exchange` until the session knows `authorize` succeeded
 *    (`session.narrow("authorize", (r) => r.type === "success")`); the same
 *    for `refresh` and `revoke` after `exchange`
 * 3. The shape of each request
 *
 * Enforced at runtime:
 * 4. The `code` in `exchange` must match what `authorize` returned
 * 5. The `when` guard of each step, for callers that bypass the types
 */
export const oauth2AuthCodeProtocol = protocol({
  name: "OAuth2AuthorizationCode",
  description: "OAuth 2.0 Authorization Code Grant (RFC 6749 Section 4.1)",
  initial: "authorize",
  terminal: ["revoke"],
  steps: {
    authorize: authorizeStep,
    exchange: exchangeStep,
    refresh: refreshStep,
    revoke: revokeStep,
  },
});

// =============================================================================
// Type Exports
// =============================================================================

/** Type of the OAuth 2.0 authorization code protocol. */
export type OAuth2Protocol = typeof oauth2AuthCodeProtocol;

/** Request of the `authorize` step. */
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
/** Response of the `authorize` step: success or error variant. */
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;
/** A successful token response. */
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
/** Response of the `exchange` step: success or error variant. */
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;
