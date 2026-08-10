const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.CHAT_PASSWORD || "liu123";
const COOKIE_NAME = "treehole_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.45) + 1024 * 1024;
const MAX_TEXT_LENGTH = 2000;
const MAX_DIARY_TEXT_LENGTH = 12000;
const MAX_MESSAGES = 500;
const MAX_DIARY_ENTRIES = 300;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MESSAGE_FILE = path.join(DATA_DIR, "messages.json");
const DIARY_FILE = path.join(DATA_DIR, "diary.json");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "treehole-media";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const clients = new Map();
const sessions = new Map();
let messages = [];
let diaryEntries = [];
let saveQueue = Promise.resolve();
let saveDiaryQueue = Promise.resolve();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"]
]);

const uploadExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"]
]);

async function ensureDataFiles() {
  if (USE_SUPABASE) {
    await safeLoadSupabaseData();
    return;
  }

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(MESSAGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    messages = Array.isArray(parsed) ? parsed.slice(-MAX_MESSAGES) : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not load messages:", error.message);
    }
    messages = [];
  }

  try {
    const raw = await fsp.readFile(DIARY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    diaryEntries = Array.isArray(parsed) ? parsed.slice(-MAX_DIARY_ENTRIES) : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not load diary:", error.message);
    }
    diaryEntries = [];
  }
}

async function safeLoadSupabaseData() {
  const results = await Promise.allSettled([
    loadMessagesFromSupabase(),
    loadDiaryFromSupabase()
  ]);

  if (results[0].status === "rejected") {
    console.warn("Supabase messages unavailable at startup:", results[0].reason.message);
    messages = [];
  }

  if (results[1].status === "rejected") {
    console.warn("Supabase diary unavailable at startup:", results[1].reason.message);
    diaryEntries = [];
  }
}

function json(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function checkPassword(value) {
  return value === PASSWORD;
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separator = item.indexOf("=");
      if (separator === -1) return cookies;
      const key = decodeURIComponent(item.slice(0, separator));
      const value = decodeURIComponent(item.slice(separator + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function createSession(name, clientId) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    name,
    clientId,
    expiresAt: Date.now() + SESSION_MS
  };
  sessions.set(token, session);
  return { token, session };
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_MS;
  return session;
}

function sessionCookie(req, token) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
    secure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function publicClientCount() {
  const ids = new Set();
  for (const client of clients.values()) {
    if (client.clientId) ids.add(client.clientId);
  }
  return ids.size;
}

function sendEvent(res, event, payload) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (error) {
    console.warn("SSE write failed:", error.message);
    return false;
  }
}

function broadcast(event, payload) {
  for (const [id, client] of clients.entries()) {
    if (!sendEvent(client.res, event, payload)) {
      clients.delete(id);
    }
  }
}

function broadcastPresence() {
  broadcast("presence", { online: publicClientCount() });
}

function queueMessageSave() {
  const payload = JSON.stringify(messages.slice(-MAX_MESSAGES), null, 2);
  saveQueue = saveQueue
    .then(() => fsp.writeFile(MESSAGE_FILE, payload, "utf8"))
    .catch((error) => console.warn("Could not save messages:", error.message));
  return saveQueue;
}

function queueDiarySave() {
  const payload = JSON.stringify(diaryEntries.slice(-MAX_DIARY_ENTRIES), null, 2);
  saveDiaryQueue = saveDiaryQueue
    .then(() => fsp.writeFile(DIARY_FILE, payload, "utf8"))
    .catch((error) => console.warn("Could not save diary:", error.message));
  return saveDiaryQueue;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

function appMessageFromRow(row) {
  return {
    id: row.id,
    time: row.created_at,
    clientId: row.client_id,
    author: row.author,
    text: row.text || "",
    media: row.media || null
  };
}

function appDiaryFromRow(row) {
  return {
    id: row.id,
    time: row.created_at,
    clientId: row.client_id,
    author: row.author,
    title: row.title || "",
    text: row.text || "",
    media: Array.isArray(row.media) ? row.media : []
  };
}

async function loadMessagesFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/treehole_messages?select=*&order=created_at.desc&limit=${MAX_MESSAGES}`;
  const response = await fetch(url, { headers: supabaseHeaders() });
  if (!response.ok) {
    throw new Error(`Could not load Supabase messages: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  messages = rows.map(appMessageFromRow).reverse();
}

async function loadDiaryFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/treehole_diary?select=*&order=created_at.desc&limit=${MAX_DIARY_ENTRIES}`;
  const response = await fetch(url, { headers: supabaseHeaders() });
  if (!response.ok) {
    throw new Error(`Could not load Supabase diary: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  diaryEntries = rows.map(appDiaryFromRow).reverse();
}

