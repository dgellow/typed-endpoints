/**
 * Lens laws of a resource, end to end.
 *
 * Two routes with GET and PUT on one path, served by a real server. The
 * laws are checked over HTTP with bodies generated from the PUT body
 * schema. One route replaces on PUT and obeys them; the other accepts a
 * field and does not store it, and fails the law that says so.
 */

import { assert, assertEquals } from "@std/assert";
import { checkResourceLaws, formatResourceLawsReport } from "@/core/laws.ts";
import { fileRouter } from "@/integrations/fetch.ts";

import { handler as draft } from "./fixtures/laws/routes/api/drafts/[id].ts";
import { handler as note } from "./fixtures/laws/routes/api/notes/[id].ts";

const ROUTES = "e2e_tests/fixtures/laws/routes";

async function serve(): Promise<
  { baseUrl: string; close: () => Promise<void> }
> {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    await fileRouter(ROUTES),
  );
  return {
    baseUrl: `http://localhost:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}

Deno.test("laws: a resource obeys the four laws over HTTP", async () => {
  const { baseUrl, close } = await serve();
  try {
    const url = `${baseUrl}/api/notes/1`;

    // `updatedAt` changes with every PUT, on purpose.
    const report = await checkResourceLaws(note, {
      url,
      ignore: ["updatedAt"],
    });
    assertEquals(report.ok, true, formatResourceLawsReport(report));
    assertEquals(
      Object.values(report.laws).map((law) => law.held),
      [20, 20, 20, 20],
    );

    // Compared as well, the timestamp breaks the two laws that put twice
    // and leaves the other two alone.
    const strict = await checkResourceLaws(note, { url });
    assertEquals(strict.ok, false);
    assertEquals(
      Object.entries(strict.laws)
        .filter(([, law]) => law.violations.length > 0)
        .map(([name]) => name),
      ["get-put", "put-put"],
    );
    for (const name of ["get-put", "put-put"] as const) {
      for (const violation of strict.laws[name]!.violations) {
        assertEquals(violation.differences.map((d) => d.path), ["updatedAt"]);
      }
    }
  } finally {
    await close();
  }
});

Deno.test("laws: a PUT that drops a field fails put-get over HTTP", async () => {
  const { baseUrl, close } = await serve();
  try {
    const report = await checkResourceLaws(draft, {
      url: `${baseUrl}/api/drafts/1`,
      ignore: ["updatedAt"],
    });

    assertEquals(report.ok, false);
    // The other three laws hold: what the server keeps is consistent, it
    // is just not what was put.
    assertEquals(report.laws["get-get"]!.held, 20);
    assertEquals(report.laws["get-put"]!.held, 20);
    assertEquals(report.laws["put-put"]!.held, 20);

    const { violations } = report.laws["put-get"]!;
    assert(violations.length > 0);
    for (const violation of violations) {
      for (const difference of violation.differences) {
        assert(
          difference.path.startsWith("tags"),
          `only tags are dropped, found ${difference.path}`,
        );
      }
    }

    const text = formatResourceLawsReport(report);
    assert(text.includes("put-get: held in"), text);
    assert(/tags\.\d+: put .*, read /.test(text), text);
  } finally {
    await close();
  }
});

Deno.test("laws: a resource that does not exist is refused, not violated", async () => {
  const { baseUrl, close } = await serve();
  try {
    const report = await checkResourceLaws(draft, {
      url: `${baseUrl}/api/drafts/none`,
      runs: 2,
    });

    assertEquals(report.ok, false);
    for (const law of Object.values(report.laws)) {
      assertEquals(law.violations, []);
      assertEquals(law.refusals.length, 2);
      const last = law.refusals[0].exchanges.at(-1)!;
      assertEquals(last.status, 404);
      assertEquals(last.response, { error: "not_found" });
    }
  } finally {
    await close();
  }
});
