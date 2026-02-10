/**
 * End-to-end Protocol Tests
 *
 * Tests the full protocol workflow:
 * - Define protocol with steps and dependencies
 * - Execute protocol session with type-safe step execution
 * - Generate x-protocol OpenAPI extension
 * - Integrate with HTTP handlers
 */

import { assertEquals, assertRejects } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";

import {
  createMockExecutor,
  createSession,
  dependentStep,
  fromStep,
  mappedStep,
  oauth2AuthCodeProtocol,
  protocol,
  protocolToOpenApi,
  step,
} from "../src/protocol/index.ts";

// =============================================================================
// Test: Complete Protocol Workflow
// =============================================================================

/**
 * Define a file upload protocol:
 * 1. initiate - Start upload, get upload URL
 * 2. upload - Upload file parts (can repeat)
 * 3. complete - Finalize upload
 */
const fileUploadProtocol = protocol({
  name: "FileUpload",
  description: "Multi-part file upload protocol",
  initial: "initiate",
  terminal: ["complete", "abort"],
  steps: {
    initiate: step({
      name: "initiate",
      description: "Initialize file upload",
      request: z.object({
        filename: z.string(),
        size: z.number().int().positive(),
        contentType: z.string(),
      }),
      response: z.object({
        uploadId: z.string().uuid(),
        partSize: z.number(),
        totalParts: z.number(),
      }),
    }),
    upload: dependentStep({
      name: "upload",
      dependsOn: "initiate",
      description: "Upload a file part",
      request: (prev: { uploadId: string; totalParts: number }) =>
        z.object({
          uploadId: z.literal(prev.uploadId),
          partNumber: z.number().int().min(1).max(prev.totalParts),
          data: z.string(), // base64 encoded
        }),
      response: z.object({
        partNumber: z.number(),
        etag: z.string(),
      }),
    }),
    complete: dependentStep({
      name: "complete",
      dependsOn: "initiate",
      description: "Complete the upload",
      request: (prev: { uploadId: string }) =>
        z.object({
          uploadId: z.literal(prev.uploadId),
          parts: z.array(
            z.object({
              partNumber: z.number(),
              etag: z.string(),
            }),
          ),
        }),
      response: z.object({
        fileId: z.string(),
        url: z.string().url(),
      }),
    }),
    abort: dependentStep({
      name: "abort",
      dependsOn: "initiate",
      description: "Abort the upload",
      request: (prev: { uploadId: string }) =>
        z.object({
          uploadId: z.literal(prev.uploadId),
        }),
      response: z.object({
        aborted: z.literal(true),
      }),
    }),
  },
});

// =============================================================================
// Protocol Session Tests
// =============================================================================

Deno.test("E2E: File upload protocol - complete flow", async () => {
  const executor = createMockExecutor(fileUploadProtocol, {
    initiate: {
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
      partSize: 5 * 1024 * 1024,
      totalParts: 3,
    },
    upload: (req: { partNumber: number }) => ({
      partNumber: req.partNumber,
      etag: `etag-${req.partNumber}`,
    }),
    complete: {
      fileId: "file-123",
      url: "https://cdn.example.com/files/file-123",
    },
  });

  const session = createSession(fileUploadProtocol, executor);

  // Step 1: Initiate
  assertEquals(session.canExecute("initiate"), true);
  assertEquals(session.canExecute("upload"), false);
  assertEquals(session.canExecute("complete"), false);

  const { response: initResponse, session: s1 } = await session.execute(
    "initiate",
    {
      filename: "large-file.zip",
      size: 15 * 1024 * 1024,
      contentType: "application/zip",
    },
  );

  assertEquals(initResponse.uploadId, "550e8400-e29b-41d4-a716-446655440000");
  assertEquals(initResponse.totalParts, 3);

  // After initiate, upload and complete are available
  assertEquals(s1.canExecute("upload"), true);
  assertEquals(s1.canExecute("complete"), true);

  // Step 2: Upload parts (multiple times)
  const { response: part1, session: s2 } = await s1.execute("upload", {
    uploadId: initResponse.uploadId,
    partNumber: 1,
    data: "base64-data-part-1",
  });
  assertEquals(part1.etag, "etag-1");

  const { response: part2, session: s3 } = await s2.execute("upload", {
    uploadId: initResponse.uploadId,
    partNumber: 2,
    data: "base64-data-part-2",
  });
  assertEquals(part2.etag, "etag-2");

  const { response: part3, session: s4 } = await s3.execute("upload", {
    uploadId: initResponse.uploadId,
    partNumber: 3,
    data: "base64-data-part-3",
  });
  assertEquals(part3.etag, "etag-3");

  // Step 3: Complete
  const { response: completeResponse, session: finalSession } = await s4
    .execute("complete", {
      uploadId: initResponse.uploadId,
      parts: [
        { partNumber: 1, etag: part1.etag },
        { partNumber: 2, etag: part2.etag },
        { partNumber: 3, etag: part3.etag },
      ],
    });

  assertEquals(completeResponse.fileId, "file-123");
  assertEquals(finalSession.isTerminal(), true);

  // Verify session history
  assertEquals(finalSession.history, [
    "initiate",
    "upload",
    "upload",
    "upload",
    "complete",
  ]);
});

