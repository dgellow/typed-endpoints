import { z } from "zod";
import type { ApiDef } from "@/core/types.ts";
import { cursor } from "@/pagination/index.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

const CreateUserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});

// Use cursor pagination for list endpoint
const paginatedUsers = cursor.paginated({
  item: UserSchema,
  names: { items: "data", cursor: "nextCursor" },
});

const apiDef: ApiDef = {
  GET: {
    ...paginatedUsers,
  },
  POST: {
    body: CreateUserSchema,
    response: UserSchema,
  },
};

export const handler = {
  __apiDef: apiDef,
};
