/**
 * E2E Tests: Protocol Type Generation with Branded Provenance
 *
 * These tests define what generateProtocolTypes() should produce.
 * They are the RED in red-green: they call a function that doesn't exist yet.
 *
 * The generated types use branded types to enforce at compile time that
 * mapped fields carry the correct provenance — you can't pass a string
 * where a StepOutput<string, "authorize", "code"> is expected.
 *
 * This is the missing piece that makes mappedStep() more than syntax sugar
 * over dependentStep(). Without branded types, both have the same runtime
 * behavior. With them, mappedStep's static data enables compile-time
 * enforcement that dependentStep's opaque function never could.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import { fromStep, mappedStep, protocol, step } from "../src/protocol/index.ts";
import { generateProtocolTypes } from "../src/protocol/typegen.ts";

// =============================================================================
// Test Protocol 1: OAuth2 Authorization Code Flow
//
// Complex because:
// - Discriminated union response (success | error)
// - Cross-step literal forwarding (authorize.code → exchange.code)
// - Chained dependency (exchange.refresh_token → refresh.refresh_token)
// - Terminal step references earlier non-adjacent step (revoke needs exchange.access_token)
// =============================================================================

const AuthorizeResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    code: z.string(),
    state: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    error_description: z.string().optional(),
  }),
]);

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

const oauthProtocol = protocol({
  name: "OAuth2",
  description: "OAuth 2.0 Authorization Code Grant",
  initial: "authorize",
  terminal: ["revoke"],
  steps: {
    authorize: step({
      name: "authorize",
      request: z.object({
        response_type: z.literal("code"),
        client_id: z.string(),
        state: z.string(),
      }),
      response: AuthorizeResponseSchema,
    }),
    exchange: mappedStep({
      name: "exchange",
      dependsOn: "authorize",
      requestMapping: {
        code: fromStep("authorize", "code"),
      },
      requestSchema: z.object({
        code: z.string(),
        grant_type: z.literal("authorization_code"),
        client_id: z.string(),
        client_secret: z.string(),
      }),
      response: TokenResponseSchema,
    }),
    refresh: mappedStep({
      name: "refresh",
      dependsOn: "exchange",
      requestMapping: {
        refresh_token: fromStep("exchange", "refresh_token"),
      },
      requestSchema: z.object({
        refresh_token: z.string(),
        grant_type: z.literal("refresh_token"),
        client_id: z.string(),
      }),
      response: TokenResponseSchema,
    }),
    revoke: mappedStep({
      name: "revoke",
      dependsOn: "exchange",
      requestMapping: {
        token: fromStep("exchange", "access_token"),
      },
      requestSchema: z.object({
        token: z.string(),
      }),
      response: z.object({ revoked: z.boolean() }),
    }),
  },
});

// =============================================================================
// Test Protocol 2: Multi-Stage Data Pipeline
//
// Complex because:
// - Diamond dependency: upload → [validate, scan] → process
// - process maps from THREE different steps (upload, validate, scan)
// - Nested field access: validate produces { result: { checksum: "..." } }
//   and process reads "result.checksum"
// - Non-mapped fields coexist with mapped fields
// =============================================================================

const pipelineProtocol = protocol({
  name: "DataPipeline",
  description: "Multi-stage data processing with diamond dependency",
  initial: "upload",
  terminal: ["process"],
  steps: {
    upload: step({
      name: "upload",
      request: z.object({
        filename: z.string(),
        data: z.string(),
        contentType: z.string(),
      }),
      response: z.object({
        fileId: z.string().uuid(),
        size: z.number(),
        storagePath: z.string(),
      }),
    }),
    validate: mappedStep({
      name: "validate",
      dependsOn: "upload",
      requestMapping: {
        fileId: fromStep("upload", "fileId"),
      },
      requestSchema: z.object({
        fileId: z.string(),
        rules: z.array(z.string()),
      }),
      response: z.object({
        valid: z.boolean(),
        result: z.object({
          checksum: z.string(),
          format: z.string(),
          errors: z.array(z.string()),
        }),
      }),
    }),
    scan: mappedStep({
      name: "scan",
      dependsOn: "upload",
      requestMapping: {
        fileId: fromStep("upload", "fileId"),
        storagePath: fromStep("upload", "storagePath"),
      },
      requestSchema: z.object({
        fileId: z.string(),
        storagePath: z.string(),
        scanProfile: z.enum(["quick", "thorough"]),
      }),
      response: z.object({
        clean: z.boolean(),
        scanId: z.string(),
        threats: z.array(z.object({
          name: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]),
        })),
      }),
    }),
    // Diamond: depends on validate, but maps from upload, validate, AND scan
    process: mappedStep({
      name: "process",
      dependsOn: "validate",
      requestMapping: {
        fileId: fromStep("upload", "fileId"),
        checksum: fromStep("validate", "result.checksum"),
        scanId: fromStep("scan", "scanId"),
      },
      requestSchema: z.object({
        fileId: z.string(),
        checksum: z.string(),
        scanId: z.string(),
        outputFormat: z.enum(["json", "csv", "parquet"]),
        compression: z.boolean(),
      }),
      response: z.object({
        processedFileId: z.string(),
        outputUrl: z.string().url(),
        stats: z.object({
          rowCount: z.number(),
          duration: z.number(),
        }),
      }),
    }),
  },
});

// =============================================================================
// Test Protocol 3: Session with Nested Responses
//
// Complex because:
// - Deep nested field access in mappings
// - Same source step referenced for multiple fields
// - Response type with arrays and optional fields
// =============================================================================

const sessionProtocol = protocol({
  name: "AuthSession",
  description: "Authentication session with nested token structure",
  initial: "login",
  terminal: ["logout"],
  steps: {
    login: step({
      name: "login",
      request: z.object({
        username: z.string(),
        password: z.string(),
      }),
      response: z.object({
        session: z.object({
          id: z.string(),
          tokens: z.object({
            access: z.string(),
            refresh: z.string(),
          }),
          user: z.object({
            id: z.string(),
            roles: z.array(z.string()),
          }),
        }),
      }),
    }),
    refresh: mappedStep({
      name: "refresh",
      dependsOn: "login",
      requestMapping: {
        sessionId: fromStep("login", "session.id"),
        refreshToken: fromStep("login", "session.tokens.refresh"),
      },
      requestSchema: z.object({
        sessionId: z.string(),
        refreshToken: z.string(),
      }),
      response: z.object({
        session: z.object({
          id: z.string(),
          tokens: z.object({
            access: z.string(),
            refresh: z.string(),
          }),
          user: z.object({
            id: z.string(),
            roles: z.array(z.string()),
          }),
        }),
      }),
    }),
    logout: mappedStep({
      name: "logout",
      dependsOn: "login",
      requestMapping: {
        sessionId: fromStep("login", "session.id"),
        accessToken: fromStep("login", "session.tokens.access"),
      },
      requestSchema: z.object({
        sessionId: z.string(),
        accessToken: z.string(),
      }),
      response: z.object({ loggedOut: z.boolean() }),
    }),
  },
});

// =============================================================================
// Tests: Generated Output Structure
// =============================================================================

Deno.test("E2E: generateProtocolTypes produces branded types for OAuth2 flow", () => {
  const output = generateProtocolTypes(oauthProtocol);

  // Should declare the StepOutput brand
  assertContains(output, "StepOutput");

  // authorize response fields should be branded with their provenance
  assertContains(output, '"authorize"');
  assertContains(output, '"code"');

  // exchange request: code field should require authorize.code provenance
  // This is the key assertion — the mapped field references its source
  assertContains(output, 'StepOutput<string, "authorize", "code">');

  // refresh request: refresh_token from exchange
  assertContains(output, 'StepOutput<string, "exchange", "refresh_token">');

  // revoke request: token from exchange.access_token
  assertContains(output, 'StepOutput<string, "exchange", "access_token">');

  // Non-mapped fields should remain plain types
  // grant_type is z.literal("authorization_code") — not branded, just a literal
  assertContains(output, '"authorization_code"');
  // client_id is just string
  assertContains(output, "client_id: string");
});

Deno.test("E2E: generateProtocolTypes handles diamond dependencies in pipeline", () => {
  const output = generateProtocolTypes(pipelineProtocol);

  // process maps from THREE steps: upload, validate, scan
  // fileId from upload
  assertContains(output, 'StepOutput<string, "upload", "fileId">');

  // checksum from validate via nested path "result.checksum"
  assertContains(output, 'StepOutput<string, "validate", "result.checksum">');

  // scanId from scan
  assertContains(output, 'StepOutput<string, "scan", "scanId">');

  // Non-mapped fields in process request
  assertContains(output, 'outputFormat: "json" | "csv" | "parquet"');
  assertContains(output, "compression: boolean");

  // validate's own mapped field
  assertContains(output, 'StepOutput<string, "upload", "fileId">');

  // scan maps two fields from upload
  assertContains(output, 'StepOutput<string, "upload", "storagePath">');
});

Deno.test("E2E: generateProtocolTypes handles deeply nested field paths", () => {
  const output = generateProtocolTypes(sessionProtocol);

  // refresh maps sessionId from "session.id" and refreshToken from "session.tokens.refresh"
  assertContains(output, 'StepOutput<string, "login", "session.id">');
  assertContains(
    output,
    'StepOutput<string, "login", "session.tokens.refresh">',
  );

  // logout maps accessToken from "session.tokens.access"
  assertContains(
    output,
    'StepOutput<string, "login", "session.tokens.access">',
  );
});

Deno.test("E2E: generateProtocolTypes includes all steps as interfaces", () => {
  const output = generateProtocolTypes(oauthProtocol);

  // Each step should have Request and Response interfaces
  assertContains(output, "AuthorizeRequest");
  assertContains(output, "AuthorizeResponse");
  assertContains(output, "ExchangeRequest");
  assertContains(output, "ExchangeResponse");
  assertContains(output, "RefreshRequest");
  assertContains(output, "RefreshResponse");
  assertContains(output, "RevokeRequest");
  assertContains(output, "RevokeResponse");
});

Deno.test("E2E: generateProtocolTypes preserves response structure with brands", () => {
  const output = generateProtocolTypes(pipelineProtocol);

  // upload response: all fields should be branded (they're outputs that other steps reference)
  assertContains(output, 'StepOutput<string, "upload", "fileId">');
  assertContains(output, 'StepOutput<string, "upload", "storagePath">');

  // validate response has nested structure — the nested fields that are
  // referenced by mappings should be branded
  assertContains(
    output,
    'StepOutput<string, "validate", "result.checksum">',
  );
});

Deno.test("E2E: generateProtocolTypes includes protocol metadata", () => {
  const output = generateProtocolTypes(oauthProtocol);

  // Protocol name in header/comment
  assertContains(output, "OAuth2");

  // Should not be empty
  assertEquals(output.length > 0, true);
});

// =============================================================================
// Tests: Generated Output is Valid TypeScript
// =============================================================================

Deno.test("E2E: generateProtocolTypes output compiles as valid TypeScript", async () => {
  const output = generateProtocolTypes(oauthProtocol);

  // Write to temp file and type-check it
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, output);
    const cmd = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const errorText = new TextDecoder().decode(stderr);
    assertEquals(
      code,
      0,
      `Generated types should compile without errors:\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("E2E: generateProtocolTypes output enforces provenance at compile time", async () => {
  // Generate types for the OAuth protocol
  const types = generateProtocolTypes(oauthProtocol);

  // Write a test file that imports the generated types and tries correct
  // and incorrect usage. The incorrect usages should be @ts-expect-error.
  const testCode = `
${types}

// --- Correct usage: pass branded value from the right step+field ---
declare const authorizeResponse: AuthorizeResponse;
declare const exchangeResponse: ExchangeResponse;

// This should work: exchange.code comes from authorize.code
const goodExchangeReq: ExchangeRequest = {
  code: (authorizeResponse as { type: "success"; code: AuthorizeResponse extends { code: infer C } ? C : never; state: unknown }).code,
  grant_type: "authorization_code" as const,
  client_id: "app",
  client_secret: "secret",
};

// --- Incorrect usage: plain string where branded is required ---
const badExchangeReq1: ExchangeRequest = {
  // @ts-expect-error — plain string has no provenance brand
  code: "hardcoded-string",
  grant_type: "authorization_code" as const,
  client_id: "app",
  client_secret: "secret",
};

// --- Incorrect usage: wrong step's output ---
const badExchangeReq2: ExchangeRequest = {
  // @ts-expect-error — exchange.access_token is not authorize.code
  code: exchangeResponse.access_token,
  grant_type: "authorization_code" as const,
  client_id: "app",
  client_secret: "secret",
};

// Suppress unused variable warnings
void goodExchangeReq;
void badExchangeReq1;
void badExchangeReq2;
`;

  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, testCode);
    const cmd = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const errorText = new TextDecoder().decode(stderr);
    assertEquals(
      code,
      0,
      `Provenance test should compile (with @ts-expect-error for bad cases):\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("E2E: generateProtocolTypes pipeline output enforces cross-step provenance", async () => {
  const types = generateProtocolTypes(pipelineProtocol);

  // In the pipeline, process.checksum must come from validate.result.checksum
  // and process.scanId must come from scan.scanId — not interchangeable
  const testCode = `
${types}

declare const uploadResp: UploadResponse;
declare const validateResp: ValidateResponse;
declare const scanResp: ScanResponse;

// Correct: each field from its declared source
const goodReq: ProcessRequest = {
  fileId: uploadResp.fileId,
  checksum: validateResp.result.checksum,
  scanId: scanResp.scanId,
  outputFormat: "json" as const,
  compression: true,
};

const badChecksum: ProcessRequest = {
  fileId: uploadResp.fileId,
  // @ts-expect-error — checksum should come from validate, not a plain string
  checksum: "plain-string",
  scanId: scanResp.scanId,
  outputFormat: "json" as const,
  compression: true,
};

const badSwap: ProcessRequest = {
  fileId: uploadResp.fileId,
  checksum: validateResp.result.checksum,
  // @ts-expect-error — scanId from upload.fileId has wrong provenance
  scanId: uploadResp.fileId,
  outputFormat: "json" as const,
  compression: true,
};

void goodReq;
void badChecksum;
void badSwap;
`;

  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, testCode);
    const cmd = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const errorText = new TextDecoder().decode(stderr);
    assertEquals(
      code,
      0,
      `Pipeline provenance test should compile:\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

// =============================================================================
// Helpers
// =============================================================================

function assertContains(haystack: string, needle: string): void {
  assertEquals(
    haystack.includes(needle),
    true,
    `Expected output to contain "${needle}".\n\nActual output:\n${haystack}`,
  );
}
