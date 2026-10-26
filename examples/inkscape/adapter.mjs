import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, stat, rm } from "node:fs/promises";
import { resolve, extname } from "node:path";
const execute = promisify(execFile);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function inkscape(args, signal) {
  try {
    return await execute(process.env.INKSCAPE_BIN || "inkscape", args, {
      signal,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Inkscape executable is unavailable. Install Inkscape or set INKSCAPE_BIN to its executable path.",
      );
    throw new Error(`Inkscape failed: ${error.message}`, { cause: error });
  }
}
function filePath(value, extension, name) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    extname(value).toLowerCase() !== extension
  )
    throw new Error(`${name} must be a ${extension} file path`);
  return resolve(value);
}
/** Trusted host adapter: operates on local files with the current user's permissions. */
export function createAdapter() {
  return {
    async call(operation, args = {}, signal) {
      if (operation === "info") {
        const result = await inkscape(["--version"], signal);
        return { version: result.stdout.trim(), capabilities: ["export_png"] };
      }
      if (operation !== "export_png")
        throw new Error(`Unknown operation: ${operation}`);
      const input = filePath(args.input, ".svg", "input");
      const output = filePath(args.output, ".png", "output");
      if (
        args.width !== undefined &&
        (!Number.isInteger(args.width) || args.width < 1 || args.width > 4096)
      )
        throw new Error("width must be an integer from 1 to 4096");
      signal?.throwIfAborted();
      if (!(await stat(input)).isFile())
        throw new Error("input must be a regular .svg file");
      // Reserve the output exclusively. Never replace a file supplied by the user.
      let reserved;
      try {
        reserved = await open(output, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new Error("Output already exists; choose a new .png path");
        throw error;
      }
      await reserved.close();
      try {
        const command = ["--export-type=png", `--export-filename=${output}`];
        if (args.width !== undefined)
          command.push(`--export-width=${args.width}`);
        command.push(input);
        await inkscape(command, signal);
        const info = await stat(output);
        const handle = await open(output, "r");
        const png = Buffer.alloc(24);
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(png, 0, 24, 0));
        } finally {
          await handle.close();
        }
        if (
          bytesRead < 24 ||
          !png.subarray(0, 8).equals(signature) ||
          png.toString("ascii", 12, 16) !== "IHDR" ||
          png.readUInt32BE(8) !== 13
        )
          throw new Error("Inkscape output is not a valid PNG header");
        const width = png.readUInt32BE(16),
          height = png.readUInt32BE(20);
        if (
          width < 1 ||
          height < 1 ||
          (args.width !== undefined && width !== args.width)
        )
          throw new Error(
            "Inkscape PNG dimensions are invalid or differ from requested width",
          );
        return { output, bytes: info.size, width, height };
      } catch (error) {
        await rm(output, { force: true });
        throw error;
      }
    },
  };
}
