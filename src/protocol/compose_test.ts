import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { createApiHandlers, endpoint } from "../adapters/fresh.ts";
import { fromEndpoint, fromEndpointDependent } from "./compose.ts";

// =============================================================================
// fromEndpoint Tests
// =============================================================================

Deno.test("fromEndpoint extracts schemas from endpoint with body", () => {
  const handler = createApiHandlers({
    POST: endpoint({
      body: z.object({ username: z.string(), password: z.string() }),
      response: z.object({ token: z.string() }),
      handler: () => Response.json({ token: "test" }),
    }),
  });

  const step = fromEndpoint(handler, "POST", { name: "login" });

  assertEquals(step.__kind, "step");
  assertEquals(step.name, "login");
  assertEquals(step.operationId, "login");

  // Verify request schema works
  const validResult = step.request.safeParse({
    username: "alice",
    password: "secret",
  });
  assertEquals(validResult.success, true);

  // Verify invalid request fails
  const invalidResult = step.request.safeParse({ username: "alice" });
  assertEquals(invalidResult.success, false);

  // Verify response schema works
  const responseResult = step.response.safeParse({ token: "abc" });
  assertEquals(responseResult.success, true);
});

Deno.test("fromEndpoint merges body + params + query into single schema", () => {
  const handler = createApiHandlers({
    PUT: endpoint({
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string() }),
      query: z.object({ version: z.number().optional() }),
      response: z.object({ success: z.boolean() }),
      handler: () => Response.json({ success: true }),
    }),
  });

  const step = fromEndpoint(handler, "PUT", { name: "update" });

  // Merged schema should accept all fields
  const result = step.request.safeParse({
    id: "123",
    name: "test",
    version: 1,
  });
  assertEquals(result.success, true);

  // Should also work without optional field
  const withoutOptional = step.request.safeParse({ id: "123", name: "test" });
  assertEquals(withoutOptional.success, true);

  // Should fail without required fields
  const missingRequired = step.request.safeParse({ id: "123" });
  assertEquals(missingRequired.success, false);
});

Deno.test("fromEndpoint uses name from options", () => {
  const handler = createApiHandlers({
    GET: endpoint({
      response: z.object({ items: z.array(z.string()) }),
      handler: () => Response.json({ items: [] }),
    }),
  });

  const step = fromEndpoint(handler, "GET", { name: "listItems" });

  assertEquals(step.name, "listItems");
  assertEquals(step.operationId, "listItems");
});

Deno.test("fromEndpoint inherits operationId from endpoint", () => {
  const handler = createApiHandlers({
    POST: endpoint({
      operationId: "createUser",
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.string() }),
      handler: () => Response.json({ id: "1" }),
    }),
  });

  const step = fromEndpoint(handler, "POST", { name: "create" });

  assertEquals(step.name, "create");
  assertEquals(step.operationId, "createUser");
});

Deno.test("fromEndpoint allows operationId override", () => {
  const handler = createApiHandlers({
    POST: endpoint({
      operationId: "originalId",
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.string() }),
      handler: () => Response.json({ id: "1" }),
    }),
  });

  const step = fromEndpoint(handler, "POST", {
    name: "create",
    operationId: "overrideId",
  });

  assertEquals(step.operationId, "overrideId");
});

