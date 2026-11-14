/**
 * Rust from routes: serde types and an axum router.
 *
 * @example
 * ```ts
 * import { generateAxum } from "@dgellow/typed-endpoints/rust";
 *
 * await generateAxum({
 *   routesDirs: ["routes/api"],
 *   output: "server/src/api_generated.rs",
 * });
 * ```
 *
 * @module
 */

import { writeFile } from "node:fs/promises";

import { generateContract } from "../contract/index.ts";
import type { RouteOptions } from "../tsgen/generate.ts";
import { renderAxum } from "./axum.ts";

export { renderAxum } from "./axum.ts";
export type { AxumOptions } from "./axum.ts";
export { constantCase, identifier, RustModels, snakeCase } from "./models.ts";
export { RustContract, rustString } from "./contract.ts";

/** Options of `generateAxum()`. */
export interface GenerateAxumOptions extends RouteOptions {
  /** File to write the Rust module to. */
  readonly output?: string;
}

/**
 * Generate a Rust module with serde types, a `Handlers` trait and an axum
 * router for the routes of a directory.
 *
 * The module needs these crates: `axum`, `serde` (with `derive`),
 * `serde_json` and `fancy-regex`.
 *
 * @returns The source of the module.
 */
export async function generateAxum(
  options: GenerateAxumOptions = {},
): Promise<string> {
  const contract = await generateContract({
    routesDirs: options.routesDirs,
    config: options.config,
    convention: options.convention,
  });
  const source = renderAxum(contract, {
    source: (options.routesDirs ?? ["routes/api"]).join(", "),
  });
  if (options.output) await writeFile(options.output, source);
  return source;
}
