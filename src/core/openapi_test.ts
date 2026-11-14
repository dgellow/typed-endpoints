import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { filePathToOpenApiPath, generateOpenApiSpec } from "./openapi.ts";

// filePathToOpenApiPath tests

Deno.test("filePathToOpenApiPath basic conversion", () => {
  assertEquals(filePathToOpenApiPath("routes/api/users.ts"), "/api/users");
});

Deno.test("filePathToOpenApiPath handles .tsx extension", () => {
  assertEquals(filePathToOpenApiPath("routes/api/users.tsx"), "/api/users");
});

Deno.test("filePathToOpenApiPath handles [param]", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles [...param] (catch-all)", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/files/[...path].ts"),
    "/api/files/{path}",
  );
});

Deno.test("filePathToOpenApiPath handles index files", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/index.ts"),
    "/api/users",
  );
});

Deno.test("filePathToOpenApiPath handles root index", () => {
  assertEquals(filePathToOpenApiPath("routes/index.ts"), "/");
});

Deno.test("filePathToOpenApiPath handles route groups", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/login.ts"),
    "/api/login",
  );
});

Deno.test("filePathToOpenApiPath handles nested route groups", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/(admin)/settings.ts"),
    "/api/settings",
  );
});

Deno.test("filePathToOpenApiPath handles route group with params", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/(auth)/users/[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles Windows backslashes", () => {
  assertEquals(
    filePathToOpenApiPath("routes\\api\\users\\[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles mixed slashes", () => {
  assertEquals(
    filePathToOpenApiPath("routes\\api/users\\[id].ts"),
    "/api/users/{id}",
  );
});

Deno.test("filePathToOpenApiPath handles multiple params", () => {
  assertEquals(
    filePathToOpenApiPath("routes/api/users/[userId]/posts/[postId].ts"),
    "/api/users/{userId}/posts/{postId}",
  );
});

Deno.test("filePathToOpenApiPath handles deeply nested routes", () => {
  assertEquals(
    filePathToOpenApiPath(
      "routes/api/v1/organizations/[orgId]/teams/[teamId]/members.ts",
    ),
    "/api/v1/organizations/{orgId}/teams/{teamId}/members",
  );
});

Deno.test("filePathToOpenApiPath strips route groups but keeps structure", () => {
  assertEquals(
    filePathToOpenApiPath("routes/(marketing)/blog/posts/[slug].ts"),
    "/blog/posts/{slug}",
  );
});

Deno.test("filePathToOpenApiPath ignores what precedes the routes directory", () => {
  for (
    const prefix of ["", "./", "src/", "/home/me/project/", "C:\\project\\"]
  ) {
    assertEquals(
      filePathToOpenApiPath(`${prefix}routes/api/users/[id].ts`),
      "/api/users/{id}",
      prefix,
    );
  }
});

// =============================================================================
// generateOpenApiSpec
// =============================================================================

const FIXTURES_DIR = new URL("./fixtures/routes/api", import.meta.url).pathname;

/** Run `fn` with console.warn captured instead of printed. */
async function captureWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("generateOpenApiSpec emits operationIds and URL paths", async () => {
  const { result: spec, warnings } = await captureWarnings(() =>
    generateOpenApiSpec({ routesDir: FIXTURES_DIR })
  );

  // The routes directory is an absolute path; the spec paths are URL paths.
  assertEquals(Object.keys(spec.paths ?? {}).sort(), [
    "/api/items",
    "/api/items/{id}",
  ]);

  const items = spec.paths!["/api/items"];
  const item = spec.paths!["/api/items/{id}"];
  // Derived: the same id that `--format routes` uses as the route key.
  assertEquals(items.get?.operationId, "itemsList");
  assertEquals(item.get?.operationId, "itemsRetrieve");
  // Explicit operationId wins.
  assertEquals(items.post?.operationId, "createItem");
  // PUT and PATCH both derive "itemsUpdate". A duplicate operationId makes
  // the spec invalid, so neither gets one.
  assertEquals(item.put?.operationId, undefined);
  assertEquals(item.patch?.operationId, undefined);
  // Not public.
  assertEquals(item.delete, undefined);

  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings.join("\n"), "broken.ts");
  assertStringIncludes(warnings.join("\n"), 'operationId "itemsUpdate"');
});

Deno.test("generateOpenApiSpec strict mode reports every problem", async () => {
  const error = await assertRejects(
    () => generateOpenApiSpec({ routesDir: FIXTURES_DIR, strict: true }),
    Error,
    "OpenAPI generation failed",
  );
  assertStringIncludes(error.message, "broken.ts: route module failed to load");
  assertStringIncludes(
    error.message,
    'operationId "itemsUpdate" is used by PUT /api/items/{id}',
  );
  assertStringIncludes(error.message, "and PATCH /api/items/{id}");
});
