import { z } from "zod";
import { fail } from "@/core/handlers.ts";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { cursor } from "@/pagination/index.ts";
import { Conflict, Note, NoteBody, notes } from "../../model.ts";

const page = cursor.paginated({
  item: Note,
  defaultLimit: 2,
  extraQuery: { tag: z.array(z.string()).optional() },
});

let created = 0;

export const handler = createApiHandlers({
  // The notes that carry every given tag, ordered by id. The cursor is
  // the id of the last note of the page before.
  GET: endpoint({
    ...page,
    handler: (_request, { query }) => {
      const wanted = query.tag ?? [];
      const matching = [...notes.values()]
        .filter((note) => wanted.every((tag) => note.tags.includes(tag)))
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((note) => query.cursor === undefined || note.id > query.cursor);
      const items = matching.slice(0, query.limit);
      return page.page({
        items,
        cursor: matching.length > items.length ? items.at(-1)?.id : undefined,
      });
    },
  }),
  // A title is taken once.
  POST: endpoint({
    body: NoteBody,
    response: Note,
    responses: { 409: Conflict },
    handler: (_request, { body }) => {
      for (const note of notes.values()) {
        if (note.title === body.title) {
          return fail(409, { error: "conflict", title: body.title });
        }
      }
      const note = { id: `n${++created}`, likes: 0, ...body };
      notes.set(note.id, note);
      return note;
    },
  }),
});
