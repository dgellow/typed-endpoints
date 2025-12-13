import { assertEquals } from "@std/assert";
import { filePathToOpenApiPath } from "./openapi.ts";

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
