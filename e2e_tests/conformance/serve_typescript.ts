/**
 * The fixture's TypeScript handlers on a port of their own, for the
 * Python client's tests. Prints where it listens, then serves until it is
 * stopped. Run by `./scripts/test-python`.
 */

import { fileRouter } from "@/integrations/fetch.ts";

const server = Deno.serve(
  { port: 0, hostname: "127.0.0.1", onListen: () => {} },
  await fileRouter("e2e_tests/fixtures/conformance/routes"),
);
console.log(`http://127.0.0.1:${server.addr.port}`);
