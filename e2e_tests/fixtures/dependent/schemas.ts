import { z } from "zod";

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  age: z.number().optional(),
});

export const Team = z.object({ id: z.string(), title: z.string() });

/** What `GET /api/users/[id]?expand=` can include. */
export const userRelations = { team: Team, manager: User };

export const USERS: z.output<typeof User>[] = [
  { id: "1", name: "Ada", email: "ada@example.test", age: 36 },
  { id: "2", name: "Grace", email: "grace@example.test" },
  { id: "3", name: "Edsger", email: "edsger@example.test", age: 72 },
];

export const TEAM: z.output<typeof Team> = { id: "t1", title: "Compilers" };
