/**
 * E2E: Full Protocol Integration
 *
 * Proves the complete loop:
 *   Fresh handlers → fromEndpoint/fromEndpointMapped → protocol
 *   → generateProtocolTypes → compile-time branded safety
 *   + runtime HTTP execution with literal enforcement
 */

import { assertEquals, assertExists } from "@std/assert";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/integrations/fresh.ts";
import {
  createSession,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  protocol,
  type StepExecutor,
} from "../src/protocol/index.ts";
import { generateProtocolTypes } from "../src/protocol/typegen.ts";

// =============================================================================
// Fresh Handlers (the actual endpoint definitions)
// =============================================================================

const loginHandler = createApiHandlers({
  POST: endpoint({
    operationId: "login",
    body: z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }),
    response: z.object({
      accessToken: z.string(),
      userId: z.string(),
    }),
    public: true,
    handler: (_ctx, { body }) => {
      if (body.password === "invalid") {
        return new Response(
          JSON.stringify({ error: "Invalid credentials" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return Response.json({
        accessToken: `token-for-${body.username}`,
        userId: `user-${body.username}`,
      });
    },
  }),
});

const profileHandler = createApiHandlers({
  POST: endpoint({
    operationId: "getProfile",
    body: z.object({
      accessToken: z.string(),
      userId: z.string(),
    }),
    response: z.object({
      name: z.string(),
      email: z.string(),
      role: z.enum(["admin", "user"]),
    }),
    handler: (_ctx, { body }) => {
      return Response.json({
        name: body.userId.replace("user-", ""),
        email: `${body.userId.replace("user-", "")}@example.com`,
        role: "user",
      });
    },
  }),
});

const logoutHandler = createApiHandlers({
  POST: endpoint({
    operationId: "logout",
    body: z.object({
      accessToken: z.string(),
    }),
    response: z.object({
      loggedOut: z.literal(true),
    }),
    handler: () => Response.json({ loggedOut: true }),
  }),
});

// =============================================================================
// Protocol Composed from Handlers
// =============================================================================

const authProtocol = protocol({
  name: "AuthFlow",
  description: "Login → getProfile → logout, composed from Fresh handlers",
  initial: "login",
  terminal: ["logout"],
  steps: {
    login: fromEndpoint(loginHandler, "POST", { name: "login" }),
    getProfile: fromEndpointMapped(profileHandler, "POST", {
      name: "getProfile",
      dependsOn: "login",
      requestMapping: {
        accessToken: fromStep("login", "accessToken"),
        userId: fromStep("login", "userId"),
      },
    }),
    logout: fromEndpointMapped(logoutHandler, "POST", {
      name: "logout",
      dependsOn: "login",
      requestMapping: {
        accessToken: fromStep("login", "accessToken"),
      },
    }),
  },
});

// =============================================================================
// Router & Test Server
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
          return await handler({ req, params: {} });
        }
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

const router = createRouter({
  "/auth/login": loginHandler,
  "/auth/profile": profileHandler,
  "/auth/logout": logoutHandler,
});

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
    close: () => controller.abort(),
  };
}

// =============================================================================
// Test: Composition Correctness
// =============================================================================

Deno.test("E2E: fromEndpointMapped produces correct step structure", () => {
  const steps = authProtocol.steps;

  // login is a plain step
  assertEquals(steps.login.__kind, "step");
  assertEquals(steps.login.operationId, "login");

  // getProfile is a mapped step
  assertEquals(steps.getProfile.__kind, "mapped_step");
  assertEquals(steps.getProfile.name, "getProfile");
  assertEquals(steps.getProfile.dependsOn, "login");
  assertEquals(steps.getProfile.operationId, "getProfile");

  // requestMapping preserved
  const mapping = steps.getProfile.requestMapping;
  assertEquals(mapping.accessToken.__kind, "field_mapping");
  assertEquals(mapping.accessToken.step, "login");
  assertEquals(mapping.accessToken.path, "accessToken");
  assertEquals(mapping.userId.__kind, "field_mapping");
  assertEquals(mapping.userId.step, "login");
  assertEquals(mapping.userId.path, "userId");

  // requestSchema is the merged schema from the handler
  const reqResult = steps.getProfile.requestSchema.safeParse({
    accessToken: "tok",
    userId: "uid",
  });
  assertEquals(reqResult.success, true);

  // response schema is the handler's response schema
  const resResult = steps.getProfile.response.safeParse({
    name: "alice",
    email: "a@b.c",
    role: "user",
  });
  assertEquals(resResult.success, true);

  // logout is also mapped
  assertEquals(steps.logout.__kind, "mapped_step");
  assertEquals(steps.logout.requestMapping.accessToken.step, "login");
});

