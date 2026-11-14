import { z } from "zod";

export const Author = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

export const Comment = z.object({
  id: z.string(),
  text: z.string(),
  by: Author,
});

export const Post = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  author: Author,
  reviewer: Author.nullable(),
  tags: z.array(z.string()),
  comments: z.array(Comment),
});

const ADA = { id: "u1", name: "Ada", email: "ada@example.test" };
const GRACE = { id: "u2", name: "Grace", email: "grace@example.test" };

export const POSTS: z.output<typeof Post>[] = [
  {
    id: "p1",
    title: "Notes on the Analytical Engine",
    body: "The engine weaves algebraic patterns.",
    author: ADA,
    reviewer: GRACE,
    tags: ["history", "machines"],
    comments: [
      { id: "c1", text: "A classic.", by: GRACE },
      { id: "c2", text: "Thanks!", by: ADA },
    ],
  },
  {
    id: "p2",
    title: "Compilers",
    author: GRACE,
    reviewer: null,
    tags: [],
    comments: [],
  },
];
