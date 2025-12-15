/**
 * End-to-end Protocol Server Test
 *
 * Complete integration test demonstrating:
 * 1. Protocol definition with dependent steps
 * 2. HTTP handlers implementing the protocol
 * 3. OpenAPI spec generation with x-protocol extension
 * 4. Typed client consuming the API
 * 5. Full request/response validation
 */

import { assertEquals, assertExists } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/adapters/fresh.ts";
import { createClient } from "../src/client/index.ts";
import {
  addProtocolToSpec,
  createSession,
  dependentStep,
  protocol,
  protocolToOpenApi,
  step,
  type StepExecutor,
} from "../src/protocol/index.ts";

// =============================================================================
// Protocol Definition
// =============================================================================

/**
 * Simple OAuth-like protocol for testing.
 * Simplified from full OAuth to focus on the multi-step flow.
 */
const authProtocol = protocol({
  name: "SimpleAuth",
  description: "Simplified authentication protocol",
  initial: "login",
  terminal: ["logout"],
  steps: {
    login: step({
      name: "login",
      description: "Authenticate with credentials",
      request: z.object({
        username: z.string().min(1),
        password: z.string().min(1),
      }),
      response: z.discriminatedUnion("success", [
        z.object({
          success: z.literal(true),
          sessionId: z.string(),
          expiresAt: z.number(),
        }),
        z.object({
          success: z.literal(false),
          error: z.string(),
        }),
      ]),
    }),
    refresh: dependentStep({
      name: "refresh",
      dependsOn: "login",
      description: "Refresh session",
      request: (
        prev: { success: true; sessionId: string } | { success: false },
      ) => {
        if (!prev.success) return z.never();
        return z.object({
          sessionId: z.literal(prev.sessionId),
        });
      },
      response: z.object({
        sessionId: z.string(),
        expiresAt: z.number(),
      }),
    }),
    logout: dependentStep({
      name: "logout",
      dependsOn: "login",
      description: "End session",
      request: (
        prev: { success: true; sessionId: string } | { success: false },
      ) => {
        if (!prev.success) return z.never();
        return z.object({
          sessionId: z.literal(prev.sessionId),
        });
      },
      response: z.object({
        loggedOut: z.literal(true),
      }),
    }),
  },
});

// =============================================================================
// In-Memory Session Store (simulates a database)
// =============================================================================

interface Session {
  id: string;
  username: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function generateSessionId(): string {
  return crypto.randomUUID();
}

// =============================================================================
// HTTP Handlers Implementing the Protocol
// =============================================================================

const loginHandler = createApiHandlers({
  POST: endpoint({
    summary: "Login",
    description: "Authenticate with username and password",
    body: z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }),
    response: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(true),
        sessionId: z.string(),
        expiresAt: z.number(),
      }),
      z.object({
        success: z.literal(false),
        error: z.string(),
      }),
    ]),
    public: true,
    handler: (_ctx, { body }) => {
      // Simple auth: accept any username/password except "invalid"
      if (body.username === "invalid" || body.password === "invalid") {
        return Response.json({
          success: false,
          error: "Invalid credentials",
        });
      }

      const sessionId = generateSessionId();
      const expiresAt = Date.now() + 3600 * 1000; // 1 hour

      sessions.set(sessionId, {
        id: sessionId,
        username: body.username,
        expiresAt,
      });

      return Response.json({
        success: true,
        sessionId,
        expiresAt,
      });
    },
  }),
});

const refreshHandler = createApiHandlers({
  POST: endpoint({
    summary: "Refresh session",
    description: "Extend session expiration",
    body: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      sessionId: z.string(),
      expiresAt: z.number(),
    }),
    public: true,
    handler: (_ctx, { body }) => {
      const session = sessions.get(body.sessionId);
      if (!session) {
        return new Response(
          JSON.stringify({ error: "Session not found" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      // Extend session
      const newExpiresAt = Date.now() + 3600 * 1000;
      session.expiresAt = newExpiresAt;

      return Response.json({
        sessionId: session.id,
        expiresAt: newExpiresAt,
      });
    },
  }),
});

const logoutHandler = createApiHandlers({
  POST: endpoint({
    summary: "Logout",
    description: "End session",
    body: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      loggedOut: z.literal(true),
    }),
    public: true,
    handler: (_ctx, { body }) => {
      sessions.delete(body.sessionId);
      return Response.json({ loggedOut: true });
    },
  }),
});

