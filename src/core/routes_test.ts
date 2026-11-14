import { assertEquals, assertRejects } from "@std/assert";
import { fileUrlOf, listRouteFiles } from "./routes.ts";

Deno.test("listRouteFiles: sorted, recursive, without tests and private files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/users/[id]`, { recursive: true });
    await Deno.mkdir(`${dir}/.hidden`);
    for (
      const file of [
        "zeta.ts",
        "users/index.tsx",
        "users/[id]/posts.ts",
        "users_test.ts",
        "users.test.ts",
        "_middleware.ts",
        ".hidden/secret.ts",
        "notes.md",
        "data.json",
      ]
    ) {
      await Deno.writeTextFile(`${dir}/${file}`, "");
    }

    assertEquals(await listRouteFiles(dir), [
      `${dir}/users/[id]/posts.ts`,
      `${dir}/users/index.tsx`,
      `${dir}/zeta.ts`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listRouteFiles: follows symbolic links and skips broken ones", async () => {
  const dir = await Deno.makeTempDir();
  const elsewhere = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${elsewhere}/shared.ts`, "");
    await Deno.symlink(elsewhere, `${dir}/linked`);
    await Deno.symlink(`${elsewhere}/shared.ts`, `${dir}/alias.ts`);
    await Deno.symlink(`${elsewhere}/gone.ts`, `${dir}/broken.ts`);

    assertEquals(await listRouteFiles(dir), [
      `${dir}/alias.ts`,
      `${dir}/linked/shared.ts`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("listRouteFiles: a directory that does not exist is an error", async () => {
  await assertRejects(() => listRouteFiles("no/such/directory"));
});

Deno.test("fileUrlOf: an absolute file URL with links resolved", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/[id].ts`, "");
    await Deno.symlink(`${dir}/[id].ts`, `${dir}/link.ts`);

    assertEquals(
      await fileUrlOf(`${dir}/link.ts`),
      `file://${dir}/%5Bid%5D.ts`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
