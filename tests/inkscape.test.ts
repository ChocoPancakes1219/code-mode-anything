import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// The module adapter is intentionally JavaScript so generated packages need no build step.
const { createAdapter } = await import("../examples/inkscape/adapter.mjs");

test("Inkscape adapter validates arguments before attempting the external binary", async () => {
  const adapter = createAdapter();
  await assert.rejects(
    adapter.call("export_png", { input: "file.pdf", output: "file.png" }),
    /\.svg/,
  );
  await assert.rejects(
    adapter.call("export_png", {
      input: "file.svg",
      output: "file.png",
      width: 0,
    }),
    /width/,
  );
  await assert.rejects(
    adapter.call("export_png", {
      input: "file.svg",
      output: "file.png",
      width: 4097,
    }),
    /width/,
  );
  await assert.rejects(adapter.call("unknown", {}), /Unknown operation/);
});
test("Inkscape adapter preserves pre-existing output files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cma-inkscape-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.svg"),
    output = join(dir, "existing.png");
  await writeFile(input, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(output, "keep this content");
  await assert.rejects(
    createAdapter().call("export_png", { input, output }),
    /exist/i,
  );
  assert.equal(await readFile(output, "utf8"), "keep this content");
});
test("missing real Inkscape binary fails clearly and removes only newly reserved output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cma-inkscape-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.svg"),
    output = join(dir, "new.png");
  await writeFile(input, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const previous = process.env.INKSCAPE_BIN;
  process.env.INKSCAPE_BIN = join(dir, "binary-not-installed");
  try {
    const adapter = createAdapter();
    await assert.rejects(
      adapter.call("info", {}),
      /Install Inkscape|INKSCAPE_BIN/,
    );
    await assert.rejects(
      adapter.call("export_png", { input, output }),
      /Install Inkscape|INKSCAPE_BIN/,
    );
    await assert.rejects(access(output), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.INKSCAPE_BIN;
    else process.env.INKSCAPE_BIN = previous;
  }
});
