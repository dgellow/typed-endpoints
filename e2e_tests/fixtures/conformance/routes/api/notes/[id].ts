import { z } from "zod";
import { fail } from "@/core/handlers.ts";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { Note, NoteBody, notes, NotFound } from "../../../model.ts";

const Params = z.object({ id: z.string() });

export const handler = createApiHandlers({
  GET: endpoint({
    params: Params,
    response: Note,
    responses: { 404: NotFound },
    handler: (_request, { params }) =>
      notes.get(params.id) ?? fail(404, { error: "not_found", id: params.id }),
  }),
  // Replaces what the body speaks about; keeps `likes`. Creates the note
  // if there is none.
  PUT: endpoint({
    params: Params,
    body: NoteBody,
    response: Note,
    handler: (_request, { params, body }) => {
      const note = {
        id: params.id,
        likes: notes.get(params.id)?.likes ?? 0,
        ...body,
      };
      notes.set(params.id, note);
      return note;
    },
  }),
  // A DELETE that says why in its body.
  DELETE: endpoint({
    params: Params,
    body: z.object({ reason: z.string().min(3) }),
    response: z.object({ deleted: z.literal(true), reason: z.string() }),
    responses: { 404: NotFound },
    handler: (_request, { params, body }) =>
      notes.delete(params.id)
        ? { deleted: true as const, reason: body.reason }
        : fail(404, { error: "not_found", id: params.id }),
  }),
});
