const COOKIE_NAME = "treehole_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_MESSAGES = 500;
const MAX_DIARY_ENTRIES = 300;
const MAX_CALL_SIGNALS = 120;

const uploadExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"]
]);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  try {
    if (request.method === "POST" && pathname === "/api/login") return handleLogin(request, env);
    if (request.method === "GET" && pathname === "/api/messages") return handleGetMessages(request, env);
    if (request.method === "POST" && pathname === "/api/messages") return handleCreateMessage(request, env);
    if (request.method === "GET" && pathname === "/api/diary") return handleGetDiary(request, env);
    if (request.method === "POST" && pathname === "/api/diary") return handleCreateDiary(request, env);

    const diaryMatch = pathname.match(/^\/api\/diary\/([0-9a-f-]+)$/i);
    if (request.method === "PUT" && diaryMatch) return handleUpdateDiary(request, env, diaryMatch[1]);

    if (request.method === "GET" && pathname === "/api/sesame") return handleGetSesame(request, env);
    if (request.method === "POST" && pathname === "/api/sesame") return handleCreateSesame(request, env);

    const sesameMatch = pathname.match(/^\/api\/sesame\/([0-9a-f-]+)$/i);
    if (request.method === "PUT" && sesameMatch) return handleUpdateSesame(request, env, sesameMatch[1]);

    if (request.method === "GET" && pathname === "/api/goals") return handleGetGoals(request, env);
    if (request.method === "PUT" && pathname === "/api/goals") return handleSaveGoals(request, env);

    const goalMatch = pathname.match(/^\/api\/goals\/([0-9a-f-]+)\/done$/i);
    if (request.method === "POST" && goalMatch) return handleToggleGoal(request, env, goalMatch[1]);

    if (request.method === "POST" && pathname === "/api/upload-url") return handleUploadUrl(request, env);
    if (request.method === "POST" && pathname === "/api/call-signal") return handleCallSignal(request, env);
    if (request.method === "GET" && pathname === "/api/call-signals") return handleGetCallSignals(request, env, url);
    if (request.method === "GET" && pathname.startsWith("/api/media/")) return handleMedia(request, env, pathname);
    if (request.method === "GET" && pathname === "/api/events") return handleEvents(request, env);
    if (request.method === "GET" && pathname === "/api/health") return json({ ok: true, cloudflare: true });

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error.statusCode ? error.message : "服务器错误" }, error.statusCode || 500);
  }
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (body.password !== getPassword(env)) return json({ error: "密码不正确" }, 401);

  const name = cleanName(body.name);
  const clientId = String(body.clientId || crypto.randomUUID());
  const token = await createSessionToken(env, { name, clientId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
  const messages = await loadMessages(env);

  return json({
    ok: true,
    cloudflare: true,
    name,
    messages,
    messagesStale: false,
    online: 1,
    maxUploadMb: getMaxUploadMb(env),
    directUpload: true
  }, 200, {
    "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`
  });
}

async function handleGetMessages(request, env) {
  await requireSession(request, env);
  return json({ ok: true, messages: await loadMessages(env), stale: false, lastLoadedAt: Date.now() });
}

async function handleCreateMessage(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const text = cleanText(body.text);
  const media = mediaFromUploadedReference(body.media);
  if (!text && !media) return json({ error: "消息不能为空" }, 400);

  const message = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    clientId: session.clientId,
    author: session.name,
    text,
    media
  };

  await supabase(env, "/rest/v1/treehole_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: message.id,
      created_at: message.time,
      client_id: message.clientId,
      author: message.author,
      text: message.text,
      media: message.media
    })
  });

  return json({ ok: true, message }, 201);
}

async function handleGetDiary(request, env) {
  await requireSession(request, env);
  const rows = await supabase(env, `/rest/v1/treehole_diary?select=*&order=created_at.desc&limit=${MAX_DIARY_ENTRIES}`);
  return json({ ok: true, entries: rows.map(appDiaryFromRow).reverse() });
}