// =============================================================================
// Router
// =============================================================================

// deno-lint-ignore no-explicit-any
function createRouter(routes: Record<string, any>) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method;

    for (const [path, handlers] of Object.entries(routes)) {
      if (url.pathname === path) {
        const handler = handlers[method];
        if (handler) {
          return handler({ req, params: {} });
        }
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

const router = createRouter({
  "/auth/login": loginHandler,
  "/auth/refresh": refreshHandler,
  "/auth/logout": logoutHandler,
});

// =============================================================================
// Test Server
// =============================================================================

function startTestServer(): { port: number; close: () => void } {
  const controller = new AbortController();
  const port = 9000 + Math.floor(Math.random() * 1000);

  Deno.serve(
    {
      port,
      signal: controller.signal,
      onListen: () => {},
    },
    router,
  );

  return {
    port,
    close: () => {
      controller.abort();
      sessions.clear();
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

Deno.test("E2E: Complete auth flow - login, refresh, logout", async () => {
  const server = startTestServer();
  try {
    const baseUrl = `http://localhost:${server.port}`;

    // Step 1: Login
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "testuser",
        password: "testpass",
      }),
    });

    assertEquals(loginResponse.status, 200);
    const loginData = await loginResponse.json();
    assertEquals(loginData.success, true);
    assertExists(loginData.sessionId);
    assertExists(loginData.expiresAt);

    // Step 2: Refresh
    const refreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: loginData.sessionId,
      }),
    });

    assertEquals(refreshResponse.status, 200);
    const refreshData = await refreshResponse.json();
    assertEquals(refreshData.sessionId, loginData.sessionId);
    assertExists(refreshData.expiresAt);

    // Step 3: Logout
    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: loginData.sessionId,
      }),
    });

    assertEquals(logoutResponse.status, 200);
    const logoutData = await logoutResponse.json();
    assertEquals(logoutData.loggedOut, true);

    // Verify session is gone - refresh should fail
    const refreshAfterLogout = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: loginData.sessionId,
      }),
    });

    assertEquals(refreshAfterLogout.status, 401);
    await refreshAfterLogout.body?.cancel();
  } finally {
    server.close();
  }
});

Deno.test("E2E: Login failure with invalid credentials", async () => {
  const server = startTestServer();
  try {
    const baseUrl = `http://localhost:${server.port}`;

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "invalid",
        password: "invalid",
      }),
    });

    assertEquals(response.status, 200);
    const data = await response.json();
    assertEquals(data.success, false);
    assertEquals(data.error, "Invalid credentials");
  } finally {
    server.close();
  }
});