Deno.test("fromEndpoint handles endpoint with only response", () => {
  const handler = createApiHandlers({
    GET: endpoint({
      response: z.object({ status: z.string() }),
      handler: () => Response.json({ status: "ok" }),
    }),
  });

  const step = fromEndpoint(handler, "GET", { name: "health" });

  // Request schema should be empty object
  const result = step.request.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("fromEndpoint throws for missing method", () => {
  const handler = createApiHandlers({
    GET: endpoint({
      response: z.object({ status: z.string() }),
      handler: () => Response.json({ status: "ok" }),
    }),
  });

  assertThrows(
    () => fromEndpoint(handler, "POST", { name: "missing" }),
    Error,
    "No POST definition found in handler",
  );
});

// =============================================================================
// fromEndpointDependent Tests
// =============================================================================

Deno.test("fromEndpointDependent creates dependent step", () => {
  const refreshHandler = createApiHandlers({
    POST: endpoint({
      body: z.object({ refreshToken: z.string() }),
      response: z.object({ accessToken: z.string() }),
      handler: () => Response.json({ accessToken: "new-token" }),
    }),
  });

  const step = fromEndpointDependent(refreshHandler, "POST", {
    name: "refresh",
    dependsOn: "login",
    request: (prev: { refreshToken: string }) =>
      z.object({ refreshToken: z.literal(prev.refreshToken) }),
  });

  assertEquals(step.__kind, "dependent_step");
  assertEquals(step.name, "refresh");
  assertEquals(step.dependsOn, "login");
  assertEquals(step.operationId, "refresh");

  // Request is a function that returns schema
  const schema = step.request({ refreshToken: "abc123" });

  // Correct token validates
  const validResult = schema.safeParse({ refreshToken: "abc123" });
  assertEquals(validResult.success, true);

  // Wrong token fails (z.literal enforces exact match)
  const invalidResult = schema.safeParse({ refreshToken: "wrong" });
  assertEquals(invalidResult.success, false);
});

Deno.test("fromEndpointDependent inherits response from endpoint", () => {
  const handler = createApiHandlers({
    POST: endpoint({
      body: z.object({ token: z.string() }),
      response: z.object({
        newToken: z.string(),
        expiresIn: z.number(),
      }),
      handler: () => Response.json({ newToken: "abc", expiresIn: 3600 }),
    }),
  });

  const step = fromEndpointDependent(handler, "POST", {
    name: "refresh",
    dependsOn: "login",
    request: (prev: { oldToken: string }) =>
      z.object({ token: z.literal(prev.oldToken) }),
  });

  // Response schema comes from endpoint
  const result = step.response.safeParse({ newToken: "xyz", expiresIn: 7200 });
  assertEquals(result.success, true);
});

Deno.test("fromEndpointDependent inherits operationId from endpoint", () => {
  const handler = createApiHandlers({
    POST: endpoint({
      operationId: "refreshToken",
      body: z.object({ token: z.string() }),
      response: z.object({ token: z.string() }),
      handler: () => Response.json({ token: "new" }),
    }),
  });

  const step = fromEndpointDependent(handler, "POST", {
    name: "refresh",
    dependsOn: "login",
    request: (prev: { token: string }) =>
      z.object({ token: z.literal(prev.token) }),
  });

  assertEquals(step.operationId, "refreshToken");
});

Deno.test("fromEndpointDependent throws for missing method", () => {
  const handler = createApiHandlers({
    GET: endpoint({
      response: z.object({ status: z.string() }),
      handler: () => Response.json({ status: "ok" }),
    }),
  });

  assertThrows(
    () =>
      fromEndpointDependent(handler, "POST", {
        name: "test",
        dependsOn: "prev",
        request: () => z.object({}),
      }),
    Error,
    "No POST definition found in handler",
  );
});

// =============================================================================
// Integration Test
// =============================================================================

Deno.test("fromEndpoint and fromEndpointDependent work together in protocol", async () => {
  // Simulate login endpoint
  const loginHandler = createApiHandlers({
    POST: endpoint({
      operationId: "login",
      body: z.object({ username: z.string(), password: z.string() }),
      response: z.object({
        accessToken: z.string(),
        refreshToken: z.string(),
      }),
      handler: () =>
        Response.json({ accessToken: "access", refreshToken: "refresh" }),
    }),
  });

  // Simulate refresh endpoint
  const refreshHandler = createApiHandlers({
    POST: endpoint({
      operationId: "refresh",
      body: z.object({ refreshToken: z.string() }),
      response: z.object({ accessToken: z.string() }),
      handler: () => Response.json({ accessToken: "new-access" }),
    }),
  });

  // Create steps using composition
  const loginStep = fromEndpoint(loginHandler, "POST", { name: "login" });
  const refreshStep = fromEndpointDependent(refreshHandler, "POST", {
    name: "refresh",
    dependsOn: "login",
    request: (prev: { accessToken: string; refreshToken: string }) =>
      z.object({
        refreshToken: z.literal(prev.refreshToken),
      }),
  });

  // Verify login step
  assertEquals(loginStep.name, "login");
  assertEquals(loginStep.operationId, "login");

  const loginReq = loginStep.request.safeParse({
    username: "alice",
    password: "secret",
  });
  assertEquals(loginReq.success, true);

  // Simulate login response
  const loginResponse = { accessToken: "access-123", refreshToken: "refresh-456" };

  // Verify refresh step with login response
  assertEquals(refreshStep.name, "refresh");
  assertEquals(refreshStep.dependsOn, "login");

  const refreshSchema = refreshStep.request(loginResponse);
  const refreshReq = refreshSchema.safeParse({ refreshToken: "refresh-456" });
  assertEquals(refreshReq.success, true);

  // Wrong refresh token should fail
  const wrongRefresh = refreshSchema.safeParse({ refreshToken: "wrong" });
  assertEquals(wrongRefresh.success, false);
});