async function handleCreateDiary(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const text = cleanDiaryText(body.text);
  const media = normalizeMediaList(body.media);
  if (!title && !text && media.length === 0) return json({ error: "Diary entry cannot be empty" }, 400);

  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    clientId: session.clientId,
    author: session.name,
    title,
    text,
    media
  };

  await supabase(env, "/rest/v1/treehole_diary", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
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

  return json({ ok: true, entry }, 201);
}

async function handleUpdateDiary(request, env, id) {
  await requireSession(request, env);
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const text = cleanDiaryText(body.text);
  const media = normalizeMediaList(body.existingMedia).concat(normalizeMediaList(body.media)).slice(0, 8);
  if (!title && !text && media.length === 0) return json({ error: "Diary entry cannot be empty" }, 400);

  await supabase(env, `/rest/v1/treehole_diary?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ title, text, media, edited_at: new Date().toISOString() })
  });

  const rows = await supabase(env, `/rest/v1/treehole_diary?id=eq.${encodeURIComponent(id)}&select=*`);
  return json({ ok: true, entry: appDiaryFromRow(rows[0]) });
}

async function handleGetSesame(request, env) {
  await requireSession(request, env);
  const rows = await supabase(env, `/rest/v1/treehole_sesame?select=*&order=created_at.desc&limit=${MAX_DIARY_ENTRIES}`);
  return json({ ok: true, entries: rows.map(appDiaryFromRow).reverse() });
}

async function handleCreateSesame(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const text = cleanDiaryText(body.text);
  const media = normalizeMediaList(body.media);
  if (!title && !text && media.length === 0) return json({ error: "Sesame entry cannot be empty" }, 400);

  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    clientId: session.clientId,
    author: session.name,
    title,
    text,
    media
  };

  await supabase(env, "/rest/v1/treehole_sesame", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
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

  return json({ ok: true, entry }, 201);
}

async function handleUpdateSesame(request, env, id) {
  await requireSession(request, env);
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const text = cleanDiaryText(body.text);
  const media = normalizeMediaList(body.existingMedia).concat(normalizeMediaList(body.media)).slice(0, 8);
  if (!title && !text && media.length === 0) return json({ error: "Sesame entry cannot be empty" }, 400);

  await supabase(env, `/rest/v1/treehole_sesame?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ title, text, media, edited_at: new Date().toISOString() })
  });

  const rows = await supabase(env, `/rest/v1/treehole_sesame?id=eq.${encodeURIComponent(id)}&select=*`);
  return json({ ok: true, entry: appDiaryFromRow(rows[0]) });
}

async function handleGetGoals(request, env) {
  await requireSession(request, env);
  const goals = await loadGoals(env);
  return json({ ok: true, goals });
}

async function handleSaveGoals(request, env) {
  await requireSession(request, env);
  const body = await readJson(request);
  const incoming = Array.isArray(body.goals) ? body.goals.slice(0, 50) : [];
  const goals = incoming.map((goal) => ({
    id: String(goal.id || crypto.randomUUID()),
    time: cleanGoalTime(goal.time),
    text: cleanGoalText(goal.text),
    doneDates: Array.isArray(goal.doneDates) ? goal.doneDates.filter(isDateKey) : [],
    updatedAt: new Date().toISOString()
  })).filter((goal) => goal.text);

  for (const goal of goals) {
    await supabase(env, "/rest/v1/treehole_goals", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: goal.id,
        goal_time: goal.time,
        text: goal.text,
        done_dates: goal.doneDates,
        updated_at: goal.updatedAt
      })
    });
  }

  return json({ ok: true, goals: await loadGoals(env) });
}

async function handleToggleGoal(request, env, id) {
  await requireSession(request, env);
  const body = await readJson(request);
  const date = isDateKey(body.date) ? body.date : new Date().toISOString().slice(0, 10);
  const rows = await supabase(env, `/rest/v1/treehole_goals?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!rows.length) return json({ error: "Goal not found" }, 404);

  const goal = appGoalFromRow(rows[0]);
  const dates = new Set(goal.doneDates);
  body.done === false ? dates.delete(date) : dates.add(date);
  goal.doneDates = Array.from(dates).sort();
  goal.updatedAt = new Date().toISOString();

  await supabase(env, `/rest/v1/treehole_goals?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ done_dates: goal.doneDates, updated_at: goal.updatedAt })
  });

  return json({ ok: true, goal });
}

