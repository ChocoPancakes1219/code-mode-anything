# Inkscape reference

Supported operations: `info` and `export_png`. Requires actual Inkscape on PATH
or an INKSCAPE_BIN executable path. The adapter invokes its native renderer,
preserves existing output files, and verifies PNG signature/IHDR dimensions.

```bash
cma install --agent codex --manifest examples/inkscape/manifest.json --non-interactive
cma run --code 'return await tools.inkscape.info({});'
cma run --code 'return await tools.inkscape.export_png({input:"examples/inkscape/sample.svg",output:"/tmp/cma-render.png",width:640});'
```

Use an existing output directory and a new PNG filename. Keep the source/installed
package available: installation stores an absolute reference to adapter.mjs.
This is a narrow integration, not full editor coverage.

Live export has not been run here: the Inkscape binary is unavailable. Argument,
existing-file, and missing-binary behavior is covered by tests. Run the real export
on an Inkscape host and record its output before claiming backend verification.
