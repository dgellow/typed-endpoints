import { toPascalCase } from "./casing.ts";

export function pathToTypeName(path: string): string {
  const cleaned = path
    .replace(/^\/api\/(internal\/)?/, "")
    .replace(/\[([^\]]+)\]/g, (_, p) => `By${p.charAt(0).toUpperCase()}${p.slice(1)}`);
  return toPascalCase(cleaned);
}

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