async function handleUploadUrl(request, env) {
  await requireSession(request, env);
  const body = await readJson(request);
  const type = String(body.type || "").toLowerCase();
  const size = Number(body.size || 0);
  const extension = validateMediaType(type);
  if (!Number.isFinite(size) || size <= 0) return json({ error: "Invalid file size" }, 400);
  if (size > getMaxUploadMb(env) * 1024 * 1024) return json({ error: `File must be ${getMaxUploadMb(env)} MB or smaller` }, 413);

  const fileName = `${crypto.randomUUID()}${extension}`;
  const signed = await createSupabaseSignedUpload(env, fileName);
  return json({
    ok: true,
    uploadUrl: signed,
    media: {
      url: `/api/media/${encodeURIComponent(fileName)}`,
      type,
      name: safeFileName(body.name),
      size
    }
  });
}

async function handleMedia(request, env, pathname) {
  await requireSession(request, env);
  const fileName = pathname.replace(/^\/api\/media\//, "");
  const response = await fetch(`${getSupabaseUrl(env)}/storage/v1/object/${encodeURIComponent(getBucket(env))}/${fileName}`, {
    headers: supabaseHeaders(env)
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "private, max-age=300"
    }
  });
}

async function handleCallSignal(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const signalType = String(body.signalType || "");
  if (!new Set(["call-offer", "call-answer", "call-ice", "call-hangup", "call-decline"]).has(signalType)) {
    return json({ error: "Invalid call signal" }, 400);
  }

  await supabase(env, "/rest/v1/treehole_call_signals", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      sender_id: session.clientId,
      sender_name: session.name,
      signal_type: signalType,
      payload: body.payload || null,
      created_at: new Date().toISOString()
    })
  });

  return json({ ok: true });
}

async function handleGetCallSignals(request, env, url) {
  const session = await requireSession(request, env);
  const after = url.searchParams.get("after");
  const filter = after ? `&created_at=gt.${encodeURIComponent(after)}` : "";
  const rows = await supabase(env, `/rest/v1/treehole_call_signals?select=*&order=created_at.asc&limit=${MAX_CALL_SIGNALS}${filter}`);
  return json({
    ok: true,
    signals: rows
      .filter((row) => row.sender_id !== session.clientId)
      .map((row) => ({
        signalType: row.signal_type,
        senderId: row.sender_id,
        senderName: row.sender_name,
        payload: row.payload,
        time: row.created_at
      }))
  });
}

