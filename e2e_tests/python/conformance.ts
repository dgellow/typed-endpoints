/**
 * One API, two servers, the same tests.
 *
 * The routes of `e2e_tests/fixtures/python` are served twice: by their
 * TypeScript handlers, and by FastAPI from the Python module the
 * generator writes for them (`api_generated.py`) with handlers written in
 * Python (`app.py`). `conformance()` registers the tests below against a
 * base URL; they use the TypeScript client generated from the same routes.
 *
 * What is compared across the two is the contract: statuses, bodies,
 * which part of a request failed and where. The wording of a validation
 * message is each validator's own (Zod's, Pydantic's) and is not compared.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ClientError, createClient } from "@/client/index.ts";
import { checkResourceLaws, formatResourceLawsReport } from "@/core/laws.ts";

import { type Api, routes } from "../fixtures/python/api.generated.ts";
import { handler as note } from "../fixtures/python/routes/api/notes/[id].ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

interface Invalid {
  error: string;
  in: string;
  issues: { path: (string | number)[]; message: string; code: string }[];
}

/**
 * Register the conformance tests against the server at `baseUrl()`.
 *
 * @param label Names the server in the test names.
 * @param baseUrl Where the server listens; read when a test runs.
 */
export function conformance(label: string, baseUrl: () => string): void {
  const client = () => createClient<Api>({ baseUrl: baseUrl(), routes });
  const send = (method: string, path: string, body?: string, type?: string) =>
    fetch(`${baseUrl()}${path}`, {
      method,
      ...(body !== undefined && {
        body,
        headers: { "Content-Type": type ?? "application/json" },
      }),
    });
  const test = (name: string, fn: () => Promise<void>) =>
    Deno.test(`${label}: ${name}`, fn);

  test("create, retrieve and replace a note", async () => {
    const api = client();
    const created = await api.notes.create({
      title: `first of ${label}`,
      tags: ["a", "b"],
    });
    assertType<
      Equal<
        typeof created,
        {
          title: string;
          tags: string[];
          pinned?: boolean;
          id: string;
          likes: number;
        }
      >
    >();
    assertEquals(created.title, `first of ${label}`);
    assertEquals(created.likes, 0);
    // A field that was not sent is absent from the answer, not null.
    assertEquals("pinned" in created, false);

    assertEquals(await api.notes.retrieve(created.id), created);

    const replaced = await api.notes.update(created.id, {
      title: "renamed",
      tags: [],
      pinned: true,
    });
    assertEquals(replaced, {
      id: created.id,
      likes: 0,
      title: "renamed",
      tags: [],
      pinned: true,
    });
    assertEquals(await api.notes.retrieve(created.id), replaced);
  });

  test("declared errors come back as values, typed by status", async () => {
    const api = client();

    const missing = await api.notes.retrieve.result("no-such-note");
    assertEquals(missing, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: "no-such-note" },
    });

    await api.notes.create({ title: `taken on ${label}`, tags: [] });
    const again = await api.notes.create.result({
      title: `taken on ${label}`,
      tags: [],
    });
    assertEquals(again, {
      ok: false,
      status: 409,
      error: { error: "conflict", title: `taken on ${label}` },
    });

    // The throwing call throws for the same answer.
    const error = await assertRejects(
      () => api.notes.retrieve("no-such-note"),
      ClientError,
    );
    assertEquals(error.status, 404);
  });

  test("a list is paginated by cursor and filtered by tag", async () => {
    const api = client();
    const tag = `listed-${label}`;
    for (const id of ["l1", "l2", "l3", "l4", "l5"]) {
      await api.notes.update(`${label}-${id}`, {
        title: id,
        tags: id === "l3" ? [tag, "odd"] : [tag],
      });
    }

    // Pages of two, followed by cursor until the server gives none.
    const pages: string[][] = [];
    for await (const page of api.notes.list.pages({ query: { tag: [tag] } })) {
      pages.push(page.items.map((item) => item.title));
    }
    assertEquals(pages, [["l1", "l2"], ["l3", "l4"], ["l5"]]);

    const titles: string[] = [];
    for await (
      const item of api.notes.list.items({ query: { tag: [tag], limit: 4 } })
    ) {
      titles.push(item.title);
    }
    assertEquals(titles, ["l1", "l2", "l3", "l4", "l5"]);

    // Every given tag has to be on the note.
    const odd = await api.notes.list({ query: { tag: [tag, "odd"] } });
    assertEquals(odd.items.map((item) => item.title), ["l3"]);
    // The last page has no cursor: the member is absent.
    assertEquals("cursor" in odd, false);
  });

  test("a request that fails validation is a 400 that names the part and the place", async () => {
    const invalid = async (response: Response) => {
      assertEquals(response.status, 400);
      const body = await response.json() as Invalid;
      assertEquals(typeof body.error, "string");
      return {
        in: body.in,
        paths: body.issues.map((issue) => issue.path.join(".")).sort(),
      };
    };

    // A body with two wrong fields and one missing.
    assertEquals(
      await invalid(
        await send(
          "PUT",
          "/api/notes/v1",
          JSON.stringify({ title: "", tags: ["a", 2] }),
        ),
      ),
      { in: "body", paths: ["tags.1", "title"] },
    );
    assertEquals(
      await invalid(await send("PUT", "/api/notes/v1", JSON.stringify({}))),
      { in: "body", paths: ["tags", "title"] },
    );

    // Types are not coerced in a body: "5" is not a boolean, 5 not a string.
    assertEquals(
      await invalid(
        await send(
          "PUT",
          "/api/notes/v1",
          JSON.stringify({ title: 5, tags: [], pinned: "true" }),
        ),
      ),
      { in: "body", paths: ["pinned", "title"] },
    );

    // A query parameter out of range; in a query, text becomes a number.
    assertEquals(await invalid(await send("GET", "/api/notes?limit=0")), {
      in: "query",
      paths: ["limit"],
    });
    assertEquals((await send("GET", "/api/notes?limit=3")).status, 200);

    // Malformed JSON.
    const malformed = await send("PUT", "/api/notes/v1", "{title:");
    assertEquals(malformed.status, 400);
    assertEquals(await malformed.json(), {
      error: "Invalid JSON body",
      in: "json",
      issues: [],
    });

    // Nothing was stored by any of them.
    assertEquals((await send("GET", "/api/notes/v1")).status, 404);
  });

  test("a DELETE carries a body, which is validated", async () => {
    const api = client();
    await api.notes.update(`${label}-d1`, { title: "to delete", tags: [] });

    const short = await assertRejects(
      () => api.notes.delete(`${label}-d1`, { reason: "no" }),
      ClientError,
    );
    assertEquals(short.status, 400);
    assertEquals((short.body as Invalid).in, "body");

    assertEquals(
      await api.notes.delete(`${label}-d1`, { reason: "obsolete" }),
      { deleted: true, reason: "obsolete" },
    );
    const gone = await api.notes.delete.result(`${label}-d1`, {
      reason: "obsolete",
    });
    assertEquals(gone, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: `${label}-d1` },
    });
  });

  test("a catch-all parameter keeps its slashes", async () => {
    const api = client();
    assertEquals(await api.echo.retrieve("docs/guide/intro.md"), {
      path: "docs/guide/intro.md",
      segments: ["docs", "guide", "intro.md"],
    });
  });

  test("unions, defaults, nulls and names Python cannot spell cross unchanged", async () => {
    const api = client();
    const circle = await api.shapes.create({
      shape: { kind: "circle", radius: 2 },
      from: "sketch",
      meta: { "data-id": "m1" },
      note: null,
    });
    assertEquals(circle, {
      area: 12,
      kind: "circle",
      from: "sketch",
      meta: { "data-id": "m1" },
      // The default of a field that was left out.
      unit: "mm",
      // Null where the schema allows null.
      note: null,
    });

    const rect = await api.shapes.create({
      shape: { kind: "rect", width: 2, height: 2.5 },
      from: "plan",
      meta: { "data-id": "m2", class: "wide" },
      unit: "cm",
      note: "checked",
    });
    assertEquals(rect, {
      area: 5,
      kind: "rect",
      from: "plan",
      meta: { "data-id": "m2", class: "wide" },
      unit: "cm",
      note: "checked",
    });

    // A member of the union that is neither variant, and a variant
    // without its field.
    for (
      const shape of [{ kind: "triangle", side: 1 }, { kind: "circle" }]
    ) {
      const response = await send(
        "POST",
        "/api/shapes",
        JSON.stringify({
          shape,
          from: "x",
          meta: { "data-id": "m" },
          note: null,
        }),
      );
      assertEquals(response.status, 400);
      const body = await response.json() as Invalid;
      assertEquals(body.in, "body");
      assert(
        body.issues.every((issue) => issue.path[0] === "shape"),
        JSON.stringify(body.issues),
      );
    }
  });

  test("a schema that refers to itself", async () => {
    const api = client();
    const leaf = (name: string) => ({ name, children: [] });
    const root = {
      name: "root",
      children: [leaf("a"), { name: "b", children: [leaf("c")] }],
    };
    assertEquals(await api.trees.create(root), { depth: 3, root });

    // Checked at every level.
    const response = await send(
      "POST",
      "/api/trees",
      JSON.stringify({
        name: "root",
        children: [{ name: "b", children: [{ name: 7, children: [] }] }],
      }),
    );
    assertEquals(response.status, 400);
    const body = await response.json() as Invalid;
    assertEquals(body.issues.map((issue) => issue.path), [
      ["children", 0, "children", 0, "name"],
    ]);
  });

  test("the note is a lawful resource", async () => {
    const url = `${baseUrl()}/api/notes/${label}-lawful`;
    const created = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "lawful", tags: ["x"] }),
    });
    assertEquals(created.status, 200);
    await created.body?.cancel();

    // Generated bodies, GET and PUT: the four lens laws hold.
    const report = await checkResourceLaws(note, { url, runs: 10 });
    assertEquals(report.ok, true, formatResourceLawsReport(report));
  });
}
