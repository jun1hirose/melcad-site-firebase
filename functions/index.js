const express = require("express");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");

const DRIVE_API_KEY = defineSecret("DRIVE_API_KEY");

const app = express();
const api = express.Router();

function setCORS(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// OPTIONS（/drive と /api/drive の両方に効くように）
api.options(["/drive", "/api/drive"], (req, res) => {
  setCORS(res);
  return res.status(204).end();
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

// health（/health と /api/health の両方）
api.get(["/health", "/api/health"], (req, res) => {
  setCORS(res);
  res.status(200).json({ok: true, path: req.path});
});

// drive（/drive と /api/drive の両方）
api.get(["/drive", "/api/drive"], async (req, res) => {
  setCORS(res);
  try {
    const {fileId, exportMime} = req.query;
    const apiKey = DRIVE_API_KEY.value();

    if (!fileId) return res.status(400).json({error: "fileId is required"});
    if (!apiKey) return res.status(500).json({error: "DRIVE_API_KEY is not set"});

    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
    const url = new URL(exportMime ? `${base}/export` : base);

    if (exportMime) url.searchParams.set("mimeType", exportMime);
    else url.searchParams.set("alt", "media");

    url.searchParams.set("key", apiKey);

    const r = await fetchWithTimeout(url.toString(), {
      timeoutMs: 10000,
      headers: {"User-Agent": "melcad-proxy"},
    });

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

// ルータをアプリに付ける（rootでも /api でも動く）
app.use("/", api);

exports.api = onRequest({secrets: [DRIVE_API_KEY]}, app);
