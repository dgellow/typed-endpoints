import { z } from "zod";
import type { ApiDef } from "@/core/types.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

const CreateUserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});

const apiDef: ApiDef = {
  GET: {
    response: z.array(UserSchema),
  },
  POST: {
    body: CreateUserSchema,
    response: UserSchema,
  },
};

export const handler = {
  __apiDef: apiDef,
};