async function handleEvents(request, env) {
  await requireSession(request, env);
  const body = `event: init\ndata: ${JSON.stringify({ messages: await loadMessages(env), online: 1, stale: false })}\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache"
    }
  });
}

async function loadMessages(env) {
  const rows = await supabase(env, `/rest/v1/treehole_messages?select=*&order=created_at.desc&limit=${MAX_MESSAGES}`);
  return rows.map(appMessageFromRow).reverse();
}

async function loadGoals(env) {
  const rows = await supabase(env, "/rest/v1/treehole_goals?select=*&order=goal_time.asc,text.asc");
  return rows.map(appGoalFromRow);
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

function appDiaryFromRow(row = {}) {
  return {
    id: row.id,
    time: row.created_at,
    clientId: row.client_id,
    author: row.author,
    title: row.title || "",
    text: row.text || "",
    media: Array.isArray(row.media) ? row.media : [],
    editedAt: row.edited_at || null
  };
}

function appGoalFromRow(row) {
  return {
    id: row.id,
    time: row.goal_time || "",
    text: row.text || "",
    doneDates: Array.isArray(row.done_dates) ? row.done_dates : [],
    updatedAt: row.updated_at || row.created_at || new Date().toISOString()
  };
}

async function createSupabaseSignedUpload(env, fileName) {
  const response = await fetch(`${getSupabaseUrl(env)}/storage/v1/object/upload/sign/${encodeURIComponent(getBucket(env))}/${encodeURIComponent(fileName)}`, {
    method: "POST",
    headers: supabaseHeaders(env, { "Content-Type": "application/json", "x-upsert": "false" }),
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`Could not create upload URL: ${response.status} ${JSON.stringify(data)}`), { statusCode: 502 });

  let uploadUrl = data.signedUrl || data.signedURL || data.signed_url || data.url;
  if (uploadUrl && uploadUrl.startsWith("/")) uploadUrl = `${getSupabaseUrl(env)}/storage/v1${uploadUrl}`;
  if (!uploadUrl && data.token) {
    uploadUrl = `${getSupabaseUrl(env)}/storage/v1/object/upload/sign/${encodeURIComponent(getBucket(env))}/${encodeURIComponent(fileName)}?token=${encodeURIComponent(data.token)}`;
  }
  if (!uploadUrl) throw Object.assign(new Error("Supabase did not return a signed upload URL"), { statusCode: 502 });
  return uploadUrl;
}

async function supabase(env, path, options = {}) {
  const response = await fetch(`${getSupabaseUrl(env)}${path}`, {
    ...options,
    headers: supabaseHeaders(env, {
      "Content-Type": "application/json",
      ...(options.headers || {})
    })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`Supabase error ${response.status}: ${text}`), { statusCode: 502 });
  return data;
}

function supabaseHeaders(env, extra = {}) {
  const key = getServiceKey(env);
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function requireSession(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  const session = token ? await verifySessionToken(env, token) : null;
  if (!session) throw Object.assign(new Error("请先输入密码登录"), { statusCode: 401 });
  return session;
}

async function createSessionToken(env, payload) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(env, encoded);
  return `${encoded}.${signature}`;
}

async function verifySessionToken(env, token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature || await hmac(env, encoded) !== signature) return null;
  const payload = JSON.parse(base64UrlDecode(encoded));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function hmac(env, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(getSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function normalizeMediaList(items) {
  return Array.isArray(items) ? items.map(mediaFromUploadedReference).filter(Boolean).slice(0, 8) : [];
}

function mediaFromUploadedReference(media) {
  if (!media || typeof media.url !== "string") return null;
  const type = String(media.type || "").toLowerCase();
  validateMediaType(type);
  if (!media.url.startsWith("/api/media/")) throw Object.assign(new Error("Invalid uploaded media URL"), { statusCode: 400 });
  return { url: media.url, type, name: safeFileName(media.name), size: Number(media.size || 0) };
}

function validateMediaType(mime) {
  const extension = uploadExtensions.get(String(mime || "").toLowerCase());
  if (!extension) throw Object.assign(new Error("Only image and video files are allowed"), { statusCode: 400 });
  return extension;
}

async function readJson(request) {
  return request.json().catch(() => ({}));
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function getCookie(request, name) {
  const cookies = String(request.headers.get("Cookie") || "").split(";").map((item) => item.trim());
  const found = cookies.find((item) => item.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeURIComponent(Array.from(atob(padded)).map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
}

function getPassword(env) { return env.CHAT_PASSWORD || "liu123"; }
function getSecret(env) { return env.SESSION_SECRET || getPassword(env); }
function getSupabaseUrl(env) { return String(env.SUPABASE_URL || "").replace(/\/+$/, ""); }
function getServiceKey(env) { return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || ""; }
function getBucket(env) { return env.SUPABASE_BUCKET || "treehole-media"; }
function getMaxUploadMb(env) { return Number(env.MAX_UPLOAD_MB || 2048); }
function cleanName(value) { return String(value || "").trim().slice(0, 24) || "访客"; }
function cleanText(value) { return String(value || "").trim().slice(0, 2000); }
function cleanTitle(value) { return String(value || "").trim().slice(0, 80); }
function cleanDiaryText(value) { return String(value || "").trim().slice(0, 12000); }
function cleanGoalText(value) { return String(value || "").trim().slice(0, 120); }
function cleanGoalTime(value) { return /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function isDateKey(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }
function safeFileName(value) {
  return String(value || "media").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_").slice(0, 80);
}
