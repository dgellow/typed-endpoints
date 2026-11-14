import { toPascalCase } from "./casing.ts";

export function pathToTypeName(path: string): string {
  const cleaned = path
    .replace(/^\/api\/(internal\/)?/, "")
    .replace(
      /\[(?:\.\.\.)?([^\]]+)\]/g,
      (_, p) => `By${p.charAt(0).toUpperCase()}${p.slice(1)}`,
    );
  return toPascalCase(cleaned);
}

export { filePathToApiPath } from "../core/routes.ts";