Deno.test("E2E: Protocol session tracks state correctly", async () => {
  const server = startTestServer();
  try {
    const baseUrl = `http://localhost:${server.port}`;

    // Create executor that makes real HTTP calls
    const httpExecutor: StepExecutor = {
      execute: async (stepName, request) => {
        const endpoints: Record<string, string> = {
          login: "/auth/login",
          refresh: "/auth/refresh",
          logout: "/auth/logout",
        };

        const response = await fetch(`${baseUrl}${endpoints[stepName]}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });

        return response.json();
      },
    };

    // Use protocol session with real HTTP executor
    const session = createSession(authProtocol, httpExecutor);

    // Login
    const { response: loginResponse, session: s1 } = await session.execute(
      "login",
      {
        username: "alice",
        password: "secret123",
      },
    );

    assertEquals(loginResponse.success, true);
    if (loginResponse.success) {
      assertExists(loginResponse.sessionId);

      // Refresh using session's typed response
      const { response: refreshResponse, session: s2 } = await s1.execute(
        "refresh",
        {
          sessionId: loginResponse.sessionId,
        },
      );

      assertEquals(refreshResponse.sessionId, loginResponse.sessionId);

      // Logout
      const { response: logoutResponse, session: s3 } = await s2.execute(
        "logout",
        {
          sessionId: loginResponse.sessionId,
        },
      );

      assertEquals(logoutResponse.loggedOut, true);
      assertEquals(s3.isTerminal(), true);
      assertEquals(s3.history, ["login", "refresh", "logout"]);
    }
  } finally {
    server.close();
  }
});

Deno.test("E2E: OpenAPI spec with x-protocol extension", async (t) => {
  // Generate base OpenAPI spec from handlers
  const baseSpec = {
    openapi: "3.1.0",
    info: {
      title: "Auth API",
      version: "1.0.0",
    },
    paths: {
      "/auth/login": {
        post: {
          operationId: "login",
          summary: "Login",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    username: { type: "string" },
                    password: { type: "string" },
                  },
                  required: ["username", "password"],
                },
              },
            },
          },
        },
      },
      "/auth/refresh": {
        post: {
          operationId: "refresh",
          summary: "Refresh session",
        },
      },
      "/auth/logout": {
        post: {
          operationId: "logout",
          summary: "Logout",
        },
      },
    },
  };

  // Add protocol extension
  const specWithProtocol = addProtocolToSpec(baseSpec, authProtocol);

  // Verify x-protocol is present
  assertEquals(specWithProtocol["x-protocol"].name, "SimpleAuth");
  assertEquals(specWithProtocol["x-protocol"].initial, "login");
  assertEquals(specWithProtocol["x-protocol"].terminal, ["logout"]);

  // Snapshot the full spec
  await assertSnapshot(t, specWithProtocol);
});

Deno.test("E2E: Protocol OpenAPI extension structure", () => {
  const xProtocol = protocolToOpenApi(authProtocol);

  // Verify steps
  assertEquals(xProtocol.steps.length, 3);

  // Login step (independent)
  const loginStep = xProtocol.steps.find((s) => s.name === "login");
  assertEquals(loginStep?.dependsOn, undefined);
  assertEquals([...(loginStep?.next ?? [])].sort(), ["logout", "refresh"]);

  // Refresh step (depends on login)
  const refreshStep = xProtocol.steps.find((s) => s.name === "refresh");
  assertEquals(refreshStep?.dependsOn, "login");
  assertEquals(refreshStep?.next, undefined);

  // Logout step (depends on login)
  const logoutStep = xProtocol.steps.find((s) => s.name === "logout");
  assertEquals(logoutStep?.dependsOn, "login");
  assertEquals(logoutStep?.next, undefined);
});

Deno.test("E2E: Typed client with auth API", async () => {
  const server = startTestServer();
  try {
    // Define API interface for typed client
    interface AuthApi {
      auth: {
        login: {
          create: {
            body: { username: string; password: string };
            response:
              | { success: true; sessionId: string; expiresAt: number }
              | { success: false; error: string };
          };
        };
        refresh: {
          create: {
            body: { sessionId: string };
            response: { sessionId: string; expiresAt: number };
          };
        };
        logout: {
          create: {
            body: { sessionId: string };
            response: { loggedOut: true };
          };
        };
      };
    }

    const client = createClient<AuthApi>({
      baseUrl: `http://localhost:${server.port}`,
      basePath: "",
    });

    // Login via typed client
    const loginResult = await client.auth.login.create({
      username: "bob",
      password: "password123",
    });

    assertEquals(loginResult.success, true);
    if (loginResult.success) {
      // Refresh
      const refreshResult = await client.auth.refresh.create({
        sessionId: loginResult.sessionId,
      });
      assertEquals(refreshResult.sessionId, loginResult.sessionId);

      // Logout
      const logoutResult = await client.auth.logout.create({
        sessionId: loginResult.sessionId,
      });
      assertEquals(logoutResult.loggedOut, true);
    }
  } finally {
    server.close();
  }
});

Deno.test("E2E: Handler metadata includes protocol info", () => {
  // Verify __apiDef metadata is attached
  assertExists(loginHandler.__apiDef);
  assertExists(loginHandler.__apiDef.POST);

  assertExists(refreshHandler.__apiDef);
  assertExists(refreshHandler.__apiDef.POST);

  assertExists(logoutHandler.__apiDef);
  assertExists(logoutHandler.__apiDef.POST);
});
