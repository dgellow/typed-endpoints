import { z } from "zod";
import { fail } from "@/core/handlers.ts";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { Note, NoteBody, NotFound, now, store } from "../../../note.ts";

const notes = store();
const Params = z.object({ id: z.string() });

export const handler = createApiHandlers({
  GET: endpoint({
    params: Params,
    response: Note,
    responses: { 404: NotFound },
    handler: (_request, { params }) =>
      notes.get(params.id) ?? fail(404, { error: "not_found" }),
  }),
  // Replaces what the body speaks about; keeps `id` and `likes`.
  PUT: endpoint({
    params: Params,
    body: NoteBody,
    response: Note,
    handler: (_request, { params, body }) => {
      const note = {
        id: params.id,
        likes: notes.get(params.id)?.likes ?? 0,
        updatedAt: now(),
        ...body,
      };
      notes.set(params.id, note);
      return note;
    },
  }),
});
