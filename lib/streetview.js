/*
 * streetview core library
 *
 * Pure pipeline shared by the CLI (streetview-dl.js) and the web server
 * (server.js): download Street View tiles, composite an equirectangular
 * panorama, resize, and write GPano XMP metadata. No process/stdout/file I/O
 * here so it can run unchanged in either context.
 *
 * Public domain / Unlicense.
 */

import sharp from "sharp";

// --- Configuration defaults -------------------------------------------------

export const TILE_URL =
  "https://streetviewpixels-pa.googleapis.com/v1/tile";
export const DEFAULT_ZOOM = 5;
export const DEFAULT_CONCURRENCY = 8;
export const TILE_RETRIES = 3;

// Named output sizes. Width is capped at the real panorama width; height is
// always width/2 for an equirectangular 2:1 image.
export const SIZES = {
  full: { prefix: "stl", maxWidth: Infinity, label: "Full resolution" },
  medium: { prefix: "stm", maxWidth: 8192, label: "8192 px wide" },
  small: { prefix: "sts", maxWidth: 1300, label: "1300 px wide" },
};

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

// A panorama id is plausible when it is 10-64 chars long. Used by both
// front-ends to reject obvious garbage before hitting Google.
export function isValidPanoId(id) {
  return typeof id === "string" && id.length >= 10 && id.length <= 64;
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

export function tileUrl(panoId, x, y, zoom) {
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      // Treat it as missing instead of retrying.
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

// Download all tiles for a panorama. onTileProgress(done, total) is called as
// each tile finishes. Returns only the tiles that were actually served.
export async function downloadTiles(
  panoId,
  zoom,
  concurrency = DEFAULT_CONCURRENCY,
  onTileProgress
) {
  const { cols, rows } = gridForZoom(zoom);
  const coords = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) coords.push({ x, y });
  }

  const jobs = coords.map(({ x, y }) => async () => {
    const buf = await fetchTile(panoId, x, y, zoom);
    return { x, y, buf };
  });

  const tiles = await runPool(jobs, concurrency, onTileProgress);
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
  // cell, so we size the cell to the LARGEST tile seen and scale any smaller
  // tile up to fill its cell — otherwise smaller tiles land on a too-small step
  // and the whole mosaic shifts/overlaps.
  const metas = await Promise.all(tiles.map((t) => sharp(t.buf).metadata()));
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
// High-level pipeline (one panorama, one output size)
// ---------------------------------------------------------------------------

// Generate a single tagged JPEG for the given panorama and output size.
// onProgress(event) receives { stage, percent } updates where stage is one of
// "downloading" | "compositing" | "resizing" | "done".
export async function generatePanorama({
  panoId,
  zoom = DEFAULT_ZOOM,
  concurrency = DEFAULT_CONCURRENCY,
  size = "full",
  onProgress,
} = {}) {
  const report = (stage, percent) =>
    onProgress && onProgress({ stage, percent });

  // Download is the long part: give it 90% of the progress bar.
  const { tiles, cols, rows } = await downloadTiles(
    panoId,
    zoom,
    concurrency,
    (done, total) => report("downloading", Math.floor((done / total) * 90))
  );

  report("compositing", 92);
  const { buf, width, height } = await buildPanorama(tiles, cols, rows);

  const sel = SIZES[size] || SIZES.full;
  let outBuf = buf;
  let outW = width;
  let outH = height;
  if (sel.maxWidth < width) {
    report("resizing", 96);
    outW = sel.maxWidth;
    outH = Math.round(outW / 2);
    outBuf = await resizePanorama(buf, outW);
  }

  const tagged = withPanoXmp(outBuf, outW, outH);
  report("done", 100);

  return {
    buffer: tagged,
    width: outW,
    height: outH,
    filename: `${sel.prefix}-${panoId}.jpg`,
    tileCount: tiles.length,
    gridCols: cols,
    gridRows: rows,
  };
}
