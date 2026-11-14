import { z } from "zod";

export const User = z.object({ id: z.string(), name: z.string() });
export const NewUser = User.omit({ id: true });
export const IdParams = z.object({ id: z.string().regex(/^\d+$/) });

export const USERS: z.output<typeof User>[] = [
  { id: "1", name: "Ada" },
  { id: "2", name: "Grace" },
];

export function findUser(id: string): Response {
  const user = USERS.find((u) => u.id === id);
  return user
    ? Response.json(user)
    : Response.json({ error: "not found" }, { status: 404 });
}