async function saveMessageToSupabase(message) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/treehole_messages`, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    }),
    body: JSON.stringify({
      id: message.id,
      created_at: message.time,
      client_id: message.clientId,
      author: message.author,
      text: message.text,
      media: message.media
    })
  });

  if (!response.ok) {
    const error = new Error(`Could not save message: ${response.status} ${await response.text()}`);
    error.statusCode = 502;
    throw error;
  }
}

async function saveDiaryToSupabase(entry) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/treehole_diary`, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    }),
    body: JSON.stringify({
      id: entry.id,
      created_at: entry.time,
      client_id: entry.clientId,
      author: entry.author,
      title: entry.title,
      text: entry.text,
      media: entry.media
    })
  });

  if (!response.ok) {
    const error = new Error(`Could not save diary: ${response.status} ${await response.text()}`);
    error.statusCode = 502;
    throw error;
  }
}

async function persistMessage(message) {
  messages.push(message);
  messages = messages.slice(-MAX_MESSAGES);

  if (USE_SUPABASE) {
    await saveMessageToSupabase(message);
    return;
  }

  await queueMessageSave();
}

async function persistDiary(entry) {
  diaryEntries.push(entry);
  diaryEntries = diaryEntries.slice(-MAX_DIARY_ENTRIES);

  if (USE_SUPABASE) {
    await saveDiaryToSupabase(entry);
    return;
  }

  await queueDiarySave();
}

function cleanName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "访客";
}

function cleanText(value) {
  return String(value || "").trim().slice(0, MAX_TEXT_LENGTH);
}

function cleanDiaryText(value) {
  return String(value || "").trim().slice(0, MAX_DIARY_TEXT_LENGTH);
}

function cleanTitle(value) {
  return String(value || "").trim().slice(0, 80);
}

function safeFileName(value) {
  return String(value || "media")
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_")
    .slice(0, 80);
}

async function saveMedia(media, messageId) {
  if (!media || typeof media.dataUrl !== "string") return null;

  const match = /^data:([^;,]+);base64,(.+)$/i.exec(media.dataUrl);
  if (!match) {
    const error = new Error("Unsupported media format");
    error.statusCode = 400;
    throw error;
  }

  const mime = match[1].toLowerCase();
  const extension = uploadExtensions.get(mime);
  if (!extension) {
    const error = new Error("Only image and video files are allowed");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`File must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller`);
    error.statusCode = 413;
    throw error;
  }

  const fileName = `${messageId}${extension}`;
  if (USE_SUPABASE) {
    await uploadMediaToSupabase(fileName, mime, buffer);
    return {
      url: `/api/media/${encodeURIComponent(fileName)}`,
      type: mime,
      name: safeFileName(media.name),
      size: buffer.length
    };
  }

  await fsp.writeFile(path.join(UPLOAD_DIR, fileName), buffer);

  return {
    url: `/uploads/${fileName}`,
    type: mime,
    name: safeFileName(media.name),
    size: buffer.length
  };
}

