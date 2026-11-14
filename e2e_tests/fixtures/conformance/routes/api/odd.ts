import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

interface Link {
  name: string;
  next?: Link;
  origin: Link | null;
}

// Refers to itself directly, not through a list.
const Link: z.ZodType<Link> = z.object({
  name: z.string(),
  get next() {
    return Link.optional();
  },
  get origin() {
    return Link.nullable();
  },
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Refers to itself and is not an object: there is no class to name.
const Json: z.ZodType<Json> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.lazy(() => Json)),
  z.record(z.string(), z.lazy(() => Json)),
]);

type Expr = number | { op: "neg"; of: Expr } | { op: "add"; args: Expr[] };

// The same, through objects.
const Expr: z.ZodType<Expr> = z.union([
  z.number(),
  z.object({
    op: z.literal("neg"),
    get of() {
      return Expr;
    },
  }),
  z.object({
    op: z.literal("add"),
    get args() {
      return z.array(Expr);
    },
  }),
]);

/**
 * Shapes that are easy to say in TypeScript and that another language has
 * to find a way to say.
 */
const Odd = z.object({
  // A reserved word in most languages.
  type: z.string(),
  // Two names that are one name in snake case.
  createdAt: z.string(),
  created_at: z.string(),
  // Not an identifier.
  "2fa": z.boolean(),
  pair: z.tuple([z.string(), z.number()]),
  scores: z.record(z.string(), z.number().int()),
  // A union with no field to tell its members apart.
  loose: z.union([z.string(), z.number(), z.array(z.string())]),
  looseOrNull: z.union([z.string(), z.number(), z.null()]),
  version: z.literal(2),
  anything: z.unknown(),
  chain: Link,
  json: Json,
  // Absent, or any JSON value: null is one.
  jsonIfAny: Json.optional(),
  expr: Expr,
  limit: z.number().int().nullable().default(null),
});

export const handler = createApiHandlers({
  // Gives back what it was sent.
  POST: endpoint({
    body: Odd,
    response: Odd,
    handler: (_request, { body }) => body,
  }),
});
