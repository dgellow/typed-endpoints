import { z } from "zod";

export const Item = z.object({ id: z.string(), name: z.string() });
export type Item = z.output<typeof Item>;

/** Seven items: with a page size of three, two full pages and a short one. */
export const ITEMS: Item[] = [
  "ant",
  "bee",
  "cat",
  "dog",
  "eel",
  "fox",
  "gnu",
].map((name, index) => ({ id: `i${index + 1}`, name }));
