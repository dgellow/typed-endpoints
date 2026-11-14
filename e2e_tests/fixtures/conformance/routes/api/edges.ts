import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

/**
 * Places where "the same schema" can mean different things in different
 * languages. Every field is optional, so a test sends one at a time.
 */
const Edges = z.object({
  // Length is counted in code points, not UTF-16 units and not graphemes.
  short: z.string().max(4).optional(),
  // `\d` in JavaScript is 0-9.
  digits: z.string().regex(/^\d+$/).optional(),
  // The complement, inside a class: anything that is not 0-9.
  plain: z.string().regex(/^[\D]+$/).optional(),
  // A lookahead.
  word: z.string().regex(/^(?!admin)\w+$/).optional(),
  // In JSON, 2.0 is the integer 2.
  count: z.number().int().optional(),
  // 0.3 is a multiple of 0.1, although 0.3 / 0.1 is not 3 in binary.
  step: z.number().multipleOf(0.1).optional(),
  // The bound of every integer, written for a number that is not one.
  huge: z.number().max(Number.MAX_SAFE_INTEGER).optional(),
  // Optional is not nullable.
  flag: z.boolean().optional(),
  // Absent, null and a value are three things.
  maybe: z.string().nullable().optional(),
  when: z.iso.datetime().optional(),
  id: z.uuid().optional(),
  email: z.email().optional(),
});

export const handler = createApiHandlers({
  // A list in a query, which has to be there: no occurrence of its key is
  // an empty list, and one occurrence a list of one.
  GET: endpoint({
    query: z.object({ label: z.array(z.string()) }),
    response: z.object({ labels: z.array(z.string()) }),
    handler: (_request, { query }) => ({ labels: query.label }),
  }),
  // Says which fields arrived, and gives `maybe` and `count` back.
  POST: endpoint({
    body: Edges,
    response: z.object({
      received: z.array(z.string()),
      maybe: z.string().nullable().optional(),
      count: z.number().int().optional(),
    }),
    handler: (_request, { body }) => ({
      received: Object.keys(body).sort(),
      ...("maybe" in body && { maybe: body.maybe }),
      ...(body.count !== undefined && { count: body.count }),
    }),
  }),
});