async function uploadMediaToSupabase(fileName, mime, buffer) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(fileName)}`, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": mime,
      "x-upsert": "false"
    }),
    body: buffer
  });

  if (!response.ok) {
    const error = new Error(`Could not upload media: ${response.status} ${await response.text()}`);
    error.statusCode = 502;
    throw error;
  }
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  if (!checkPassword(body.password)) {
    json(res, 401, { error: "密码不正确" });
    return;
  }

  const name = cleanName(body.name);
  const clientId = String(body.clientId || crypto.randomUUID());
  const { token } = createSession(name, clientId);

  json(res, 200, {
    ok: true,
    name,
    messages,
    online: publicClientCount(),
    maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
    directUpload: USE_SUPABASE
  }, {
    "Set-Cookie": sessionCookie(req, token)
  });
}

function validateMediaType(mime) {
  const extension = uploadExtensions.get(String(mime || "").toLowerCase());
  if (!extension) {
    const error = new Error("Only image and video files are allowed");
    error.statusCode = 400;
    throw error;
  }
  return extension;
}

function mediaFromUploadedReference(media) {
  if (!media || typeof media.url !== "string") return null;

  const type = String(media.type || "").toLowerCase();
  validateMediaType(type);

  const url = media.url.trim();
  if (!url.startsWith("/api/media/") && !url.startsWith("/uploads/")) {
    const error = new Error("Invalid uploaded media URL");
    error.statusCode = 400;
    throw error;
  }

  return {
    url,
    type,
    name: safeFileName(media.name),
    size: Number(media.size || 0)
  };
}

async function normalizeMediaList(mediaItems, entryId) {
  if (!Array.isArray(mediaItems)) return [];

  const limitedItems = mediaItems.slice(0, 8);
  const normalized = [];
  for (let index = 0; index < limitedItems.length; index += 1) {
    const item = limitedItems[index];
    const uploaded = mediaFromUploadedReference(item);
    if (uploaded) {
      normalized.push(uploaded);
      continue;
    }

    const saved = await saveMedia(item, `${entryId}-${index}`);
    if (saved) normalized.push(saved);
  }
  return normalized;
}

async function createSupabaseSignedUpload(fileName) {
  const encodedBucket = encodeURIComponent(SUPABASE_BUCKET);
  const encodedFile = encodeURIComponent(fileName);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${encodedBucket}/${encodedFile}`, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      "x-upsert": "false"
    }),
    body: "{}"
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Could not create upload URL: ${response.status} ${JSON.stringify(data)}`);
    error.statusCode = 502;
    throw error;
  }

  let uploadUrl = data.signedUrl || data.signedURL || data.signed_url || data.url;
  if (uploadUrl && uploadUrl.startsWith("/")) {
    uploadUrl = `${SUPABASE_URL}/storage/v1${uploadUrl}`;
  }

  if (!uploadUrl && data.token) {
    uploadUrl = `${SUPABASE_URL}/storage/v1/object/upload/sign/${encodedBucket}/${encodedFile}?token=${encodeURIComponent(data.token)}`;
  }

  if (!uploadUrl) {
    const error = new Error("Supabase did not return a signed upload URL");
    error.statusCode = 502;
    throw error;
  }

  return uploadUrl;
}

async function handleUploadUrl(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Please log in first" });
    return;
  }

  if (!USE_SUPABASE) {
    json(res, 400, { error: "Direct upload requires Supabase configuration" });
    return;
  }

  const body = await readBody(req);
  const type = String(body.type || "").toLowerCase();
  const size = Number(body.size || 0);
  const extension = validateMediaType(type);

  if (!Number.isFinite(size) || size <= 0) {
    json(res, 400, { error: "Invalid file size" });
    return;
  }

  if (size > MAX_UPLOAD_BYTES) {
    json(res, 413, { error: `File must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller` });
    return;
  }

  const id = crypto.randomUUID();
  const fileName = `${id}${extension}`;
  const uploadUrl = await createSupabaseSignedUpload(fileName);

  json(res, 200, {
    ok: true,
    uploadUrl,
    media: {
      url: `/api/media/${encodeURIComponent(fileName)}`,
      type,
      name: safeFileName(body.name),
      size
    }
  });
}

async function handleMessage(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "请先输入密码登录" });
    return;
  }

  const body = await readBody(req);
  const text = cleanText(body.text);
  if (!text && !body.media) {
    json(res, 400, { error: "消息不能为空" });
    return;
  }

  const id = crypto.randomUUID();
  const media = mediaFromUploadedReference(body.media) || await saveMedia(body.media, id);
  const message = {
    id,
    time: new Date().toISOString(),
    clientId: session.clientId,
    author: session.name,
    text,
    media
  };

  await persistMessage(message);
  broadcast("message", message);
  json(res, 201, { ok: true, message });
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Please log in first" });
    return null;
  }
  return session;
}

async function handleGetDiary(req, res) {
  const session = requireSession(req, res);
  if (!session) return;

  json(res, 200, {
    ok: true,
    entries: diaryEntries
  });
}

async function handleCreateDiary(req, res) {
  const session = requireSession(req, res);
  if (!session) return;

  const body = await readBody(req);
  const title = cleanTitle(body.title);
  const text = cleanDiaryText(body.text);
  if (!title && !text && (!Array.isArray(body.media) || body.media.length === 0)) {
    json(res, 400, { error: "Diary entry cannot be empty" });
    return;
  }

  const id = crypto.randomUUID();
  const media = await normalizeMediaList(body.media, id);
  const entry = {
    id,
    time: new Date().toISOString(),
    clientId: session.clientId,
    author: session.name,
    title,
    text,
    media
  };

  await persistDiary(entry);
  broadcast("diary", entry);
  json(res, 201, { ok: true, entry });
}

async function handleCallSignal(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Please log in first" });
    return;
  }

  const body = await readBody(req);
  const signalType = String(body.signalType || "");
  const allowedTypes = new Set(["call-offer", "call-answer", "call-ice", "call-hangup", "call-decline"]);
  if (!allowedTypes.has(signalType)) {
    json(res, 400, { error: "Invalid call signal" });
    return;
  }

  broadcast("call", {
    signalType,
    senderId: session.clientId,
    senderName: session.name,
    payload: body.payload || null,
    time: new Date().toISOString()
  });

  json(res, 200, { ok: true });
}

async function handleMedia(req, res, url) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Please log in first" });
    return;
  }

  if (!USE_SUPABASE) {
    notFound(res);
    return;
  }

  const fileName = path.basename(decodeURIComponent(url.pathname.replace(/^\/api\/media\//, "")));
  if (!fileName) {
    notFound(res);
    return;
  }

  const headers = supabaseHeaders();
  if (req.headers.range) headers.Range = req.headers.range;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${encodeURIComponent(fileName)}`, {
    headers
  });

  if (!response.ok || !response.body) {
    notFound(res);
    return;
  }

  const responseHeaders = {
    "Content-Type": response.headers.get("content-type") || mimeTypes.get(path.extname(fileName).toLowerCase()) || "application/octet-stream",
    "Cache-Control": "private, max-age=86400",
    "Accept-Ranges": response.headers.get("accept-ranges") || "bytes"
  };

  const contentLength = response.headers.get("content-length");
  const contentRange = response.headers.get("content-range");
  if (contentLength) responseHeaders["Content-Length"] = contentLength;
  if (contentRange) responseHeaders["Content-Range"] = contentRange;

  res.writeHead(response.status, responseHeaders);
  Readable.fromWeb(response.body).pipe(res);
}

