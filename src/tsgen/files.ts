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

export async function collectRouteFiles(
  baseDir: string,
  entry: Deno.DirEntry,
  files: string[],
): Promise<void> {
  if (entry.name.startsWith(".")) return;

  const fullPath = `${baseDir}/${entry.name}`;

  if (entry.isSymlink) {
    try {
      const stat = await Deno.stat(fullPath);
      if (stat.isDirectory) {
        for await (const subEntry of Deno.readDir(fullPath)) {
          await collectRouteFiles(fullPath, subEntry, files);
        }
      } else if (stat.isFile && /\.(ts|tsx)$/.test(entry.name)) {
        if (!shouldSkipFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch {
      // Broken symlink, skip
    }
    return;
  }

  if (entry.isDirectory) {
    for await (const subEntry of Deno.readDir(fullPath)) {
      await collectRouteFiles(fullPath, subEntry, files);
    }
  } else if (entry.isFile && /\.(ts|tsx)$/.test(entry.name)) {
    if (!shouldSkipFile(entry.name)) {
      files.push(fullPath);
    }
  }
}
