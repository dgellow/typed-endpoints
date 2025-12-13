import { assertEquals } from "@std/assert";
import { shouldSkipFile } from "./files.ts";

Deno.test("shouldSkipFile skips dotfiles", () => {
  assertEquals(shouldSkipFile(".hidden.ts"), true);
});

Deno.test("shouldSkipFile skips underscore prefix", () => {
  assertEquals(shouldSkipFile("_private.ts"), true);
});

Deno.test("shouldSkipFile skips _test.ts files", () => {
  assertEquals(shouldSkipFile("users_test.ts"), true);
});

Deno.test("shouldSkipFile skips .test.ts files", () => {
  assertEquals(shouldSkipFile("users.test.ts"), true);
});

Deno.test("shouldSkipFile skips _test.tsx files", () => {
  assertEquals(shouldSkipFile("component_test.tsx"), true);
});

Deno.test("shouldSkipFile allows regular ts files", () => {
  assertEquals(shouldSkipFile("users.ts"), false);
});

Deno.test("shouldSkipFile allows regular tsx files", () => {
  assertEquals(shouldSkipFile("component.tsx"), false);
});

Deno.test("shouldSkipFile allows files with test in name", () => {
  assertEquals(shouldSkipFile("testing-utils.ts"), false);
});
