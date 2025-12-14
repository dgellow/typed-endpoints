import { assertEquals } from "@std/assert";
import { filePathToApiPath, pathToTypeName } from "./path.ts";

// filePathToApiPath tests

Deno.test("filePathToApiPath basic conversion", () => {
  assertEquals(filePathToApiPath("routes/api/users.ts"), "/api/users");
});

Deno.test("filePathToApiPath handles .tsx extension", () => {
  assertEquals(filePathToApiPath("routes/api/users.tsx"), "/api/users");
});

Deno.test("filePathToApiPath handles index files", () => {
  assertEquals(filePathToApiPath("routes/api/users/index.ts"), "/api/users");
});

Deno.test("filePathToApiPath handles root index", () => {
  assertEquals(filePathToApiPath("routes/index.ts"), "/");
});

Deno.test("filePathToApiPath handles route groups", () => {
  assertEquals(filePathToApiPath("routes/api/(auth)/login.ts"), "/api/login");
});

Deno.test("filePathToApiPath handles nested route groups", () => {
  assertEquals(
    filePathToApiPath("routes/api/(auth)/(admin)/settings.ts"),
    "/api/settings",
  );
});

Deno.test("filePathToApiPath handles Windows backslashes", () => {
  assertEquals(filePathToApiPath("routes\\api\\users.ts"), "/api/users");
});

Deno.test("filePathToApiPath handles mixed slashes", () => {
  assertEquals(filePathToApiPath("routes\\api/users.ts"), "/api/users");
});

Deno.test("filePathToApiPath handles absolute paths", () => {
  assertEquals(
    filePathToApiPath("/home/user/project/routes/api/users.ts"),
    "/api/users",
  );
});

Deno.test("filePathToApiPath handles absolute paths with params", () => {
  assertEquals(
    filePathToApiPath("/home/user/project/routes/api/users/[id].ts"),
    "/api/users/[id]",
  );
});

// pathToTypeName tests

Deno.test("pathToTypeName strips /api/ prefix", () => {
  assertEquals(pathToTypeName("/api/users"), "Users");
});

Deno.test("pathToTypeName strips /api/internal/ prefix", () => {
  assertEquals(
    pathToTypeName("/api/internal/store-notification"),
    "StoreNotification",
  );
});

Deno.test("pathToTypeName converts [param] to ByParam", () => {
  assertEquals(pathToTypeName("/api/users/[id]"), "UsersByid");
});

Deno.test("pathToTypeName handles nested params", () => {
  assertEquals(
    pathToTypeName("/api/users/[userId]/posts/[postId]"),
    "UsersByuserIdPostsBypostId",
  );
});

Deno.test("pathToTypeName handles kebab-case paths", () => {
  assertEquals(pathToTypeName("/api/send-digest"), "SendDigest");
});
