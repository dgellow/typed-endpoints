/**
 * The contract: the routes as language-neutral data.
 *
 * The TypeScript generators render a route's schemas as TypeScript type
 * text. A generator for another language needs them as data. A contract
 * lists every operation of the routes with its method, path template and
 * a JSON Schema (draft 2020-12) for each part, plus what JSON Schema does
 * not carry: which error statuses the operation declares, and how its
 * list is paginated.
 *
 * Request parts (path parameters, query, body) describe what a client
 * sends: the input side of the Zod schema. The response, the declared
 * error bodies and SSE events describe what JSON carries: the output
 * side. A part JSON Schema cannot state (the result of a `transform()`, a
 * `Date`) is `{}`, which accepts anything: the function that produces it
 * is TypeScript code and does not cross to another language.
 *
 * @module
 */

import { writeFile } from "node:fs/promises";

import { apiPathToClientTemplate, deriveOperationId } from "../core/routes.ts";
import type { AnyPaginationMeta } from "../pagination/types.ts";
import type { JsonSchema } from "../tsgen/extract.ts";
import { loadEndpoints, type RouteOptions } from "../tsgen/generate.ts";

export type { JsonSchema } from "../tsgen/extract.ts";

/** A parameter of a path template. */
export interface ContractPathParam {
  /** Name of the parameter, as in the template. */
  readonly name: string;
  /** Whether it takes the rest of the path, slashes included (`{+name}`). */
  readonly catchAll: boolean;
}

/** One HTTP method of one path. */
export interface ContractOperation {
  /**
   * Identifier of the operation: the one the endpoint sets, else the one
   * derived from path and method. The OpenAPI spec and the generated route
   * table use the same.
   */
  readonly operationId: string;
  /** HTTP method, upper case. */
  readonly method: string;
  /**
   * Path as a URI template: `/api/users/{id}`; a catch-all is
   * `/api/files/{+path}` (RFC 6570 reserved expansion).
   */
  readonly path: string;
  /** The parameters of the path, in order. */
  readonly pathParams: readonly ContractPathParam[];
  /** Schema of the path parameters, if the endpoint declares one. */
  readonly params?: JsonSchema;
  /** Schema of the query parameters. */
  readonly query?: JsonSchema;
  /** Schema of the JSON request body. */
  readonly body?: JsonSchema;
  /** Schema of the JSON response body of a success. */
  readonly response?: JsonSchema;
  /** Schemas of the declared error bodies, by status (400 and above). */
  readonly errors?: Readonly<Record<string, JsonSchema>>;
  /** For a server-sent event stream: the schema of each event's data. */
  readonly events?: Readonly<Record<string, JsonSchema>>;
  /**
   * For an event stream: after this many milliseconds without an event,
   * the server writes a comment so that intermediaries keep the
   * connection open.
   */
  readonly keepAlive?: number;
  /** How the list this operation returns is paginated. */
  readonly pagination?: AnyPaginationMeta;
  /** One-line summary. */
  readonly summary?: string;
  /** Description. */
  readonly description?: string;
  /** Tags. */
  readonly tags?: readonly string[];
}

/** Every operation of a set of routes. */
export interface Contract {
  /** Version of this format. */
  readonly version: 1;
  /** The operations, ordered by path, then by method. */
  readonly operations: readonly ContractOperation[];
}

/** Options of `generateContract()`. */
export interface ContractOptions extends RouteOptions {
  /** File to write the contract to, as JSON. */
  readonly output?: string;
}

/**
 * Describe the routes of a directory as a contract.
 *
 * @example
 * ```ts
 * const contract = await generateContract({ routesDirs: ["routes/api"] });
 * contract.operations[0].operationId; // "usersList"
 * ```
 */
export async function generateContract(
  options: ContractOptions = {},
): Promise<Contract> {
  const { endpoints } = await loadEndpoints(options, { jsonSchema: true });

  const operations: ContractOperation[] = [];
  const seen = new Map<string, string>();

  for (const endpoint of endpoints) {
    const operationId = endpoint.operationId ??
      deriveOperationId(endpoint.path, endpoint.method, endpoint.siblings);
    const where = `${endpoint.method} ${endpoint.path}`;
    const other = seen.get(operationId);
    if (other !== undefined) {
      throw new Error(
        `Two operations have the id "${operationId}": ${other} and ${where}. Set a distinct \`operationId\` on one of them.`,
      );
    }
    seen.set(operationId, where);

    const path = apiPathToClientTemplate(endpoint.path);
    const schemas = endpoint.schemas ?? {};
    operations.push({
      operationId,
      method: endpoint.method,
      path,
      pathParams: [...path.matchAll(/\{(\+?)(\w+)\}/g)].map((match) => ({
        name: match[2],
        catchAll: match[1] === "+",
      })),
      ...(schemas.params && { params: schemas.params }),
      ...(schemas.query && { query: schemas.query }),
      ...(schemas.body && { body: schemas.body }),
      ...(schemas.response && { response: schemas.response }),
      ...(schemas.errors && { errors: schemas.errors }),
      ...(schemas.events && { events: schemas.events }),
      ...(endpoint.keepAlive !== undefined &&
        { keepAlive: endpoint.keepAlive }),
      ...(endpoint.pagination && { pagination: endpoint.pagination }),
      ...(endpoint.summary && { summary: endpoint.summary }),
      ...(endpoint.description && { description: endpoint.description }),
      ...(endpoint.tags && { tags: endpoint.tags }),
    });
  }

  operations.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path)
  );

  const contract: Contract = { version: 1, operations };
  if (options.output) {
    await writeFile(options.output, JSON.stringify(contract, null, 2) + "\n");
  }
  return contract;
}

/**
 * The schema of the items of a paginated response.
 *
 * @param response The schema of the response.
 * @param path Where the items are in it: a field, or a dotted path.
 */
export function itemsSchema(
  response: JsonSchema,
  path: string,
): JsonSchema | undefined {
  const defs = (response.$defs ?? {}) as Record<string, JsonSchema>;
  const resolve = (schema: JsonSchema | undefined): JsonSchema | undefined => {
    if (schema && typeof schema.$ref === "string") {
      return schema.$ref === "#"
        ? response
        : defs[schema.$ref.replace(/^#\/\$defs\//, "")];
    }
    return schema;
  };

  let current = resolve(response);
  for (const key of path.split(".")) {
    const properties = current?.properties as
      | Record<string, JsonSchema>
      | undefined;
    current = resolve(properties?.[key]);
  }
  const items = current?.items;
  if (!items || typeof items !== "object") return undefined;
  return { ...(items as JsonSchema), $defs: defs };
}
