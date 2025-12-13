import { assertEquals } from "@std/assert";
import { z } from "zod";
import { zodToTypeString } from "./zod.ts";

Deno.test("zodToTypeString converts string schema", () => {
  const schema = z.string();
  assertEquals(zodToTypeString(schema), "string");
});

Deno.test("zodToTypeString converts number schema", () => {
  const schema = z.number();
  assertEquals(zodToTypeString(schema), "number");
});

Deno.test("zodToTypeString converts boolean schema", () => {
  const schema = z.boolean();
  assertEquals(zodToTypeString(schema), "boolean");
});

Deno.test("zodToTypeString converts object schema", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });
  const result = zodToTypeString(schema);
  // Normalize whitespace for comparison
  const normalized = result.replace(/\s+/g, " ").trim();
  assertEquals(normalized, "{ name: string; age: number; }");
});

Deno.test("zodToTypeString converts array schema", () => {
  const schema = z.array(z.string());
  assertEquals(zodToTypeString(schema), "string[]");
});

Deno.test("zodToTypeString converts optional schema", () => {
  const schema = z.object({
    name: z.string(),
    nickname: z.string().optional(),
  });
  const result = zodToTypeString(schema);
  const normalized = result.replace(/\s+/g, " ").trim();
  assertEquals(normalized, "{ name: string; nickname?: string | undefined; }");
});

Deno.test("zodToTypeString converts enum schema", () => {
  const schema = z.enum(["active", "inactive"]);
  assertEquals(zodToTypeString(schema), '"active" | "inactive"');
});

Deno.test("zodToTypeString converts nullable schema", () => {
  const schema = z.string().nullable();
  assertEquals(zodToTypeString(schema), "string | null");
});