// =============================================================================
// Test: Type Generation from Composed Protocol
// =============================================================================

Deno.test("E2E: generateProtocolTypes works on protocol composed from handlers", () => {
  const output = generateProtocolTypes(authProtocol);

  // Should have branded types
  assertContains(output, "StepOutput");

  // login response fields should be branded (they're referenced by mappings)
  assertContains(output, 'StepOutput<string, "login", "accessToken">');
  assertContains(output, 'StepOutput<string, "login", "userId">');

  // getProfile request should reference login's branded fields
  assertContains(output, "GetProfileRequest");
  assertContains(output, "GetProfileResponse");

  // logout request should reference login's accessToken
  assertContains(output, "LogoutRequest");

  // All step types present
  assertContains(output, "LoginRequest");
  assertContains(output, "LoginResponse");
});

Deno.test("E2E: generated types compile as valid TypeScript", async () => {
  const output = generateProtocolTypes(authProtocol);

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
      `Generated types should compile:\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("E2E: generated types enforce provenance at compile time", async () => {
  const types = generateProtocolTypes(authProtocol);

  const testCode = `
${types}

// Correct: branded values from the right source
declare const loginResp: LoginResponse;

const goodProfileReq: GetProfileRequest = {
  accessToken: loginResp.accessToken,
  userId: loginResp.userId,
};

// Incorrect: plain string where branded is required
const badProfileReq: GetProfileRequest = {
  // @ts-expect-error — plain string has no provenance brand
  accessToken: "hardcoded",
  // @ts-expect-error — plain string has no provenance brand
  userId: "hardcoded",
};

// Incorrect: wrong field's branded value
const badSwap: GetProfileRequest = {
  // @ts-expect-error — userId brand is not accessToken brand
  accessToken: loginResp.userId,
  // @ts-expect-error — accessToken brand is not userId brand
  userId: loginResp.accessToken,
};

void goodProfileReq;
void badProfileReq;
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
      `Provenance test should compile (with @ts-expect-error for bad cases):\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

// =============================================================================
// Test: Runtime Execution over HTTP
// =============================================================================

Deno.test("E2E: protocol session executes composed steps over HTTP", async () => {
  const server = startTestServer();
  try {
    const baseUrl = `http://localhost:${server.port}`;

    const httpExecutor: StepExecutor = {
      execute: async (stepName, request) => {
        const endpoints: Record<string, string> = {
          login: "/auth/login",
          getProfile: "/auth/profile",
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

    const session = createSession(authProtocol, httpExecutor);

    // Step 1: Login
    const { response: loginRaw, session: s1 } = await session.execute(
      "login",
      { username: "alice", password: "secret" },
    );
    const loginResponse = loginRaw as {
      accessToken: string;
      userId: string;
    };

    assertExists(loginResponse.accessToken);
    assertExists(loginResponse.userId);
    assertEquals(loginResponse.accessToken, "token-for-alice");
    assertEquals(loginResponse.userId, "user-alice");

    // Step 2: Get Profile using login's response
    const { response: profileRaw, session: s2 } = await s1.execute(
      "getProfile",
      {
        accessToken: loginResponse.accessToken,
        userId: loginResponse.userId,
      },
    );
    const profileResponse = profileRaw as {
      name: string;
      email: string;
      role: string;
    };

    assertEquals(profileResponse.name, "alice");
    assertEquals(profileResponse.email, "alice@example.com");
    assertEquals(profileResponse.role, "user");

    // Step 3: Logout
    const { response: logoutRaw, session: s3 } = await s2.execute(
      "logout",
      { accessToken: loginResponse.accessToken },
    );
    const logoutResponse = logoutRaw as { loggedOut: true };

    assertEquals(logoutResponse.loggedOut, true);
    assertEquals(s3.isTerminal(), true);
    assertEquals(s3.history, ["login", "getProfile", "logout"]);
  } finally {
    server.close();
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
