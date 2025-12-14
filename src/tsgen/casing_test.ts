import { assertEquals } from "@std/assert";
import { toPascalCase } from "./casing.ts";

Deno.test("toPascalCase converts kebab-case", () => {
  assertEquals(toPascalCase("store-notification"), "StoreNotification");
});

Deno.test("toPascalCase converts snake_case", () => {
  assertEquals(toPascalCase("store_notification"), "StoreNotification");
});

Deno.test("toPascalCase converts path segments", () => {
  assertEquals(toPascalCase("users/settings"), "UsersSettings");
});

Deno.test("toPascalCase handles mixed separators", () => {
  assertEquals(
    toPascalCase("user-profile/settings_page"),
    "UserProfileSettingsPage",
  );
});

Deno.test("toPascalCase handles single word", () => {
  assertEquals(toPascalCase("users"), "Users");
});

Deno.test("toPascalCase handles empty string", () => {
  assertEquals(toPascalCase(""), "");
});

Deno.test("toPascalCase handles consecutive separators", () => {
  assertEquals(toPascalCase("foo--bar"), "FooBar");
});
