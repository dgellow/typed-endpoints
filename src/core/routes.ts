/**
 * Route discovery and naming shared by every generator.
 *
 * Routes follow Fresh's file-routing conventions: `[param]` segments,
 * `[...rest]` catch-alls, `(group)` folders, `index` files.
 *
 * File access goes through `node:` modules, which Deno, Bun and Node
 * provide alike.
 *
 * @module
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { HttpMethod } from "./types.ts";

export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

// =============================================================================
// Discovery
// =============================================================================

/** Check if a file should be skipped (tests, private, dotfiles). */
export function shouldSkipFile(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("_") ||
    name.includes("_test.") ||
    name.includes(".test.") ||
    name.endsWith("_test.ts") ||
    name.endsWith("_test.tsx")
  );
}

/**
 * The route files below `dir`, sorted by path.
 *
 * Follows symbolic links, skips hidden entries and the files
 * `shouldSkipFile` names. Paths are `dir` joined with `/`, whatever the
 * platform, because they are turned into URL paths.
 */
export async function listRouteFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      // Skip hidden files and directories
      if (entry.name.startsWith(".")) continue;

      const fullPath = `${current}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(fullPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // Broken symlink
        }
      }

      if (isDirectory) {
        await walk(fullPath);
      } else if (
        isFile && /\.(ts|tsx)$/.test(entry.name) && !shouldSkipFile(entry.name)
      ) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

/** The `file:` URL of a path, with symbolic links resolved. */
export async function fileUrlOf(path: string): Promise<string> {
  return pathToFileURL(await realpath(path)).href;
}

// =============================================================================
// Paths
// =============================================================================

/**
 * Convert a route file path to its URL path in file-route notation.
 * e.g. `src/routes/api/users/[id].ts` -> `/api/users/[id]`
 *
 * Everything up to and including the `routes` directory is dropped, so the
 * result is the same for relative, `./`-prefixed and absolute paths.
 */
export function filePathToApiPath(filePath: string): string {
  let path = filePath.replace(/\\/g, "/");

  // Extract from routes/ if present anywhere in path
  const routesIdx = path.indexOf("/routes/");
  if (routesIdx !== -1) {
    path = path.slice(routesIdx + "/routes".length);
  } else if (path.startsWith("routes/")) {
    path = "/" + path.slice("routes/".length);
  }

  path = path.replace(/\.(ts|tsx)$/, "");

  if (path.endsWith("/index")) {
    path = path.slice(0, -6) || "/";
  }

  // Strip route groups like (auth), (admin), etc.
  path = path.replace(/\/\([^)]+\)/g, "");

  return path;
}

/**
 * Convert file-route notation to a path template with `{param}` segments.
 * e.g. `/api/users/[id]` -> `/api/users/{id}`
 *
 * A catch-all `[...rest]` becomes `{rest}`: path templates have no
 * multi-segment parameter, so it is described as one parameter.
 */
export function apiPathToTemplate(apiPath: string): string {
  return apiPath
    .replace(/\[\.\.\.(\w+)\]/g, "{$1}")
    .replace(/\[(\w+)\]/g, "{$1}");
}

// =============================================================================
// Naming
// =============================================================================

/** Upper-case the first character. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith("[") || segment.startsWith(":");
}

/** Whether the last path segment is a parameter, e.g. `/users/[id]`. */
export function endsWithParam(path: string): boolean {
  return isParamSegment(path.split("/").filter(Boolean).at(-1) ?? "");
}

/**
 * Convert HTTP method + path pattern to resource method name.
 * - GET /users -> list
 * - GET /users/[id] -> retrieve
 * - GET /users/[id]/posts -> list
 * - POST /users -> create
 * - PUT/PATCH /users/[id] -> update
 * - DELETE /users/[id] -> delete
 */
export function httpMethodToResourceMethod(
  method: string,
  path: string,
): string {
  switch (method) {
    case "GET":
      return endsWithParam(path) ? "retrieve" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

/**
 * Convert a path like /api/users/[id]/posts to resource segments.
 * Returns: ["users", "posts"] (strips /api prefix and param segments)
 */
export function pathToResourceSegments(path: string): string[] {
  return path
    .replace(/^\/api\//, "") // Remove /api/ prefix
    .split("/")
    .filter((segment) => segment && !isParamSegment(segment));
}

/**
 * Derive an operationId from path and method.
 * E.g., POST /api/auth/login -> authLoginCreate
 * E.g., GET /api/users/[id] -> usersRetrieve
 *
 * The OpenAPI generator and the routes format both use it, so an operation
 * in the spec and its entry in the generated route table share one id.
 */
export function deriveOperationId(path: string, method: string): string {
  const baseName = pathToResourceSegments(path)
    .map((segment, i) => (i === 0 ? segment : capitalize(segment)))
    .join("");
  return baseName + capitalize(httpMethodToResourceMethod(method, path));
}
