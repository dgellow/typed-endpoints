import { z } from "zod";
import {
  fromStep,
  mappedStep,
  protocol,
  step,
} from "../../src/protocol/index.ts";

const login = step({
  name: "login",
  request: z.object({
    username: z.string(),
    password: z.string(),
  }),
  response: z.object({
    token: z.string(),
    userId: z.string(),
  }),
});

const profile = mappedStep({
  name: "profile",
  dependsOn: "login",
  requestMapping: {
    token: fromStep("login", "token"),
  },
  requestSchema: z.object({
    token: z.string(),
    fields: z.array(z.string()),
  }),
  response: z.object({
    name: z.string(),
    email: z.string(),
  }),
});

export default protocol({
  name: "TestAuth",
  initial: "login",
  terminal: ["profile"],
  steps: { login, profile },
});
