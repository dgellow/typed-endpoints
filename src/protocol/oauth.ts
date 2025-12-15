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
  error_uri: z.string().url().optional(),
  state: z.string().optional(),
});

/** Authorization Request (Step 1) */
export const AuthorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string().url().optional(),
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
  z.object({ type: z.literal("success") }).merge(AuthorizeSuccessSchema),
  z.object({ type: z.literal("error") }).merge(OAuthErrorSchema),
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
  error_uri: z.string().url().optional(),
});

/** Token Exchange Response - discriminated union */
export const ExchangeResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }).merge(TokenResponseSchema),
  z.object({ type: z.literal("error") }).merge(TokenErrorSchema),
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
 */
export const exchangeStep = dependentStep({
  name: "exchange",
  dependsOn: "authorize",
  description: "Exchange authorization code for access token",
  request: (
    prev: z.infer<typeof AuthorizeResponseSchema>,
  ) => {
    // Only valid if authorize succeeded
    if (prev.type !== "success") {
      // Return a schema that will never validate (protocol violation)
      return z.never();
    }
    return z.object({
      grant_type: z.literal("authorization_code"),
      code: z.literal(prev.code), // THE KEY: code comes from authorize response
      redirect_uri: z.string().url().optional(),
      client_id: z.string(),
      client_secret: z.string(),
    });
  },
  response: ExchangeResponseSchema,
});

/**
 * Step 3: Token Refresh
 *
 * Client uses refresh token to get new access token.
 * Can be called multiple times (Kleene star pattern).
 */
export const refreshStep = dependentStep({
  name: "refresh",
  dependsOn: "exchange",
  description: "Refresh access token using refresh token",
  request: (prev: z.infer<typeof ExchangeResponseSchema>) => {
    if (prev.type !== "success" || !prev.refresh_token) {
      return z.never();
    }
    return z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.literal(prev.refresh_token), // From exchange response
      client_id: z.string(),
      client_secret: z.string().optional(),
      scope: z.string().optional(),
    });
  },
  response: ExchangeResponseSchema,
});

/**
 * Step 4: Token Revocation
 *
 * Client revokes access or refresh token.
 */
export const revokeStep = dependentStep({
  name: "revoke",
  dependsOn: "exchange",
  description: "Revoke access or refresh token",
  request: (prev: z.infer<typeof ExchangeResponseSchema>) => {
    if (prev.type !== "success") {
      return z.never();
    }
    return z.object({
      token: z.string(), // access_token or refresh_token
      token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      client_id: z.string(),
      client_secret: z.string().optional(),
    });
  },
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
 * The type system enforces:
 * 1. You can't call `exchange` without first calling `authorize`
 * 2. The `code` in `exchange` must match what `authorize` returned
 * 3. You can't `refresh` without a valid `refresh_token` from `exchange`
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

export type OAuth2Protocol = typeof oauth2AuthCodeProtocol;

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;

// =============================================================================
// Example Usage (commented out - for documentation)
// =============================================================================

/*
// How you would use this protocol with a type-safe client:

const client = createProtocolClient(oauth2AuthCodeProtocol);

// Step 1: Start authorization
const authResult = await client.authorize({
  response_type: "code",
  client_id: "my-client",
  redirect_uri: "https://myapp.com/callback",
  scope: "read write",
  state: "random-state-string",
});

if (authResult.type === "error") {
  console.error("Auth failed:", authResult.error);
  return;
}

// Step 2: Exchange code for tokens
// TypeScript KNOWS authResult.code exists here because type narrowed
const tokens = await client.exchange({
  grant_type: "authorization_code",
  code: authResult.code,  // <-- This is type-safe!
  client_id: "my-client",
  client_secret: "my-secret",
});

if (tokens.type === "error") {
  console.error("Exchange failed:", tokens.error);
  return;
}

// Step 3: Later, refresh the token
const newTokens = await client.refresh({
  grant_type: "refresh_token",
  refresh_token: tokens.refresh_token!,  // <-- Type-safe!
  client_id: "my-client",
});
*/
