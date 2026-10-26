import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  stat,
  readFile,
  readdir,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, publishStagedFiles } from "../src/files.js";

test("atomic replacement preserves explicit permissions under a restrictive umask", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cma-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "file");
  await writeFile(path, "before", { mode: 0o640 });
  const old = process.umask(0o077);
  try {
    await atomicWrite(path, "after", 0o640);
  } finally {
    process.umask(old);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal(await readFile(path, "utf8"), "after");
  assert.deepEqual(await readdir(dir), ["file"]);
});

test("failed atomic publication removes its staging file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cma-atomic-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "directory");
  await mkdir(path);
  await assert.rejects(atomicWrite(path, "content"));
  assert.deepEqual(await readdir(dir), ["directory"]);
});

test("mid-publication failure rolls back prior file bytes and modes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cma-publish-rollback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stage = join(dir, "stage"),
    target = join(dir, "target");
  await mkdir(stage);
  await mkdir(target);
  await writeFile(join(stage, "a.txt"), "new");
  await writeFile(join(target, "a.txt"), "original", { mode: 0o640 });
  // The target name is valid, but its atomic staging suffix exceeds NAME_MAX.
  const longName = "z".repeat(220);
  await writeFile(join(stage, longName), "replacement");
  await writeFile(join(target, longName), "keep long file");
  await assert.rejects(publishStagedFiles(stage, target), {
    code: "ENAMETOOLONG",
  });
  assert.equal(await readFile(join(target, "a.txt"), "utf8"), "original");
  assert.equal((await stat(join(target, "a.txt"))).mode & 0o777, 0o640);
  assert.equal(
    await readFile(join(target, longName), "utf8"),
    "keep long file",
  );
  assert.deepEqual((await readdir(target)).sort(), ["a.txt", longName]);
});
