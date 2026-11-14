/**
 * Loading a directory of route files into a routing table.
 *
 * Shared by the integrations for routers that take their routes from code
 * (`Bun.serve`, Hono, a plain fetch handler): the files follow the `fresh`
 * layout, `routes/api/users/[id].ts`, and export `handler`, an object with
 * one function per HTTP method.
 *
 * @module
 */

import { fileUrlOf, listRouteFiles, routeOfFile } from "./routes.ts";

/** One route file: where it is served and what it exports. */
export interface LoadedRoute<THandlers> {
  /** The file. */
  readonly filePath: string;
  /** URL path in file-route notation, e.g. `/api/users/[id]`. */
  readonly apiPath: string;
  /** The module's `handler` export. */
  readonly handlers: THandlers;
}

/**
 * Import every route file below `dir` that exports a `handler` object.
 *
 * Two files that serve the same path are an error that names both.
 */
export async function loadFileRoutes<THandlers extends object>(
  dir: string,
): Promise<LoadedRoute<THandlers>[]> {
  const routes: LoadedRoute<THandlers>[] = [];
  const seen = new Map<string, string>();

  for (const filePath of await listRouteFiles(dir)) {
    const mod = await import(await fileUrlOf(filePath)) as {
      handler?: THandlers;
    };
    if (!mod.handler || typeof mod.handler !== "object") continue;

    const { apiPath } = routeOfFile(filePath, "fresh")!;
    const other = seen.get(apiPath);
    if (other !== undefined) {
      throw new Error(
        `Two route files serve ${apiPath}: ${other} and ${filePath}`,
      );
    }
    seen.set(apiPath, filePath);
    routes.push({ filePath, apiPath, handlers: mod.handler });
  }
  return routes;
}

/** A segment of a path in file-route notation. */
export type PathSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "rest"; readonly name: string };

/** Split `/api/users/[id]/files/[...path]` into its segments. */
export function parseApiPath(apiPath: string): PathSegment[] {
  return apiPath.split("/").filter((s) => s !== "").map((segment) => {
    const rest = /^\[\.\.\.(\w+)\]$/.exec(segment);
    if (rest) return { kind: "rest", name: rest[1] };
    const param = /^\[(\w+)\]$/.exec(segment);
    if (param) return { kind: "param", name: param[1] };
    return { kind: "static", value: segment };
  });
}

/**
 * A path in file-route notation rewritten for a router: `param` and `rest`
 * say how that router spells a parameter and a catch-all.
 */
export function formatApiPath(
  apiPath: string,
  format: {
    readonly param: (name: string) => string;
    readonly rest: (name: string) => string;
  },
): string {
  const segments = parseApiPath(apiPath).map((segment) =>
    segment.kind === "static"
      ? segment.value
      : segment.kind === "param"
      ? format.param(segment.name)
      : format.rest(segment.name)
  );
  return "/" + segments.join("/");
}