Deno.test("E2E: File upload protocol - abort flow", async () => {
  const executor = createMockExecutor(fileUploadProtocol, {
    initiate: {
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
      partSize: 5 * 1024 * 1024,
      totalParts: 3,
    },
    abort: { aborted: true },
  });

  const session = createSession(fileUploadProtocol, executor);

  const { response: initResponse, session: s1 } = await session.execute(
    "initiate",
    {
      filename: "file.zip",
      size: 15 * 1024 * 1024,
      contentType: "application/zip",
    },
  );

  // Abort without uploading any parts
  const { response: abortResponse, session: finalSession } = await s1.execute(
    "abort",
    {
      uploadId: initResponse.uploadId,
    },
  );

  assertEquals(abortResponse.aborted, true);
  assertEquals(finalSession.isTerminal(), true);
  assertEquals(finalSession.history, ["initiate", "abort"]);
});

Deno.test("E2E: Protocol enforces uploadId literal type", async () => {
  const correctUploadId = "550e8400-e29b-41d4-a716-446655440000";
  const executor = createMockExecutor(fileUploadProtocol, {
    initiate: {
      uploadId: correctUploadId,
      partSize: 1024,
      totalParts: 1,
    },
  });

  const session = createSession(fileUploadProtocol, executor);
  const { session: s1 } = await session.execute("initiate", {
    filename: "file.txt",
    size: 1024,
    contentType: "text/plain",
  });

  // Should fail with wrong uploadId
  await assertRejects(
    async () => {
      await s1.execute("upload", {
        uploadId: "660e8400-e29b-41d4-a716-446655440000", // different UUID
        partNumber: 1,
        data: "data",
      });
    },
    Error,
    "Invalid request",
  );
});

// =============================================================================
// OAuth Protocol Tests
// =============================================================================

Deno.test("E2E: OAuth protocol - full authorization code flow", async () => {
  const executor = createMockExecutor(oauth2AuthCodeProtocol, {
    authorize: {
      type: "success",
      code: "auth-code-xyz",
      state: "random-state",
    },
    exchange: {
      type: "success",
      access_token: "access-token-abc",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-token-def",
    },
    refresh: {
      type: "success",
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    },
  });

  const session = createSession(oauth2AuthCodeProtocol, executor);

  // Authorize
  const { response: authResponse, session: s1 } = await session.execute(
    "authorize",
    {
      response_type: "code",
      client_id: "my-app",
      state: "random-state",
    },
  );

  assertEquals(authResponse.type, "success");
  if (authResponse.type === "success") {
    assertEquals(authResponse.code, "auth-code-xyz");
  }

  // Exchange
  const { response: tokenResponse, session: s2 } = await s1.execute(
    "exchange",
    {
      grant_type: "authorization_code",
      code: "auth-code-xyz",
      client_id: "my-app",
      client_secret: "secret",
    },
  );

  assertEquals(tokenResponse.type, "success");
  if (tokenResponse.type === "success") {
    assertEquals(tokenResponse.access_token, "access-token-abc");
  }

  // Refresh
  const { response: refreshResponse } = await s2.execute("refresh", {
    grant_type: "refresh_token",
    refresh_token: "refresh-token-def",
    client_id: "my-app",
  });

  assertEquals(refreshResponse.type, "success");
  if (refreshResponse.type === "success") {
    assertEquals(refreshResponse.access_token, "new-access-token");
  }
});

// =============================================================================
// OpenAPI Extension Tests
// =============================================================================

Deno.test("E2E: Protocol to OpenAPI - file upload protocol", async (t) => {
  const xProtocol = protocolToOpenApi(fileUploadProtocol);
  await assertSnapshot(t, xProtocol);
});

