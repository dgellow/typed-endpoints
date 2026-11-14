/**
 * Python from routes: Pydantic models and a FastAPI router.
 *
 * @example
 * ```ts
 * import { generateFastApi } from "@dgellow/typed-endpoints/python";
 *
 * await generateFastApi({
 *   routesDirs: ["routes/api"],
 *   output: "server/api_generated.py",
 * });
 * ```
 *
 * @module
 */

import { writeFile } from "node:fs/promises";

import { generateContract } from "../contract/index.ts";
import type { RouteOptions } from "../tsgen/generate.ts";
import { renderFastApi } from "./fastapi.ts";

export { renderFastApi } from "./fastapi.ts";
export type { FastApiOptions } from "./fastapi.ts";
export {
  pascalCase,
  pythonLiteral,
  PythonModels,
  snakeCase,
} from "./models.ts";

/** Options of `generateFastApi()`. */
export interface GenerateFastApiOptions extends RouteOptions {
  /** File to write the Python module to. */
  readonly output?: string;
}

/**
 * Generate a Python module with Pydantic models, a `Handlers` protocol
 * and a FastAPI router for the routes of a directory.
 *
 * @returns The source of the module.
 */
export async function generateFastApi(
  options: GenerateFastApiOptions = {},
): Promise<string> {
  const contract = await generateContract({
    routesDirs: options.routesDirs,
    config: options.config,
    convention: options.convention,
  });
  const source = renderFastApi(contract, {
    source: (options.routesDirs ?? ["routes/api"]).join(", "),
  });
  if (options.output) await writeFile(options.output, source);
  return source;
}
