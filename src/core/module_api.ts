/**
 * How a route module exposes its method definitions.
 *
 * Frameworks disagree on what a route module exports:
 *
 * - Fresh, Bun, Hono, plain fetch: one `handler` object with a function per
 *   HTTP method.
 * - Next.js, SvelteKit, Astro: one named export per HTTP method (`GET`,
 *   `POST`); other exports are rejected by the framework.
 * - Nitro: a default export; the method is in the file name.
 *
 * The integrations attach the definitions where each shape can carry them:
 * `__apiDef` on a handler object, `__methodDef` on a handler function.
 * `readModuleApi()` reads all three shapes.
 *
 * No imports: the type generator loads this file by URL into a subprocess.
 *
 * @module
 */

/** HTTP methods a route module can define, in output order. */
export const MODULE_METHODS: readonly string[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

function methodDefOf(value: unknown): unknown {
  if (typeof value !== "function" && typeof value !== "object") {
    return undefined;
  }
  if (value === null) return undefined;
  return (value as { __methodDef?: unknown }).__methodDef;
}

/**
 * The method definitions of a route module, by HTTP method, or `undefined`
 * when the module defines none.
 *
 * @param mod The imported module.
 * @param method The method the file name states (Nitro's `users.get.ts`),
 *   for a module whose default export handles one method.
 */
export function readModuleApi(
  mod: unknown,
  method?: string,
): Record<string, unknown> | undefined {
  if (typeof mod !== "object" || mod === null) return undefined;
  const exports = mod as Record<string, unknown>;

  // A handler object.
  const handler = exports.handler as { __apiDef?: unknown } | undefined;
  if (handler && typeof handler.__apiDef === "object" && handler.__apiDef) {
    return handler.__apiDef as Record<string, unknown>;
  }

  // One export per method.
  const byExport: Record<string, unknown> = {};
  for (const name of MODULE_METHODS) {
    const def = methodDefOf(exports[name]);
    if (def !== undefined) byExport[name] = def;
  }
  if (Object.keys(byExport).length > 0) return byExport;

  // A default export for the method the file name states.
  const def = methodDefOf(exports.default);
  if (def !== undefined && method !== undefined) return { [method]: def };

  return undefined;
}
