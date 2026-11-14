/**
 * The examples of a Rust file that must not build, each built by itself.
 *
 * A doc comment marks such an example with a fence like
 * `compile_fail,E0599`. rustdoc builds it and is content when the build
 * fails; whether it fails with that error it checks on a nightly
 * toolchain only. A typo fails a build too. So each example is built
 * here as an example of the crate, and has to fail with the error its
 * fence names and with no other.
 *
 * Run by `./scripts/test-rust`, in `e2e_tests/rust`, with the files to
 * read.
 */

const FENCE = /^\/\/[\/!] ```compile_fail,(E\d{4})$/;

interface Forbidden {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly source: string;
}

/** The examples of a file that name the error they fail with. */
function forbidden(file: string, text: string): Forbidden[] {
  const found: Forbidden[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (!fence) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^\/\/[\/!] ```$/.test(lines[j]); j++) {
      // Without the comment marker and the space after it.
      body.push(lines[j].replace(/^\/\/[\/!] ?/, ""));
    }
    found.push({
      file,
      line: i + 1,
      code: fence[1],
      source: `${body.join("\n")}\n\nfn main() {}\n`,
    });
    i = j;
  }
  return found;
}

const examples = (await Promise.all(
  Deno.args.map(async (file) => forbidden(file, await Deno.readTextFile(file))),
)).flat();
if (examples.length === 0) {
  throw new Error(`no example that must not build in ${Deno.args.join(", ")}`);
}

await Deno.mkdir("examples", { recursive: true });
let failed = 0;
try {
  for (const [index, example] of examples.entries()) {
    const name = `forbidden_${index + 1}`;
    await Deno.writeTextFile(`examples/${name}.rs`, example.source);
    const { success, stderr } = await new Deno.Command("cargo", {
      args: ["check", "--locked", "--quiet", "--example", name],
      stdout: "null",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(stderr);
    const errors = [...output.matchAll(/^error(?:\[(E\d{4})\])?: (.*)$/gm)]
      // The last line counts the errors; it is not one.
      .filter((match) => !match[2].startsWith("could not compile"))
      .map((match) => match[1] ?? match[2]);
    const where = `${example.file}:${example.line}`;
    const codes = [...new Set(errors)];
    if (success) {
      console.error(`${where}: builds, and must not (${example.code})`);
      failed++;
    } else if (codes.length !== 1 || codes[0] !== example.code) {
      console.error(
        `${where}: fails with ${
          codes.join(", ")
        }, not with ${example.code} alone`,
      );
      console.error(output);
      failed++;
    } else {
      console.log(`${where}: does not build (${example.code})`);
    }
  }
} finally {
  await Deno.remove("examples", { recursive: true });
}
if (failed > 0) Deno.exit(1);
