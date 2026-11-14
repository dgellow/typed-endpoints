import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), radius: z.number().positive() }),
  z.object({
    kind: z.literal("rect"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
]);

export const handler = createApiHandlers({
  // A union told apart by a field, names Python cannot use as attributes,
  // a nested object, a default, a nullable field.
  POST: endpoint({
    body: z.object({
      shape: Shape,
      from: z.string(),
      meta: z.object({ "data-id": z.string(), class: z.string().optional() }),
      unit: z.enum(["mm", "cm"]).default("mm"),
      note: z.string().nullable(),
    }),
    response: z.object({
      area: z.number(),
      kind: z.enum(["circle", "rect"]),
      from: z.string(),
      meta: z.object({ "data-id": z.string(), class: z.string().optional() }),
      unit: z.enum(["mm", "cm"]),
      note: z.string().nullable(),
    }),
    handler: (_request, { body }) => ({
      area: body.shape.kind === "circle"
        ? 3 * body.shape.radius * body.shape.radius
        : body.shape.width * body.shape.height,
      kind: body.shape.kind,
      from: body.from,
      meta: body.meta,
      unit: body.unit,
      note: body.note,
    }),
  }),
});
