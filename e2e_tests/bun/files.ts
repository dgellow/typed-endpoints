import { z } from "zod";
import {
  fromStep,
  mappedStep,
  protocol,
  step,
} from "@dgellow/typed-endpoints/protocol";

/** A file is opened and has to be closed: `close` is the `onAbandon` step. */
export const fileProtocol = protocol({
  name: "Files",
  initial: "open",
  terminal: ["close"],
  onAbandon: "close",
  steps: {
    open: step({
      name: "open",
      request: z.object({ path: z.string() }),
      response: z.object({ handle: z.string() }),
    }),
    close: mappedStep({
      name: "close",
      dependsOn: "open",
      requestMapping: { handle: fromStep("open", "handle") },
      requestSchema: z.object({ handle: z.string() }),
      response: z.object({ closed: z.literal(true) }),
    }),
  },
});
