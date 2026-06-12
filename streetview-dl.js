#!/usr/bin/env node
/*
 * streetview-dl - Google Street View equirectangular 360 panorama downloader
 *
 * Cross-platform Node.js CLI. The image pipeline lives in
 * lib/streetview.js and is shared with the web server (server.js).
 *
 * Original PHP version by fdd4s (public domain / Unlicense).
 * This rewrite is released into the public domain as well.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  DEFAULT_ZOOM,
  DEFAULT_CONCURRENCY,
  SIZES,
  extractPanoId,
  isValidPanoId,
  downloadTiles,
  buildPanorama,
  resizePanorama,
  withPanoXmp,
} from "./lib/streetview.js";

// Re-export the core for anything that imported it from here historically.
export {
  extractPanoId,
  gridForZoom,
  buildPanorama,
  resizePanorama,
  injectXmp,
  withPanoXmp,
} from "./lib/streetview.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    input: null,
    zoom: DEFAULT_ZOOM,
    outDir: process.cwd(),
    concurrency: DEFAULT_CONCURRENCY,
    keepTiles: false,
    panoId: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-z":
      case "--zoom":
        opts.zoom = parseInt(argv[++i], 10);
        break;
      case "-o":
      case "--out":
      case "--out-dir":
        opts.outDir = argv[++i];
        break;
      case "-c":
      case "--concurrency":
        opts.concurrency = parseInt(argv[++i], 10);
        break;
      case "-p":
      case "--panoid":
      case "--pano-id":
      case "--id":
        opts.panoId = argv[++i];
        break;
      case "--keep-tiles":
        opts.keepTiles = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        rest.push(a);
    }
  }
  opts.input = rest[0] ?? null;
  return opts;
}

function printHelp() {
  console.log(`streetview-dl - download Google Street View 360 equirectangular panoramas

Usage:
  streetview-dl --panoid <id> [options]
  streetview-dl <url-or-panoid> [options]

You must supply a panorama id, either with the --panoid option or as a
positional argument (a Street View URL or a raw id). With no id the tool prints
this help; with an invalid id the run ends with "No tiles downloaded".

Options:
  -p, --panoid <id>      Panorama id to download (required if not given positionally)
  -z, --zoom <n>         Tile zoom level (0-5). Higher = more detail. Default: ${DEFAULT_ZOOM}
  -o, --out <dir>        Output directory. Default: current directory
  -c, --concurrency <n>  Parallel tile downloads. Default: ${DEFAULT_CONCURRENCY}
      --keep-tiles       Keep the raw downloaded tiles (debug)
  -h, --help             Show this help

Examples:
  streetview-dl --panoid <PANO_ID>
  streetview-dl --panoid <PANO_ID> --zoom 5 --out ./panos
  streetview-dl "<Street View URL>"

Outputs (in the output directory):
  stl-<id>.jpg           Full resolution panorama
  stm-<id>.jpg           ${SIZES.medium.maxWidth} px wide resize
  sts-<id>.jpg           ${SIZES.small.maxWidth} px wide resize
All outputs carry GPano XMP metadata so 360 viewers recognise them.

For a browser UI instead of the CLI, run:  npm start`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const hasInput = Boolean(opts.panoId || opts.input);
  if (opts.help || !hasInput) {
    printHelp();
    if (!opts.help && !hasInput) {
      console.error(
        "\nNo panorama id given. Pass --panoid <id> (or a URL/id argument)."
      );
    }
    process.exit(hasInput ? 0 : 1);
  }

  if (!Number.isInteger(opts.zoom) || opts.zoom < 0 || opts.zoom > 5) {
    console.error("zoom must be an integer between 0 and 5");
    process.exit(1);
  }

  // The --panoid option takes precedence; otherwise extract from the argument.
  const panoId = opts.panoId
    ? extractPanoId(opts.panoId)
    : extractPanoId(opts.input);
  if (!isValidPanoId(panoId)) {
    console.error("Could not determine a valid panorama id.");
    process.exit(1);
  }

  console.log(`pano id: ${panoId}`);
  console.log(`zoom: ${opts.zoom}`);

  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  // 1. Download tiles (with a stdout progress line)
  console.log("Downloading...");
  let lastPct = -1;
  const { tiles, cols, rows } = await downloadTiles(
    panoId,
    opts.zoom,
    opts.concurrency,
    (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(
          `\r  downloading tiles... ${pct}% (${done}/${total})`
        );
      }
    }
  );
  process.stdout.write("\n");
  console.log(
    `  got ${tiles.length}/${cols * rows} tiles (grid ${cols}x${rows})`
  );

  if (opts.keepTiles) {
    const tilesDir = join(outDir, `tiles-${panoId}`);
    await mkdir(tilesDir, { recursive: true });
    await Promise.all(
      tiles.map((t) =>
        writeFile(join(tilesDir, `tile-${t.x}-${t.y}.jpg`), t.buf)
      )
    );
    console.log(`  raw tiles saved to ${tilesDir}`);
  }

  // 2. Composite full-resolution panorama
  console.log("Compositing...");
  const { buf: fullBuf, width, height } = await buildPanorama(
    tiles,
    cols,
    rows
  );
  console.log(`  panorama ${width}x${height}`);

  // 3. Write outputs (full + resizes), each with GPano XMP metadata
  const pathL = join(outDir, `${SIZES.full.prefix}-${panoId}.jpg`);
  await writeFile(pathL, withPanoXmp(fullBuf, width, height));
  console.log(`${pathL} created`);

  for (const key of ["medium", "small"]) {
    const w = Math.min(SIZES[key].maxWidth, width);
    const h = Math.round(w / 2);
    const resized = await resizePanorama(fullBuf, w);
    const p = join(outDir, `${SIZES[key].prefix}-${panoId}.jpg`);
    await writeFile(p, withPanoXmp(resized, w, h));
    console.log(`${p} created (${w}x${h})`);
  }

  console.log("done");
}

// Only run the CLI when executed directly (not when imported).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    process.stdout.write("\n");
    console.error("Error:", err.message);
    // Set the exit code and let the event loop drain naturally; process.exit()
    // here can abort while fetch/sharp native handles are still open, which
    // trips a libuv assertion during teardown.
    process.exitCode = 1;
  });
}
