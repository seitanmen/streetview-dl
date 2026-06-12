#!/usr/bin/env node
/*
 * streetview-dl - Google Street View equirectangular 360 panorama downloader
 *
 * Cross-platform Node.js rewrite.
 * Pure npm dependencies: only `sharp`. No aria2 / ImageMagick / exiftool needed.
 *
 * Original PHP version by fdd4s (public domain / Unlicense).
 * This rewrite is released into the public domain as well.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import sharp from "sharp";

// --- Configuration defaults -------------------------------------------------

const TILE_URL = "https://streetviewpixels-pa.googleapis.com/v1/tile";
const DEFAULT_ZOOM = 5;
const DEFAULT_CONCURRENCY = 8;
const TILE_RETRIES = 3;
// Output widths (height is always width/2 for equirectangular 2:1 images).
const RESIZE_WIDTHS = [8192, 1300];

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
positional argument (a Street View URL or a raw id). Without a valid panorama
id, no tiles can be fetched and the run ends with "No tiles downloaded".

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
  stm-<id>.jpg           ${RESIZE_WIDTHS[0]} px wide resize
  sts-<id>.jpg           ${RESIZE_WIDTHS[1]} px wide resize
All outputs carry GPano XMP metadata so 360 viewers recognise them.`);
}

// ---------------------------------------------------------------------------
// Panorama id extraction
// ---------------------------------------------------------------------------

export function extractPanoId(input) {
  if (!input) return null;
  // Raw id (no URL characters): accept as-is.
  if (!input.includes("/") && !input.includes("!") && !input.includes("?")) {
    return input;
  }
  // Pattern 1: .../data=...!1s<ID>!...
  let m = input.match(/!1s([^!]+)!/);
  if (m) return decodeURIComponent(m[1]);
  // Pattern 2: ?panoid=<ID>  /  &panoid=<ID>
  m = input.match(/[?&]panoid=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  // Pattern 3: trailing !1s<ID> with no closing !
  m = input.match(/!1s([^!?&/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Tile grid geometry
// ---------------------------------------------------------------------------

// Google Street View tiles are addressed on a grid that doubles each zoom step.
// At zoom z the full equirectangular image is (2^z) x (2^(z-1)) tiles.
export function gridForZoom(zoom) {
  const cols = Math.pow(2, zoom);
  const rows = Math.pow(2, Math.max(0, zoom - 1));
  return { cols, rows };
}

function tileUrl(panoId, x, y, zoom) {
  const qs = new URLSearchParams({
    cb_client: "maps_sv.tactile",
    panoid: panoId,
    x: String(x),
    y: String(y),
    zoom: String(zoom),
    nbt: "1",
    fover: "2",
  });
  return `${TILE_URL}?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

async function fetchTile(panoId, x, y, zoom) {
  const url = tileUrl(panoId, x, y, zoom);
  for (let attempt = 1; attempt <= TILE_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length === 0 ? null : buf;
      }
      // A 4xx (other than 429) means the tile is genuinely absent — an invalid
      // or expired panorama id, or a coordinate past the panorama's edge.
      // Treat it as missing instead of retrying, so a fully-invalid id ends as
      // "No tiles downloaded" rather than a raw HTTP error.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return null;
      }
      // 429 / 5xx are transient: fall through to retry.
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === TILE_RETRIES) return null; // give up on this single tile
      await delay(250 * attempt);
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run async jobs with a fixed concurrency limit.
async function runPool(jobs, concurrency, onProgress) {
  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
      done++;
      if (onProgress) onProgress(done, jobs.length);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, jobs.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

async function downloadTiles(panoId, zoom, concurrency) {
  const { cols, rows } = gridForZoom(zoom);
  const coords = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) coords.push({ x, y });
  }

  const jobs = coords.map(({ x, y }) => async () => {
    const buf = await fetchTile(panoId, x, y, zoom);
    return { x, y, buf };
  });

  let lastPct = -1;
  const tiles = await runPool(jobs, concurrency, (d, total) => {
    const pct = Math.floor((d / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  downloading tiles... ${pct}% (${d}/${total})`);
    }
  });
  process.stdout.write("\n");

  const present = tiles.filter((t) => t.buf);
  if (present.length === 0) {
    throw new Error(
      "No tiles downloaded. The panorama id may be invalid or unavailable."
    );
  }
  return { tiles: present, cols, rows };
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

export async function buildPanorama(tiles, cols, rows) {
  // Tiles are NOT guaranteed to all be the same size. At the highest zoom some
  // panoramas return full 512 px tiles only in the centre and half-resolution
  // 256 px tiles around the edges. Every tile still occupies one fixed grid
  // cell, so we must size the cell to the LARGEST tile seen and scale any
  // smaller tile up to fill its cell — otherwise smaller tiles are placed on a
  // too-small step and the whole mosaic shifts/overlaps.
  const metas = await Promise.all(
    tiles.map((t) => sharp(t.buf).metadata())
  );
  let cellW = 0;
  let cellH = 0;
  for (const m of metas) {
    if (m.width > cellW) cellW = m.width;
    if (m.height > cellH) cellH = m.height;
  }
  const width = cols * cellW;
  const height = rows * cellH;

  const composites = await Promise.all(
    tiles.map(async (t, i) => {
      let input = t.buf;
      if (metas[i].width !== cellW || metas[i].height !== cellH) {
        input = await sharp(t.buf)
          .resize(cellW, cellH, { fit: "fill" })
          .toBuffer();
      }
      return { input, left: t.x * cellW, top: t.y * cellH };
    })
  );

  // Build on a black canvas, output as a high quality JPEG buffer.
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
    limitInputPixels: false,
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer();

  return { buf, width, height };
}

export async function resizePanorama(srcBuf, width) {
  const height = Math.round(width / 2);
  return sharp(srcBuf, { limitInputPixels: false })
    .resize(width, height)
    .jpeg({ quality: 95 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// GPano XMP metadata (replaces the original exiftool calls)
// ---------------------------------------------------------------------------

function buildGPanoXmp(width, height) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GPano="http://ns.google.com/photos/1.0/panorama/">
   <GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>
   <GPano:ProjectionType>equirectangular</GPano:ProjectionType>
   <GPano:PoseHeadingDegrees>180.0</GPano:PoseHeadingDegrees>
   <GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>
   <GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>
   <GPano:CroppedAreaImageWidthPixels>${width}</GPano:CroppedAreaImageWidthPixels>
   <GPano:CroppedAreaImageHeightPixels>${height}</GPano:CroppedAreaImageHeightPixels>
   <GPano:FullPanoWidthPixels>${width}</GPano:FullPanoWidthPixels>
   <GPano:FullPanoHeightPixels>${height}</GPano:FullPanoHeightPixels>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// Insert an XMP APP1 segment into a JPEG buffer (right after the SOI marker).
export function injectXmp(jpeg, xmpString) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("not a JPEG buffer");
  }
  const nsHeader = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
  const payload = Buffer.concat([nsHeader, Buffer.from(xmpString, "utf8")]);
  const segLen = payload.length + 2; // length field counts itself
  if (segLen > 0xffff) {
    throw new Error("XMP packet too large for a single APP1 segment");
  }
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1; // APP1
  marker.writeUInt16BE(segLen, 2);
  return Buffer.concat([
    jpeg.subarray(0, 2), // SOI
    marker,
    payload,
    jpeg.subarray(2), // remainder
  ]);
}

export function withPanoXmp(jpegBuf, width, height) {
  return injectXmp(jpegBuf, buildGPanoXmp(width, height));
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
  if (!panoId || panoId.length < 10 || panoId.length > 64) {
    console.error("Could not determine a valid panorama id.");
    process.exit(1);
  }

  console.log(`pano id: ${panoId}`);
  console.log(`zoom: ${opts.zoom}`);

  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  // 1. Download tiles
  console.log("Downloading...");
  const { tiles, cols, rows } = await downloadTiles(
    panoId,
    opts.zoom,
    opts.concurrency
  );
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
  const pathL = join(outDir, `stl-${panoId}.jpg`);
  await writeFile(pathL, withPanoXmp(fullBuf, width, height));
  console.log(`${pathL} created`);

  const labels = ["stm", "sts"];
  for (let i = 0; i < RESIZE_WIDTHS.length; i++) {
    const w = Math.min(RESIZE_WIDTHS[i], width);
    const h = Math.round(w / 2);
    const resized = await resizePanorama(fullBuf, w);
    const p = join(outDir, `${labels[i]}-${panoId}.jpg`);
    await writeFile(p, withPanoXmp(resized, w, h));
    console.log(`${p} created (${w}x${h})`);
  }

  console.log("done");
}

// Only run the CLI when executed directly (not when imported for testing).
import { fileURLToPath } from "node:url";
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    process.stdout.write("\n");
    console.error("Error:", err.message);
    // Set the exit code and let the event loop drain naturally. Calling
    // process.exit() here can abort while fetch/sharp native handles are still
    // open, which trips a libuv assertion during teardown.
    process.exitCode = 1;
  });
}
