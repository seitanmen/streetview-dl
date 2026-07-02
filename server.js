#!/usr/bin/env node
/*
 * streetview-dl web server
 *
 * A tiny zero-extra-dependency (Node built-in http) web UI: paste a Street
 * View URL or panorama id in the browser, watch the progress, and download the
 * stitched equirectangular JPEG. The heavy lifting (tile download + compositing
 * + GPano XMP) runs server-side because Google's tile endpoint cannot be read
 * directly from the browser (CORS).
 *
 * Local use:  npm start   ->   http://127.0.0.1:8080
 *
 * Public domain / Unlicense.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_ZOOM,
  SIZES,
  extractPanoId,
  isValidPanoId,
  generatePanorama,
} from "./lib/streetview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "8080", 10);
const JOB_TTL_MS = 10 * 60 * 1000; // backstop: drop never-downloaded results after 10 min
const DOWNLOAD_GRACE_MS = parseInt(process.env.DOWNLOAD_GRACE_MS || "60000", 10); // drop image this long after it is downloaded
const MAX_BODY = 64 * 1024; // request body cap

// In-memory job registry. Fine for a local single-user app.
const jobs = new Map();

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

function createJob() {
  const job = {
    id: randomUUID(),
    status: "pending", // pending | running | done | error
    percent: 0,
    stage: "queued",
    error: null,
    file: null, // { buffer, filename, width, height, tileCount, grid }
    listeners: new Set(), // open SSE response streams
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(job, payload) {
  for (const res of job.listeners) sendEvent(res, payload);
}

function closeListeners(job) {
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

// Remove a job and release its in-memory JPEG buffer so nothing lingers.
function disposeJob(job) {
  if (job.disposeTimer) clearTimeout(job.disposeTimer);
  closeListeners(job);
  if (job.file) job.file.buffer = null;
  jobs.delete(job.id);
}

// Snapshot of the current job state for a freshly-connected SSE client.
function stateEvent(job) {
  if (job.status === "done") {
    return {
      type: "done",
      filename: job.file.filename,
      width: job.file.width,
      height: job.file.height,
      tileCount: job.file.tileCount,
      grid: job.file.grid,
      preview: job.file.preview,
      downloadUrl: `/api/jobs/${job.id}/file`,
    };
  }
  if (job.status === "error") return { type: "error", error: job.error };
  return { type: "progress", stage: job.stage, percent: job.percent };
}

async function runJob(job, { panoId, zoom, size }) {
  job.status = "running";
  try {
    const result = await generatePanorama({
      panoId,
      zoom,
      size,
      previewWidth: 640,
      onProgress: ({ stage, percent }) => {
        job.stage = stage;
        job.percent = percent;
        broadcast(job, { type: "progress", stage, percent });
      },
    });
    job.file = {
      buffer: result.buffer,
      filename: result.filename,
      width: result.width,
      height: result.height,
      tileCount: result.tileCount,
      grid: `${result.gridCols}x${result.gridRows}`,
      preview: result.preview,
    };
    job.status = "done";
    job.percent = 100;
    job.stage = "done";
    broadcast(job, stateEvent(job));
  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    broadcast(job, { type: "error", error: job.error });
  } finally {
    closeListeners(job);
  }
}

// Periodic cleanup of old jobs (frees the held JPEG buffers).
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== "running") {
      disposeJob(job);
    }
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function serveIndex(res) {
  try {
    const html = await readFile(join(__dirname, "public", "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length,
    });
    res.end(html);
  } catch {
    sendJson(res, 500, { error: "index.html not found" });
  }
}

// POST /api/jobs  { url, zoom, size } -> { jobId }
async function handleCreateJob(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const panoId = extractPanoId((body.url || "").trim());
  if (!isValidPanoId(panoId)) {
    return sendJson(res, 400, {
      error:
        "Could not find a panorama id. Paste a full Street View URL or a raw id.",
    });
  }

  let zoom = body.zoom === undefined ? DEFAULT_ZOOM : parseInt(body.zoom, 10);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 5) {
    return sendJson(res, 400, { error: "zoom must be an integer 0-5" });
  }

  const size = ["full", "medium", "small"].includes(body.size)
    ? body.size
    : "full";

  const job = createJob();
  // Fire and forget; progress is delivered over SSE.
  runJob(job, { panoId, zoom, size });
  sendJson(res, 202, { jobId: job.id, panoId, zoom, size });
}

// GET /api/jobs/:id/events  (Server-Sent Events)
function handleEvents(res, job) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  // Immediately send the current state, then stream future updates.
  sendEvent(res, stateEvent(job));
  if (job.status === "done" || job.status === "error") {
    res.end();
    return;
  }
  job.listeners.add(res);
  res.on("close", () => job.listeners.delete(res));
}

// GET /api/jobs/:id/file  -> JPEG attachment
function handleFile(res, job) {
  if (job.status !== "done" || !job.file) {
    return sendJson(res, 409, { error: "File not ready" });
  }
  const { buffer, filename } = job.file;
  const safeName = filename.replace(/["\r\n]/g, "");
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
  });
  res.end(buffer);

  // Discard the in-memory image shortly after it has been delivered, so it does
  // not linger on the server. A short grace allows a quick re-download.
  res.once("finish", () => {
    if (job.disposeTimer) return;
    job.disposeTimer = setTimeout(() => disposeJob(job), DOWNLOAD_GRACE_MS);
    if (job.disposeTimer.unref) job.disposeTimer.unref();
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return await serveIndex(res);
    }
    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && path === "/api/jobs") {
      return await handleCreateJob(req, res);
    }

    const m = path.match(/^\/api\/jobs\/([^/]+)\/(events|file)$/);
    if (m && req.method === "GET") {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: "Job not found" });
      return m[2] === "events" ? handleEvents(res, job) : handleFile(res, job);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`streetview-dl web UI running at  http://${HOST}:${PORT}`);
  console.log(`(default zoom ${DEFAULT_ZOOM}; sizes: ${Object.keys(SIZES).join(", ")})`);
  console.log("Press Ctrl+C to stop.");
});
