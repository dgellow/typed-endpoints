import { z } from "zod";

/** What a client sends to PUT. */
export const NoteBody = z.object({
  title: z.string().min(1).max(40),
  tags: z.array(z.string().min(1)).max(4),
  pinned: z.boolean().optional(),
});

/** What GET shows: the body, and what the server alone decides. */
export const Note = NoteBody.extend({
  id: z.string(),
  likes: z.number().int(),
  updatedAt: z.string(),
});

export type Note = z.output<typeof Note>;

export const NotFound = z.object({ error: z.literal("not_found") });

let clock = 0;

/** A new value on every call, as a wall clock would give. */
export function now(): string {
  return new Date(Date.UTC(2026, 0, 1) + 1000 * ++clock).toISOString();
}

/** A store with one note in it. */
export function store(): Map<string, Note> {
  return new Map([["1", {
    id: "1",
    title: "First",
    tags: ["a"],
    likes: 3,
    updatedAt: now(),
  }]]);
}