function handleEvents(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "请先输入密码登录" });
    return;
  }

  const id = crypto.randomUUID();
  clients.set(id, {
    clientId: session.clientId,
    res
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sendEvent(res, "init", {
    messages,
    online: publicClientCount()
  });
  broadcastPresence();

  const keepAlive = setInterval(() => {
    if (!sendEvent(res, "ping", { time: Date.now() })) {
      clearInterval(keepAlive);
      clients.delete(id);
      broadcastPresence();
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(id);
    broadcastPresence();
  });
}

function sendStaticFile(res, absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();
  const type = mimeTypes.get(extension) || "application/octet-stream";

  fs.stat(absolutePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      notFound(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stats.size,
      "Cache-Control": absolutePath.includes(`${path.sep}uploads${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache"
    });
    fs.createReadStream(absolutePath).pipe(res);
  });
}

function resolvePublicPath(urlPath) {
  const requested = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const resolved = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function resolveUploadPath(urlPath) {
  const fileName = path.basename(decodeURIComponent(urlPath.replace(/^\/uploads\//, "")));
  const resolved = path.resolve(UPLOAD_DIR, fileName);
  if (!resolved.startsWith(UPLOAD_DIR)) return null;
  return resolved;
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      await handleMessage(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/diary") {
      await handleGetDiary(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/diary") {
      await handleCreateDiary(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upload-url") {
      await handleUploadUrl(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/call-signal") {
      await handleCallSignal(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/media/")) {
      await handleMedia(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const uploadPath = resolveUploadPath(url.pathname);
      uploadPath ? sendStaticFile(res, uploadPath) : notFound(res);
      return;
    }

    if (req.method === "GET") {
      const publicPath = resolvePublicPath(url.pathname);
      publicPath ? sendStaticFile(res, publicPath) : notFound(res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    json(res, statusCode, {
      error: statusCode === 500 ? "服务器错误" : error.message
    });
    if (statusCode === 500) {
      console.error(error);
    }
  }
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

async function startServer() {
  try {
    await ensureDataFiles();
  } catch (error) {
    console.warn("Startup data load failed; continuing with empty in-memory state:", error.message);
    messages = [];
    diaryEntries = [];
  }

  http.createServer(router).listen(PORT, "0.0.0.0", () => {
    console.log(`Remote chat is running at http://localhost:${PORT}`);
    console.log(`Storage: ${USE_SUPABASE ? "Supabase" : "local"}`);
  });
}

startServer();
