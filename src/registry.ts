import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CmaError } from "./errors.js";
export interface CatalogEntry {
  name: string;
  description: string;
  manifest: string;
  prerequisites?: string[];
}
export async function loadCatalog(
  path = fileURLToPath(new URL("../catalog.json", import.meta.url)),
): Promise<CatalogEntry[]> {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.harnesses))
    throw new CmaError(
      "INVALID_CATALOG",
      "Catalog requires schemaVersion 1 and a harnesses array.",
    );
  return catalog.harnesses.map((entry: CatalogEntry) => {
    if (!entry.name || !entry.description || !entry.manifest)
      throw new CmaError("INVALID_CATALOG", "Invalid catalog entry.");
    return { ...entry, manifest: resolve(dirname(path), entry.manifest) };
  });
}
export async function findCatalogEntry(
  name: string,
  path?: string,
): Promise<CatalogEntry> {
  const found = (await loadCatalog(path)).find((entry) => entry.name === name);
  if (!found)
    throw new CmaError("NOT_FOUND", `No catalog harness named ${name}.`);
  return found;
}
