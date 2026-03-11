/* eslint-disable require-jsdoc */
const express = require("express");
const {defineSecret} = require("firebase-functions/params");
const {onRequest} = require("firebase-functions/v2/https");

const DRIVE_API_KEY = defineSecret("DRIVE_API_KEY");

const app = express();
const api = express.Router();

function setCORS(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// ルータ配下は常にCORS、OPTIONSはここで吸収
api.use((req, res, next) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

async function fetchWithTimeout(url, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || 10000;
  const rest = {...options};
  delete rest.timeoutMs;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {...rest, signal: ac.signal});
  } finally {
    clearTimeout(t);
  }
}

function assertKeyReady() {
  const v = DRIVE_API_KEY.value();
  if (!v) {
    const e = new Error("DRIVE_API_KEY is not set");
    e.status = 500;
    throw e;
  }
  return v;
}

api.get("/health", (req, res) => {
  return res.status(200).json({ok: true});
});

api.get("/drive", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "").trim();
    const exportMime = String(req.query.exportMime || "").trim();

    if (!fileId) return res.status(400).json({error: "fileId is required"});

    const key = assertKeyReady();
    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;

    const url = new URL(exportMime ? `${base}/export` : base);
    if (exportMime) url.searchParams.set("mimeType", exportMime);
    else url.searchParams.set("alt", "media");
    url.searchParams.set("key", key);

    const r = await fetchWithTimeout(url.toString(), {
      timeoutMs: 10000,
      headers: {"User-Agent": "melcad-proxy"},
    });

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.set("Cache-Control", "public, max-age=60");
    res.set(
        "Content-Type",
        r.headers.get("content-type") || "application/octet-stream",
    );
    return res.send(buf);
  } catch (e) {
    console.error("PROXY_ERROR", e);
    const status = e.status || 502;
    return res.status(status).json({
      error: "proxy fetch failed",
      detail: String(e),
    });
  }
});

api.get("/folder", async (req, res) => {
  try {
    const parentId = String(req.query.parentId || "").trim();
    const name = String(req.query.name || "").trim();
    if (!parentId) return res.status(400).json({error: "parentId is required"});
    if (!name) return res.status(400).json({error: "name is required"});

    const key = assertKeyReady();
    const q =
      `'${parentId.replace(/'/g, "\\'")}' in parents and ` +
      `name='${name.replace(/'/g, "\\'")}' and ` +
      "mimeType='application/vnd.google-apps.folder' and trashed=false";

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("key", key);
    url.searchParams.set("q", q);
    url.searchParams.set("orderBy", "name");
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("fields", "files(id,name)");

    const r = await fetchWithTimeout(url.toString(), {timeoutMs: 10000});
    const json = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({error: "drive list failed", detail: json});
    }

    const files = json.files || [];
    if (!files.length) return res.status(404).json({error: "folder not found"});
    return res.json({id: files[0].id, name: files[0].name});
  } catch (e) {
    console.error("FOLDER_ERROR", e);
    const status = e.status || 502;
    return res.status(status).json({
      error: "folder lookup failed",
      detail: String(e),
    });
  }
});

/**
 * ✅ 追加: /api/driveList (index.html互換)
 *  - クエリ(q=...) をそのまま Drive files.list に中継
 *  - fields / orderBy / pageSize / pageToken も任意で受ける
 */
api.get("/driveList", async (req, res) => {
  try {
    const key = assertKeyReady();

    const q = String(req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({error: "q is required"});
    }

    const fields = String(req.query.fields || "").trim() ||
      "files(id,name,description,mimeType,createdTime,modifiedTime),nextPageToken";
    const orderBy = String(req.query.orderBy || "").trim() || "name";
    const pageSize = String(req.query.pageSize || "").trim();
    const pageToken = String(req.query.pageToken || "").trim();

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("key", key);
    url.searchParams.set("q", q);
    url.searchParams.set("orderBy", orderBy);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("fields", fields);
    if (pageSize) url.searchParams.set("pageSize", pageSize);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const r = await fetchWithTimeout(url.toString(), {timeoutMs: 10000});
    const text = await r.text();

    res.status(r.status);
    res.set("Cache-Control", "public, max-age=60");
    res.set("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
    return res.send(text);
  } catch (e) {
    console.error("DRIVELIST_ERROR", e);
    const status = e.status || 502;
    return res.status(status).json({error: "driveList failed", detail: String(e)});
  }
});

/**
 * 既存: /api/drive/list?parentId=...（あなたが成功確認したやつ）
 * - 必要なら imagesOnly を外したり fields を増やしたりは後で可能
 */
api.get("/drive/list", async (req, res) => {
  try {
    const parentId = String(req.query.parentId || "").trim();

    if (!parentId) {
      return res.status(400).json({error: "parentId is required"});
    }

    const key = assertKeyReady();

    const q = [
      `'${parentId.replace(/'/g, "\\'")}' in parents`,
      "trashed=false",
      // 画像だけ欲しければ↓（不要なら外してOK）
      "mimeType contains 'image/'",
    ].join(" and ");

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("orderBy", "name");
    url.searchParams.set("fields", "files(id,name,description,mimeType,createdTime)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("key", key);

    const r = await fetchWithTimeout(url.toString(), {timeoutMs: 10000});
    const text = await r.text();

    res.status(r.status);
    res.set("Cache-Control", "public, max-age=60");
    res.set("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
    return res.send(text);
  } catch (e) {
    console.error("LIST_ERROR", e);
    return res.status(502).json({error: "list failed", detail: String(e)});
  }
});

app.use("/api", api);

// ★ v2: runWithではなく onRequest のオプションで secrets を渡す
exports.api = onRequest(
    {region: "us-central1", secrets: [DRIVE_API_KEY]},
    app,
);
