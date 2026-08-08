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
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.45) + 1024 * 1024;
const MAX_TEXT_LENGTH = 2000;
const MAX_MESSAGES = 500;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MESSAGE_FILE = path.join(DATA_DIR, "messages.json");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "treehole-media";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const clients = new Map();
const sessions = new Map();
let messages = [];
let saveQueue = Promise.resolve();

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
    await loadMessagesFromSupabase();
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
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const client of clients.values()) {
    sendEvent(client.res, event, payload);
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

async function loadMessagesFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/treehole_messages?select=*&order=created_at.desc&limit=${MAX_MESSAGES}`;
  const response = await fetch(url, { headers: supabaseHeaders() });
  if (!response.ok) {
    throw new Error(`Could not load Supabase messages: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  messages = rows.map(appMessageFromRow).reverse();
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

async function persistMessage(message) {
  messages.push(message);
  messages = messages.slice(-MAX_MESSAGES);

  if (USE_SUPABASE) {
    await saveMessageToSupabase(message);
    return;
  }

  await queueMessageSave();
}

function cleanName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "访客";
}

function cleanText(value) {
  return String(value || "").trim().slice(0, MAX_TEXT_LENGTH);
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
    online: publicClientCount()
  }, {
    "Set-Cookie": sessionCookie(req, token)
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
  const media = await saveMedia(body.media, id);
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
    sendEvent(res, "ping", { time: Date.now() });
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

ensureDataFiles()
  .then(() => {
    http.createServer(router).listen(PORT, "0.0.0.0", () => {
      console.log(`Remote chat is running at http://localhost:${PORT}`);
      console.log(`Password: ${PASSWORD}`);
    });
  })
  .catch((error) => {
    console.error("Startup failed:", error);
    process.exit(1);
  });