Deno.test("E2E: Protocol to OpenAPI - OAuth protocol", async (t) => {
  const xProtocol = protocolToOpenApi(oauth2AuthCodeProtocol);
  await assertSnapshot(t, xProtocol);
});

Deno.test("E2E: OpenAPI spec integration", () => {
  // Simulate adding protocol to an OpenAPI spec
  const baseSpec = {
    openapi: "3.1.0",
    info: {
      title: "File Storage API",
      version: "1.0.0",
    },
    paths: {
      "/uploads": {
        post: {
          summary: "Initiate upload",
          operationId: "initiate",
        },
      },
      "/uploads/{uploadId}/parts": {
        put: {
          summary: "Upload part",
          operationId: "upload",
        },
      },
      "/uploads/{uploadId}/complete": {
        post: {
          summary: "Complete upload",
          operationId: "complete",
        },
      },
    },
  };

  const xProtocol = protocolToOpenApi(fileUploadProtocol);

  const fullSpec = {
    ...baseSpec,
    "x-protocol": xProtocol,
  };

  // Verify structure
  assertEquals(fullSpec["x-protocol"].name, "FileUpload");
  assertEquals(fullSpec["x-protocol"].initial, "initiate");
  assertEquals(fullSpec["x-protocol"].terminal, ["complete", "abort"]);

  // Verify step transitions
  const initiateStep = fullSpec["x-protocol"].steps.find(
    (s) => s.name === "initiate",
  );
  assertEquals([...(initiateStep?.next ?? [])].sort(), [
    "abort",
    "complete",
    "upload",
  ]);

  const uploadStep = fullSpec["x-protocol"].steps.find(
    (s) => s.name === "upload",
  );
  assertEquals(uploadStep?.dependsOn, "initiate");
});

// =============================================================================
// Session State Accumulation Tests
// =============================================================================

Deno.test("E2E: Session responses are typed and accumulated", async () => {
  const testUploadId = "770e8400-e29b-41d4-a716-446655440000";
  const executor = createMockExecutor(fileUploadProtocol, {
    initiate: {
      uploadId: testUploadId,
      partSize: 1024,
      totalParts: 2,
    },
    upload: (req: { partNumber: number }) => ({
      partNumber: req.partNumber,
      etag: `etag-${req.partNumber}`,
    }),
    complete: {
      fileId: "file-456",
      url: "https://example.com/file-456",
    },
  });

  const session = createSession(fileUploadProtocol, executor);
  const { session: s1 } = await session.execute("initiate", {
    filename: "test.txt",
    size: 2048,
    contentType: "text/plain",
  });

  // Access typed responses
  assertEquals(s1.responses.initiate.uploadId, testUploadId);
  assertEquals(s1.responses.initiate.totalParts, 2);

  const { session: s2 } = await s1.execute("upload", {
    uploadId: testUploadId,
    partNumber: 1,
    data: "data1",
  });

  // Both responses are available and typed
  assertEquals(s2.responses.initiate.uploadId, testUploadId);
  assertEquals(s2.responses.upload.etag, "etag-1");
});

// =============================================================================
// Mapped Step E2E Tests
// =============================================================================

/**
 * File upload protocol rewritten with mappedStep for the complete step.
 * Upload still uses dependentStep (needs .max(prev.totalParts) — Pattern 2).
 */
const fileUploadMappedProtocol = protocol({
  name: "FileUploadMapped",
  description: "Multi-part file upload protocol using mapped steps",
  initial: "initiate",
  terminal: ["complete", "abort"],
  steps: {
    initiate: step({
      name: "initiate",
      description: "Initialize file upload",
      request: z.object({
        filename: z.string(),
        size: z.number().int().positive(),
        contentType: z.string(),
      }),
      response: z.object({
        uploadId: z.string().uuid(),
        partSize: z.number(),
        totalParts: z.number(),
      }),
    }),
    // dependentStep: needs .max(prev.totalParts) — can't be declarative
    upload: dependentStep({
      name: "upload",
      dependsOn: "initiate",
      description: "Upload a file part",
      request: (prev: { uploadId: string; totalParts: number }) =>
        z.object({
          uploadId: z.literal(prev.uploadId),
          partNumber: z.number().int().min(1).max(prev.totalParts),
          data: z.string(),
        }),
      response: z.object({
        partNumber: z.number(),
        etag: z.string(),
      }),
    }),
    // mappedStep: only literal forwarding
    complete: mappedStep({
      name: "complete",
      dependsOn: "initiate",
      description: "Complete the upload",
      requestMapping: {
        uploadId: fromStep("initiate", "uploadId"),
      },
      requestSchema: z.object({
        uploadId: z.string(),
        parts: z.array(
          z.object({
            partNumber: z.number(),
            etag: z.string(),
          }),
        ),
      }),
      response: z.object({
        fileId: z.string(),
        url: z.string().url(),
      }),
    }),
    // mappedStep: only literal forwarding
    abort: mappedStep({
      name: "abort",
      dependsOn: "initiate",
      description: "Abort the upload",
      requestMapping: {
        uploadId: fromStep("initiate", "uploadId"),
      },
      requestSchema: z.object({
        uploadId: z.string(),
      }),
      response: z.object({
        aborted: z.literal(true),
      }),
    }),
  },
});

