/**
 * Route extraction: import route modules and describe their endpoints as
 * plain, serialisable data.
 *
 * This module runs in two places: in the calling process, and in a
 * subprocess started with the user's `deno.json` so that route files resolve
 * their own import map. In the second case it is imported by URL into the
 * user's context, so it must only import by relative path.
 *
 * @module
 */

import type { ZodType } from "zod";
import { TypeDeclarations, zodToTypeString } from "./zod.ts";

/** A route file to import. */
export interface RouteSource {
  /** Path as discovered on disk; used in messages and to derive the URL path. */
  readonly filePath: string;
  /** Module URL to import. */
  readonly url: string;
}

/** One HTTP method of a route, with its schemas rendered as type text. */
export interface ExtractedMethod {
  /** Request body, input side, as JSON carries it. */
  readonly body?: string;
  /** Query parameters, input side. */
  readonly query?: string;
  /** Path parameters, input side. */
  readonly params?: string;
  /** Response body, output side, as JSON carries it. */
  readonly response?: string;
  /**
   * The response body with its request-dependent places written as
   * `Dependent<...>`. Present only when the response has such places.
   */
  readonly dependentResponse?: string;
  /** SSE events by name, output side, as JSON carries them. */
  readonly events?: Readonly<Record<string, string>>;
  /** Pagination metadata set by the pagination helpers. */
  readonly pagination?: unknown;
  readonly operationId?: string;
}

export interface ExtractedRoute {
  readonly filePath: string;
  readonly methods: Readonly<Record<string, ExtractedMethod>>;
}

export interface Extraction {
  /** Routes that define an API, in the order the sources were given. */
  readonly routes: readonly ExtractedRoute[];
  /** Named types referenced by the type texts: `[name, type text]`. */
  readonly declarations: readonly (readonly [string, string])[];
  /** Helper types the `dependentResponse` texts refer to. */
  readonly helpers: readonly string[];
  /**
   * Names in `declarations` that only `dependentResponse` texts refer to.
   * Output that does not use those texts leaves them out.
   */
  readonly dependentOnly: readonly string[];
}

interface MethodDefLike {
  readonly body?: ZodType;
  readonly query?: ZodType;
  readonly params?: ZodType;
  readonly response?: ZodType;
  readonly events?: Record<string, ZodType>;
  readonly __pagination?: unknown;
  readonly operationId?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import each route module and render its schemas.
 *
 * Fails on the first module that cannot be imported or described; the error
 * names the file.
 */
export async function extractRoutes(
  sources: readonly RouteSource[],
): Promise<Extraction> {
  const declarations = new TypeDeclarations();
  const dependentOnly: string[] = [];
  const routes: ExtractedRoute[] = [];

  for (const source of sources) {
    let mod: { handler?: { __apiDef?: Record<string, MethodDefLike> } };
    try {
      mod = await import(source.url);
    } catch (cause) {
      throw new Error(
        `Failed to import ${source.filePath}: ${message(cause)}`,
        { cause },
      );
    }

    const apiDef = mod.handler?.__apiDef;
    if (!apiDef) continue;

    const methods: Record<string, ExtractedMethod> = {};
    for (const [method, def] of Object.entries(apiDef)) {
      if (!def) continue;

      const render = (
        part: string,
        schema: ZodType,
        io: "input" | "output",
        wire?: "json",
      ): string => {
        try {
          return zodToTypeString(schema, { io, wire, declarations });
        } catch (cause) {
          throw new Error(
            `${method} ${source.filePath}, ${part}: ${message(cause)}`,
            { cause },
          );
        }
      };

      // A second rendering of the response that keeps the dependency on
      // the request. It differs from the first only when the response has
      // dependent places, which is when it names a helper type.
      let dependentResponse: string | undefined;
      if (def.response) {
        const scratch = new TypeDeclarations();
        try {
          zodToTypeString(def.response, {
            io: "output",
            wire: "json",
            declarations: scratch,
            dependent: "families",
          });
        } catch {
          // Reported by the plain rendering below.
        }
        if (scratch.helpers.size > 0) {
          const known = new Set(declarations.entries().map(([name]) => name));
          try {
            dependentResponse = zodToTypeString(def.response, {
              io: "output",
              wire: "json",
              declarations,
              dependent: "families",
            });
            for (const [name] of declarations.entries()) {
              if (!known.has(name)) dependentOnly.push(name);
            }
          } catch (cause) {
            throw new Error(
              `${method} ${source.filePath}, response: ${message(cause)}`,
              { cause },
            );
          }
        }
      }

      methods[method] = {
        ...(def.body && { body: render("body", def.body, "input", "json") }),
        ...(def.query && { query: render("query", def.query, "input") }),
        ...(def.params && { params: render("params", def.params, "input") }),
        ...(def.response && {
          response: render("response", def.response, "output", "json"),
        }),
        ...(dependentResponse !== undefined && { dependentResponse }),
        ...(def.events && {
          events: Object.fromEntries(
            Object.entries(def.events).map(([name, schema]) => [
              name,
              render(`event "${name}"`, schema, "output", "json"),
            ]),
          ),
        }),
        ...(def.__pagination !== undefined && {
          pagination: def.__pagination,
        }),
        ...(def.operationId && { operationId: def.operationId }),
      };
    }

    routes.push({ filePath: source.filePath, methods });
  }

  return {
    routes,
    declarations: declarations.entries(),
    helpers: [...declarations.helpers].sort(),
    dependentOnly,
  };
}
