import { z } from "zod";
import {
  fromStep,
  mappedStep,
  protocol,
  step,
} from "@dgellow/typed-endpoints/protocol";

export default protocol({
  name: "Account",
  initial: "login",
  steps: {
    login: step({
      name: "login",
      request: z.object({ user: z.string() }),
      response: z.object({ token: z.string() }),
    }),
    profile: mappedStep({
      name: "profile",
      dependsOn: "login",
      requestMapping: { token: fromStep("login", "token") },
      requestSchema: z.object({ token: z.string() }),
      response: z.object({ name: z.string() }),
    }),
  },
});
