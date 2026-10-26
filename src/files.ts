import {
  mkdir,
  writeFile,
  chmod,
  rename,
  unlink,
  lstat,
  readFile,
  readdir,
  rmdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Replace complete bytes without exposing a truncated checkpoint. */
export async function atomicWrite(
  path: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.cma-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Publish a new directory in one rename, or merge generated files with rollback. */
export async function publishStagedFiles(
  stage: string,
  destination: string,
): Promise<void> {
  let exists = false;
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Invalid output directory: ${destination}`);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    await rename(stage, destination);
    return;
  }
  const files: Array<{
    path: string;
    staged: string;
    before: string | null;
    mode: number;
  }> = [];
  const directories: string[] = [];
  async function inspect(source: string, target: string) {
    for (const entry of (await readdir(source, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(target, entry.name),
        staged = join(source, entry.name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (info?.isSymbolicLink())
        throw new Error(`Refusing symlink output: ${path}`);
      if (entry.isDirectory()) {
        if (info && !info.isDirectory())
          throw new Error(`Expected output directory: ${path}`);
        if (!info) directories.push(path);
        await inspect(staged, path);
      } else {
        if (info && !info.isFile())
          throw new Error(`Expected output file: ${path}`);
        files.push({
          path,
          staged,
          before: info ? await readFile(path, "utf8") : null,
          mode: info ? info.mode & 0o777 : (await lstat(staged)).mode & 0o777,
        });
      }
    }
  }
  await inspect(stage, destination);
  const applied: typeof files = [];
  const created: string[] = [];
  try {
    for (const path of directories) {
      await mkdir(path);
      created.push(path);
    }
    for (const file of files) {
      await atomicWrite(
        file.path,
        await readFile(file.staged, "utf8"),
        file.mode,
      );
      applied.push(file);
    }
  } catch (error) {
    for (const file of applied.reverse()) {
      if (file.before === null) await unlink(file.path);
      else await atomicWrite(file.path, file.before, file.mode);
    }
    for (const path of created.reverse()) await rmdir(path);
    throw error;
  }
}
