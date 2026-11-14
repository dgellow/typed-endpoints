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
import { readModuleApi } from "../core/module_api.ts";
import { TypeDeclarations, zodToTypeString } from "./zod.ts";

/** A route file to import. */
export interface RouteSource {
  /** Path as discovered on disk; used in messages. */
  readonly filePath: string;
  /** Module URL to import. */
  readonly url: string;
  /** URL path in file-route notation, e.g. `/api/users/[id]`. */
  readonly apiPath: string;
  /** HTTP method, when the file name states it (Nitro). */
  readonly method?: string;
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
  /**
   * Bodies of the error responses the method declares (`responses` with a
   * status of 400 or above), by status, output side, as JSON carries them.
   */
  readonly errors?: Readonly<Record<string, string>>;
  /** Pagination metadata set by the pagination helpers. */
  readonly pagination?: unknown;
  readonly operationId?: string;
  /**
   * The same parts as JSON Schema, for generators that do not write
   * TypeScript. Present when the extraction was asked for it.
   */
  readonly schemas?: MethodSchemas;
  /** One-line summary of the operation. */
  readonly summary?: string;
  /** Description of the operation. */
  readonly description?: string;
  /** Tags of the operation. */
  readonly tags?: readonly string[];
}

/** A JSON Schema document (draft 2020-12). */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * The schemas of a method as JSON Schema. Request parts describe what a
 * client sends (the input side of the Zod schema); responses, error bodies
 * and events describe what JSON carries (the output side). A part JSON
 * Schema cannot state (the result of a `transform()`, a `Date`) is `{}`,
 * which accepts anything.
 */
export interface MethodSchemas {
  readonly body?: JsonSchema;
  readonly query?: JsonSchema;
  readonly params?: JsonSchema;
  readonly response?: JsonSchema;
  /** Declared error bodies, by status. */
  readonly errors?: Readonly<Record<string, JsonSchema>>;
  /** SSE events, by name. */
  readonly events?: Readonly<Record<string, JsonSchema>>;
}

/** Options of `extractRoutes()`. */
export interface ExtractOptions {
  /** Also describe every schema as JSON Schema (`ExtractedMethod.schemas`). */
  readonly jsonSchema?: boolean;
}

export interface ExtractedRoute {
  readonly filePath: string;
  /** URL path in file-route notation. */
  readonly apiPath: string;
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
  readonly responses?: Record<
    string,
    ZodType | { readonly schema: ZodType; readonly name?: string }
  >;
  readonly __pagination?: unknown;
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/**
 * The JSON Schema of a Zod schema, through the interface every Zod 4.2+
 * schema carries (Standard Schema). No import of `zod` is needed, which
 * this module, loaded by URL into the user's context, could not rely on.
 */
function jsonSchemaOf(schema: ZodType, io: "input" | "output"): JsonSchema {
  const standard = (schema as unknown as {
    "~standard"?: {
      jsonSchema?: Record<
        "input" | "output",
        (options: Record<string, unknown>) => JsonSchema
      >;
    };
  })["~standard"]?.jsonSchema;
  if (!standard) {
    throw new Error(
      "the schema has no JSON Schema interface; it needs Zod 4.2 or later",
    );
  }
  return standard[io]({
    target: "draft-2020-12",
    // What JSON Schema cannot state becomes `{}` instead of an error.
    libraryOptions: { unrepresentable: "any" },
  });
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
  options: ExtractOptions = {},
): Promise<Extraction> {
  const declarations = new TypeDeclarations();
  const dependentOnly: string[] = [];
  const routes: ExtractedRoute[] = [];

  for (const source of sources) {
    let mod: unknown;
    try {
      mod = await import(source.url);
    } catch (cause) {
      throw new Error(
        `Failed to import ${source.filePath}: ${message(cause)}`,
        { cause },
      );
    }

    const apiDef = readModuleApi(mod, source.method) as
      | Record<string, MethodDefLike>
      | undefined;
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

      // A query schema without fields (the URL pagination style has one)
      // describes no parameter: it is left out, not written as `{}`.
      const withFields = (query: string | undefined) =>
        query === undefined || query === "{}" ? {} : { query };

      // Declared error responses: status 400 and above. Other entries of
      // `responses` describe successes, which `response` already covers.
      const errors = Object.fromEntries(
        Object.entries(def.responses ?? {})
          .filter(([status]) => Number(status) >= 400)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([status, value]) => [
            status,
            render(
              `response ${status}`,
              "schema" in value ? value.schema : value,
              "output",
              "json",
            ),
          ]),
      );

      const describe = (
        part: string,
        schema: ZodType,
        io: "input" | "output",
      ): JsonSchema => {
        try {
          return jsonSchemaOf(schema, io);
        } catch (cause) {
          throw new Error(
            `${method} ${source.filePath}, ${part}: ${message(cause)}`,
            { cause },
          );
        }
      };
      const declared = Object.entries(def.responses ?? {})
        .filter(([status]) => Number(status) >= 400)
        .sort(([a], [b]) => Number(a) - Number(b));
      const schemas: MethodSchemas | undefined = options.jsonSchema
        ? {
          ...(def.body && { body: describe("body", def.body, "input") }),
          ...(def.query && { query: describe("query", def.query, "input") }),
          ...(def.params &&
            { params: describe("params", def.params, "input") }),
          ...(def.response &&
            { response: describe("response", def.response, "output") }),
          ...(declared.length > 0 && {
            errors: Object.fromEntries(
              declared.map(([status, value]) => [
                status,
                describe(
                  `response ${status}`,
                  "schema" in value ? value.schema : value,
                  "output",
                ),
              ]),
            ),
          }),
          ...(def.events && {
            events: Object.fromEntries(
              Object.entries(def.events).map(([name, schema]) => [
                name,
                describe(`event "${name}"`, schema, "output"),
              ]),
            ),
          }),
        }
        : undefined;

      methods[method] = {
        ...(def.body && { body: render("body", def.body, "input", "json") }),
        ...withFields(def.query && render("query", def.query, "input")),
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
        ...(Object.keys(errors).length > 0 && { errors }),
        ...(def.__pagination !== undefined && {
          pagination: def.__pagination,
        }),
        ...(def.operationId && { operationId: def.operationId }),
        ...(schemas && { schemas }),
        ...(def.summary && { summary: def.summary }),
        ...(def.description && { description: def.description }),
        ...(def.tags && { tags: def.tags }),
      };
    }

    routes.push({
      filePath: source.filePath,
      apiPath: source.apiPath,
      methods,
    });
  }

  return {
    routes,
    declarations: declarations.entries(),
    helpers: [...declarations.helpers].sort(),
    dependentOnly,
  };
}
