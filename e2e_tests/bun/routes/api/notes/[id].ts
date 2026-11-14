import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";

const NoteBody = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).max(3),
  pinned: z.boolean().optional(),
});
const Note = NoteBody.extend({ id: z.string(), likes: z.number() });
const Params = z.object({ id: z.string() });

const notes = new Map<string, z.output<typeof Note>>();

// A resource: GET shows it, PUT replaces what the body speaks about.
// The note "merged" is broken on purpose: its PUT keeps the fields the
// body leaves out, which is what PATCH does.
export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: Params,
    response: Note,
    handler: (_req, { params }) =>
      notes.get(params.id) ??
        Response.json({ error: "not found" }, { status: 404 }),
  }),
  PUT: endpoint({
    public: true,
    params: Params,
    body: NoteBody,
    response: Note,
    handler: (_req, { params, body }) => {
      const current = notes.get(params.id);
      const note = {
        ...(params.id === "merged" ? current : {}),
        id: params.id,
        likes: current?.likes ?? 0,
        ...body,
      };
      notes.set(params.id, note);
      return note;
    },
  }),
});
