import { z } from "zod";
import { fail } from "@/core/handlers.ts";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { Note, NoteBody, NotFound, now, store } from "../../../note.ts";

const drafts = store();
const Params = z.object({ id: z.string() });

export const handler = createApiHandlers({
  GET: endpoint({
    params: Params,
    response: Note,
    responses: { 404: NotFound },
    handler: (_request, { params }) =>
      drafts.get(params.id) ?? fail(404, { error: "not_found" }),
  }),
  // Broken on purpose: the body's `tags` are accepted and not stored.
  PUT: endpoint({
    params: Params,
    body: NoteBody,
    response: Note,
    responses: { 404: NotFound },
    handler: (_request, { params, body }) => {
      const draft = drafts.get(params.id);
      if (!draft) return fail(404, { error: "not_found" });
      const next = {
        id: draft.id,
        likes: draft.likes,
        tags: draft.tags,
        updatedAt: now(),
        title: body.title,
        ...(body.pinned !== undefined && { pinned: body.pinned }),
      };
      drafts.set(draft.id, next);
      return next;
    },
  }),
});
