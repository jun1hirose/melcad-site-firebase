const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const express = require("express");

const DRIVE_API_KEY = defineSecret("DRIVE_API_KEY");

const app = express();
const api = express.Router();

function setCORS(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

api.use((req, res, next) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

async function fetchWithTimeout(url, {timeoutMs = 10000, ...opts} = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {...opts, signal: ac.signal});
  } finally {
    clearTimeout(t);
  }
}

api.get("/health", (req, res) => {
  res.status(200).json({ok: true});
});

api.get("/driveList", async (req, res) => {
  try {
    if (!DRIVE_API_KEY.value()) return res.status(500).json({error: "DRIVE_API_KEY is not set"});

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const allow = ["q", "orderBy", "fields", "pageSize", "pageToken", "spaces"];
    for (const k of allow) {
      const v = req.query[k];
      if (typeof v === "string" && v.length) url.searchParams.set(k, v);
    }

    if (!url.searchParams.get("fields")) {
      url.searchParams.set("fields", "files(id,name,description,mimeType,createdTime,modifiedTime),nextPageToken");
    }

    url.searchParams.set("key", DRIVE_API_KEY.value());

    const r = await fetchWithTimeout(url.toString(), {timeoutMs: 10000, headers: {"User-Agent": "melcad-proxy"}});
    const text = await r.text();

    res.status(r.status);
    res.set("Cache-Control", "public, max-age=60");
    res.set("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
    return res.send(text);
  } catch (e) {
    console.error("DRIVELIST_PROXY_ERROR", e);
    return res.status(502).json({error: "proxy fetch failed", detail: String(e)});
  }
});

api.get("/drive", async (req, res) => {
  try {
    const {fileId, exportMime} = req.query;

    if (!fileId) return res.status(400).json({error: "fileId is required"});
    if (!DRIVE_API_KEY.value()) return res.status(500).json({error: "DRIVE_API_KEY is not set"});

    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
    const url = new URL(exportMime ? `${base}/export` : base);
    if (exportMime) url.searchParams.set("mimeType", exportMime);
    else url.searchParams.set("alt", "media");
    url.searchParams.set("key", DRIVE_API_KEY.value());

    const r = await fetchWithTimeout(url.toString(), {timeoutMs: 10000, headers: {"User-Agent": "melcad-proxy"}});
    const text = await r.text();

    res.status(r.status);
    res.set("Cache-Control", "public, max-age=60");
    res.set("Content-Type", r.headers.get("content-type") || "text/plain; charset=utf-8");
    return res.send(text);
  } catch (e) {
    console.error("PROXY_ERROR", e);
    return res.status(502).json({error: "proxy fetch failed", detail: String(e)});
  }
});

app.use("/api", api);

// v2: secrets は onRequest オプションで付ける（runWith不要）
exports.api = onRequest({region: "us-central1", secrets: [DRIVE_API_KEY]}, app);
