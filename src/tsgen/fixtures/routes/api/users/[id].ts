import { z } from "zod";
import type { ApiDef } from "@/core/types.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

const apiDef: ApiDef = {
  GET: {
    params: z.object({ id: z.string() }),
    response: UserSchema,
  },
  DELETE: {
    params: z.object({ id: z.string() }),
  },
};

export const handler = {
  __apiDef: apiDef,
};
