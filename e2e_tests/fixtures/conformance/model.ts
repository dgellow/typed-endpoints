import { z } from "zod";

/** What a client sends to create or replace a note. */
export const NoteBody = z.object({
  title: z.string().min(1).max(40),
  tags: z.array(z.string().min(1)).max(4),
  pinned: z.boolean().optional(),
});

// Named and described: generated code has one type for it, under this
// name, with this documentation.
export const Note = NoteBody.extend({
  id: z.string(),
  likes: z.number().int(),
}).meta({ id: "Note", description: "A note as the server shows it." });

export type Note = z.output<typeof Note>;

// Named: one class in generated code, whichever operation declares it.
export const NotFound = z.object({
  error: z.literal("not_found"),
  id: z.string(),
}).meta({ id: "NotFound" });

export const Conflict = z.object({
  error: z.literal("conflict"),
  title: z.string(),
});

/** The notes of this server, by id. */
export const notes = new Map<string, Note>();
