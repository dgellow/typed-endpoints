/**
 * The few places where the JavaScript runtime matters.
 *
 * The library runs on Deno and Bun (both are tested); nothing in it is
 * specific to either beyond this module, so Node is expected to behave as
 * Bun does. File access goes through `node:` modules, which all three
 * provide. What differs is module
 * resolution: Deno resolves a project's bare imports through the import map
 * in its `deno.json`, which a running process cannot adopt, so user modules
 * are imported in a subprocess started with that config. Bun and Node
 * resolve from the importing file, so the same modules can be imported in
 * process.
 *
 * @module
 */

/** Whether the code runs in Deno. */
export function isDeno(): boolean {
  return "Deno" in globalThis;
}

/** Result of a subprocess. */
export interface ProcessResult {
  /** Exit code. */
  readonly code: number;
  /** Standard output, decoded. */
  readonly stdout: string;
  /** Standard error, decoded. */
  readonly stderr: string;
}

/**
 * Run `deno eval` with a config and a script, and wait for it.
 *
 * Deno only; call it when `isDeno()`. It uses `Deno.Command` and not
 * `node:child_process`, which on Deno needs `--allow-env` in addition to
 * `--allow-run`.
 *
 * @param configPath Path of the `deno.json` whose import map applies.
 *   Without it, Deno looks for one from the working directory upwards.
 * @param script Source of the script.
 * @param args Arguments, available to the script as `Deno.args`.
 */
export async function denoEval(
  configPath: string | undefined,
  script: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: [
      "eval",
      ...(configPath ? ["--config", configPath] : []),
      script,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}