Deno.test("E2E: Mapped file upload protocol - complete flow", async () => {
  const executor = createMockExecutor(fileUploadMappedProtocol, {
    initiate: {
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
      partSize: 5 * 1024 * 1024,
      totalParts: 2,
    },
    upload: (req: { partNumber: number }) => ({
      partNumber: req.partNumber,
      etag: `etag-${req.partNumber}`,
    }),
    complete: {
      fileId: "file-mapped",
      url: "https://cdn.example.com/files/file-mapped",
    },
  });

  const session = createSession(fileUploadMappedProtocol, executor);

  const { response: initResponse, session: s1 } = await session.execute(
    "initiate",
    {
      filename: "mapped.zip",
      size: 10 * 1024 * 1024,
      contentType: "application/zip",
    },
  );

  assertEquals(initResponse.uploadId, "550e8400-e29b-41d4-a716-446655440000");

  // Upload parts (dependentStep)
  const { response: part1, session: s2 } = await s1.execute("upload", {
    uploadId: initResponse.uploadId,
    partNumber: 1,
    data: "part-1-data",
  });

  const { response: part2, session: s3 } = await s2.execute("upload", {
    uploadId: initResponse.uploadId,
    partNumber: 2,
    data: "part-2-data",
  });

  // Complete (mappedStep) — uploadId enforced via literal
  const { response: completeResponse, session: finalSession } = await s3
    .execute("complete", {
      uploadId: initResponse.uploadId,
      parts: [
        { partNumber: 1, etag: part1.etag },
        { partNumber: 2, etag: part2.etag },
      ],
    });

  assertEquals(completeResponse.fileId, "file-mapped");
  assertEquals(finalSession.isTerminal(), true);
});

Deno.test("E2E: Mapped file upload - wrong uploadId rejected", async () => {
  const executor = createMockExecutor(fileUploadMappedProtocol, {
    initiate: {
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
      partSize: 1024,
      totalParts: 1,
    },
  });

  const session = createSession(fileUploadMappedProtocol, executor);
  const { session: s1 } = await session.execute("initiate", {
    filename: "test.txt",
    size: 1024,
    contentType: "text/plain",
  });

  await assertRejects(
    async () => {
      await s1.execute("complete", {
        uploadId: "wrong-uuid",
        parts: [],
      });
    },
    Error,
    "Invalid request",
  );
});

Deno.test("E2E: Mapped file upload - abort with literal enforcement", async () => {
  const executor = createMockExecutor(fileUploadMappedProtocol, {
    initiate: {
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
      partSize: 1024,
      totalParts: 1,
    },
    abort: { aborted: true },
  });

  const session = createSession(fileUploadMappedProtocol, executor);
  const { response: initResponse, session: s1 } = await session.execute(
    "initiate",
    {
      filename: "abort.txt",
      size: 1024,
      contentType: "text/plain",
    },
  );

  const { response: abortResponse, session: finalSession } = await s1.execute(
    "abort",
    { uploadId: initResponse.uploadId },
  );

  assertEquals(abortResponse.aborted, true);
  assertEquals(finalSession.isTerminal(), true);
});

Deno.test("E2E: Mapped protocol OpenAPI generation", () => {
  const xProtocol = protocolToOpenApi(fileUploadMappedProtocol);

  assertEquals(xProtocol.name, "FileUploadMapped");
  assertEquals(xProtocol.initial, "initiate");
  assertEquals(xProtocol.terminal, ["complete", "abort"]);

  const completeStep = xProtocol.steps.find((s) => s.name === "complete");
  assertEquals(completeStep?.dependsOn, "initiate");

  const abortStep = xProtocol.steps.find((s) => s.name === "abort");
  assertEquals(abortStep?.dependsOn, "initiate");
});
