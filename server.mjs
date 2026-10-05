// Голосовая линия на GPT-Live (gpt-live-1).
// Сервер держит ключ OpenAI у себя, создаёт Live-сессию и обменивает SDP-оффер браузера
// на ответ. Телефонные звонки идут через мост на сервере телефонии (lib/calls.mjs, pbx-server/).
import express from "express";
import OpenAI from "openai";
import http from "node:http";
import { WebSocketServer } from "ws";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { defaultProfile, loadProfiles, sessionFor, jobSessionFor, VOICES } from "./lib/profiles.mjs";
import { openJobStore } from "./lib/job-store.mjs";
import { Scheduler } from "./lib/scheduler.mjs";
import { mountJobsApi } from "./lib/jobs-api.mjs";
import { CallHub } from "./lib/calls.mjs";
import { brainLog, callSummary, LOG_DIR, Transcript } from "./lib/log.mjs";

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(here, ".env")); } catch { /* .env необязателен */ }

const port = Number(process.env.PORT ?? 3000);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? `http://localhost:${port},http://127.0.0.1:${port}`)
    .split(",").map((o) => o.trim()).filter(Boolean),
);
const PER_IP_HOUR = Number(process.env.SESSIONS_PER_IP_HOUR ?? 20);
const TOTAL_HOUR = Number(process.env.SESSIONS_TOTAL_HOUR ?? 120);
const BACKEND_MODEL = process.env.LIVE_BACKEND_MODEL ?? "gpt-5.6-terra";
const DEFAULT_VOICE = VOICES.has(process.env.DEFAULT_VOICE) ? process.env.DEFAULT_VOICE : "alloy";
const NUL = String.fromCharCode(0);

/* ── Лимиты браузерных сессий ───────────────────────────────────────────── */
const opened = new Map();
function overLimit(ip) {
  const now = Date.now(), hour = 3_600_000;
  let total = 0;
  for (const [key, times] of opened) {
    const recent = times.filter((t) => now - t < hour);
    if (recent.length) opened.set(key, recent); else opened.delete(key);
    total += recent.length;
  }
  const mine = opened.get(ip) ?? [];
  if (mine.length >= PER_IP_HOUR) return "с вашего адреса уже открыто много сессий, попробуйте позже";
  if (total >= TOTAL_HOUR) return "линия сейчас перегружена, попробуйте через несколько минут";
  opened.set(ip, [...mine, now]);
  return null;
}

/* ── Общее: собрать профиль и параметры сессии из запроса ───────────────── */
async function briefFrom(body) {
  const profiles = await loadProfiles();
  const wanted = typeof body.profile === "string" ? body.profile : "";
  const profile = wanted ? (profiles.get(wanted) ?? null) : defaultProfile();
  if (!profile) throw new Error(`профиля «${wanted}» нет`);
  const files = Array.isArray(body.files)
    ? body.files.slice(0, 50).map((f) => ({ name: String(f?.name ?? ""), text: String(f?.text ?? "") })) : [];
  return {
    profile,
    voice: typeof body.voice === "string" ? body.voice : "",
    context: typeof body.context === "string" ? body.context : "",
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    files,
  };
}
const metaOf = (profile, session) => ({
  voice: session.audio.output.voice, backendModel: BACKEND_MODEL,
  profile: profile.id, label: profile.label, search: profile.search,
});

/* ── Сервер ─────────────────────────────────────────────────────────────── */
// Без ключа сервер всё равно поднимается: интерфейс покажет, что ключа нет.
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "not-set", maxRetries: 0 });
const hub = process.env.BRIDGE_URL && process.env.BRIDGE_TOKEN
  ? new CallHub({ url: process.env.BRIDGE_URL, token: process.env.BRIDGE_TOKEN, openai: client })
  : null;

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "30mb" }));     // файлы-инструкции приходят base64 в JSON
app.use(express.static(resolve(here, "public"), { index: "index.html" }));

let jobStore, scheduler;
try {
  jobStore = openJobStore({path: process.env.JOB_DB_PATH ?? resolve(here, "data/calls.sqlite")});
  scheduler = new Scheduler({store: jobStore, hub});
  scheduler.start();
} catch (error) { jobStore?.close(); jobStore = null; console.error("Scheduler недоступен:", error.message); }
mountJobsApi(app, {store: jobStore, scheduler, allowedOrigins, buildBrief: async input => {
  if (input.voice && !VOICES.has(input.voice)) throw Object.assign(new Error("Неизвестный голос"), {status:400});
  let brief; try { brief = await briefFrom(input); } catch (e) { e.status = 400; throw e; }
  const session = jobSessionFor(brief.profile, input, {backendModel: BACKEND_MODEL});
  return {profile:brief.profile, session};
}});
app.use(["/api/calls", "/api/campaigns"], (req, res, next) => {
  if (req.method === "POST" && (!jobStore || scheduler?.failed)) { res.status(503).json({error:"Хранилище scheduler недоступно. Новые звонки остановлены"}); return; }
  next();
});


app.get("/api/config", async (_request, response) => {
  const profiles = await loadProfiles();
  response.json({
    profiles: [...profiles.values()].map(({ id, label, description, name, voice, phone, speech }) =>
      ({ id, label, description, name, voice, phone, speech })),
    voices: [...VOICES], defaultVoice: DEFAULT_VOICE,
    backendModel: BACKEND_MODEL,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    pbx: hub ? hub.status() : { configured: false },
  });
});

/* ── Файлы-инструкции → текст в базу знаний ─────────────────────────────── */
app.post("/api/files", async (request, response) => {
  const { name, data } = request.body ?? {};
  if (typeof name !== "string" || typeof data !== "string") { response.status(400).json({ error: "нужны name и data (base64)" }); return; }
  const buf = Buffer.from(data, "base64");
  if (buf.length > 20 * 1024 * 1024) { response.status(413).json({ error: "файл больше 20 МБ" }); return; }
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  try {
    let text;
    if (ext === "pdf") {
      const parser = new PDFParse({ data: buf });
      text = (await parser.getText()).text.replace(/\n-- \d+ of \d+ --\n/g, "\n");
      await parser.destroy?.();
    } else if (ext === "docx") {
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (ext === "html" || ext === "htm") {
      text = buf.toString("utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    } else if (["txt", "md", "csv", "json", "tsv", "log"].includes(ext)) {
      text = buf.toString("utf8");
    } else {
      response.status(415).json({ error: `формат .${ext} не поддерживается — txt, md, csv, json, pdf, docx, html` }); return;
    }
    text = text.split(NUL).join("").trim().slice(0, 200_000);
    if (!text) { response.status(422).json({ error: "в файле не нашлось текста" }); return; }
    brainLog("файл прочитан", { name, chars: text.length });
    response.json({ name, chars: text.length, text });
  } catch (error) {
    response.status(422).json({ error: `не удалось прочитать: ${error.message}` });
  }
});

/* ── Разговор в браузере (WebRTC) ───────────────────────────────────────── */
app.post("/api/session", async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { response.status(403).json({ error: "Запрос пришёл с неизвестного адреса" }); return; }
  if (!process.env.OPENAI_API_KEY) { response.status(503).json({ error: "На сервере не задан OPENAI_API_KEY" }); return; }
  const { sdp } = request.body ?? {};
  if (typeof sdp !== "string" || !sdp.trim()) { response.status(400).json({ error: "Нужен SDP-оффер от браузера" }); return; }
  let brief;
  try { brief = await briefFrom(request.body); } catch (error) { response.status(400).json({ error: error.message }); return; }
  const limit = overLimit(request.ip ?? "unknown");
  if (limit) { response.status(429).json({ error: `Не получилось: ${limit}` }); return; }

  const session = sessionFor(brief.profile, { ...brief, backendModel: BACKEND_MODEL });
  try {
    const result = await client.live.create({ session, transport: { type: "webrtc", sdp } });
    brainLog("браузер: сессия открыта", { session: result.session.id, profile: brief.profile.id, voice: session.audio.output.voice, files: brief.files.length, ip: request.ip });
    response.status(201).json({ session: result.session, transport: result.transport, meta: metaOf(brief.profile, session) });
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) throw error;
    brainLog("браузер: сессия не открылась", { status: error.status, message: error.message, ip: request.ip });
    response.status(error.status ?? 502).json({ error: `Не удалось открыть сессию (${error.status ?? "нет ответа"}): ${error.message}` });
  }
});

// Итог браузерного разговора приходит от страницы: сервер сам его событий не видит.
app.post("/api/session/report", (request, response) => {
  const r = request.body ?? {};
  if (typeof r.id !== "string" || !Array.isArray(r.turns)) { response.status(400).json({ error: "нужны id и turns" }); return; }
  const transcript = new Transcript();
  for (const t of r.turns.slice(0, 2000)) transcript.add(t.channel === "you" ? "you" : "agent", String(t.text ?? ""), Number(t.startMs) || 0, Number(t.endMs) || 0);
  const seconds = Number(r.usage?.seconds) || 0;
  callSummary({
    id: r.id, mode: "web", to: "", name: "", profile: String(r.profile ?? ""), label: String(r.label ?? ""),
    voice: String(r.voice ?? ""), live_session: r.id,
    started_at: r.startedAt ? new Date(Number(r.startedAt)).toISOString() : null, answered_at: null,
    ended_at: new Date().toISOString(), ring_seconds: 0, talk_seconds: seconds, reason: String(r.reason ?? ""),
    usage_seconds: seconds, cost_usd: Number(((seconds / 60) * 0.05).toFixed(4)),
    delegations: Number(r.tasks) || 0, errors: 0, turns: transcript.turns.length,
  }, transcript.render({ you: "Вы", agent: "Агент" }));
  brainLog("браузер: сводка записана", { session: r.id, talk: seconds, reason: r.reason });
  response.json({ ok: true });
});

/* ── Телефония ──────────────────────────────────────────────────────────── */
app.get("/api/pbx/status", (_request, response) => response.json(hub ? hub.status() : { configured: false }));

app.post("/api/calls", async (request, response) => {
  if (!hub) { response.status(503).json({ error: "Мост с АТС не настроен: нет BRIDGE_URL / BRIDGE_TOKEN в .env" }); return; }
  const { to, name, record } = request.body ?? {};
  if (typeof to !== "string" || !to.trim()) { response.status(400).json({ error: "Нужен номер" }); return; }
  let brief;
  try { brief = await briefFrom(request.body); } catch (error) { response.status(400).json({ error: error.message }); return; }
  const clientName = typeof name === "string" ? name.trim() : "";
  const session = sessionFor(brief.profile, { ...brief, backendModel: BACKEND_MODEL, phone: true, name: clientName });
  try {
    const call = hub.start({ to: to.trim(), name: clientName, session, label: brief.profile.label, profileId: brief.profile.id,
                             record: Boolean(record), agentName: brief.profile.name });
    response.status(201).json({ id: call.id, slot: call.slot, meta: metaOf(brief.profile, session) });
  } catch (error) {
    response.status(503).json({ error: error.message });
  }
});

app.delete("/api/calls/:id", (request, response) => {
  const call = hub?.byId(request.params.id);
  if (!call) { response.status(404).json({ error: "Такого звонка нет" }); return; }
  call.hangup(); response.json({ ok: true });
});
app.post("/api/calls/:id/mute", (request, response) => {
  const call = hub?.byId(request.params.id);
  if (!call) { response.status(404).json({ error: "Такого звонка нет" }); return; }
  call.mute(Boolean(request.body?.muted)); response.json({ ok: true });
});

// Поток событий звонка (и для завершённого — вся история, чтобы открыть расшифровку из очереди)
app.get("/api/calls/:id/events", (request, response) => {
  const call = hub?.byId(request.params.id);
  if (!call) { response.status(404).end(); return; }
  response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  response.flushHeaders();
  const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  call.history.forEach(send);
  if (call.state === "ended") { setTimeout(() => response.end(), 300); return; }
  call.on("event", send);
  call.once("closed", () => setTimeout(() => { call.off("event", send); response.end(); }, 300));
  request.on("close", () => call.off("event", send));
});

/* ── Очередь звонков: по списку, по одному ──────────────────────────────── */
const campaigns = new Map();
const REASONS = { "Normal Clearing": "разговор состоялся", "No answer": "не ответил", "User busy": "занято",
                  "Call Rejected": "отклонён", "No user responding": "не отвечает", "Unallocated (unassigned) number": "нет такого номера" };

app.post("/api/campaigns", async (request, response) => {
  if (!hub) { response.status(503).json({ error: "Мост с АТС не настроен: нет BRIDGE_URL / BRIDGE_TOKEN в .env" }); return; }
  const raw = Array.isArray(request.body?.entries) ? request.body.entries.slice(0, 200) : [];
  const entries = raw.map((e) => ({ to: String(e?.to ?? "").trim(), name: String(e?.name ?? "").trim().slice(0, 60) }))
    .filter((e) => e.to.startsWith("test:") || e.to.replace(/\D/g, "").length >= 10);
  if (!entries.length) { response.status(400).json({ error: "В списке нет ни одного номера" }); return; }
  let brief;
  try { brief = await briefFrom(request.body); } catch (error) { response.status(400).json({ error: error.message }); return; }
  const campaign = {
    id: `cp-${Date.now().toString(36)}`, done: false, stop: false, startedAt: new Date().toISOString(),
    entries: entries.map((e) => ({ ...e, status: "queued", callId: null, result: "", talk: 0 })),
  };
  campaigns.set(campaign.id, campaign);
  while (campaigns.size > 50) campaigns.delete(campaigns.keys().next().value);
  brainLog("очередь: старт", { campaign: campaign.id, entries: campaign.entries.length, profile: brief.profile.id });
  runCampaign(campaign, brief, Boolean(request.body?.record));
  response.status(201).json(campaign);
});
async function runCampaign(campaign, brief, record) {
  for (const entry of campaign.entries) {
    if (campaign.stop) { entry.status = "failed"; entry.result = "остановлено"; continue; }
    if (!hub.connected) { entry.status = "failed"; entry.result = "мост с АТС не подключён"; continue; }
    const session = sessionFor(brief.profile, { ...brief, backendModel: BACKEND_MODEL, phone: true, name: entry.name });
    let call;
    try {
      call = hub.start({ to: entry.to, name: entry.name, session, label: brief.profile.label, profileId: brief.profile.id,
                         record, agentName: brief.profile.name });
    } catch (error) { entry.status = "failed"; entry.result = error.message; continue; }
    entry.status = "active"; entry.callId = call.id;
    await new Promise((done) => call.once("closed", done));
    entry.talk = call.answeredAt ? Math.round((call.endedAt - call.answeredAt) / 1000) : 0;
    entry.status = call.answeredAt ? "done" : "failed";
    entry.result = REASONS[call.reason] ?? call.reason ?? "";
    brainLog("очередь: звонок завершён", { campaign: campaign.id, to: entry.to, status: entry.status, talk: entry.talk, reason: call.reason });
    if (!campaign.stop) await new Promise((r) => setTimeout(r, 3000));
  }
  campaign.done = true;
  brainLog("очередь: завершена", { campaign: campaign.id, done: campaign.entries.filter((e) => e.status === "done").length, total: campaign.entries.length });
}
app.get("/api/campaigns/:id", (request, response) => {
  const c = campaigns.get(request.params.id);
  c ? response.json(c) : response.status(404).json({ error: "Такой очереди нет" });
});
app.delete("/api/campaigns/:id", (request, response) => {
  const c = campaigns.get(request.params.id);
  if (!c) { response.status(404).json({ error: "Такой очереди нет" }); return; }
  c.stop = true;
  const active = c.entries.find((e) => e.status === "active");
  if (active) hub?.byId(active.callId)?.hangup();
  response.json({ ok: true });
});

/* ── Прослушивание звонка в браузере: кадры [0 = клиент | 1 = агент][A-law] ── */
const server = http.createServer(app);
const audioSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const match = /^\/api\/calls\/([^/?]+)\/audio$/.exec(request.url ?? "");
  const call = match && hub?.byId(match[1]);
  if (!call || call.state === "ended") { socket.destroy(); return; }
  audioSockets.handleUpgrade(request, socket, head, (ws) => {
    const relay = (dir, bytes) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([dir]), bytes])); };
    call.on("audio", relay);
    call.once("closed", () => { call.off("audio", relay); ws.close(); });
    ws.on("close", () => call.off("audio", relay));
  });
});

const profiles = await loadProfiles();   // ранняя проверка: битый профиль виден сразу
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  brainLog("сервер: старт", { url: `http://localhost:${port}`, profiles: [...profiles.keys()], bridge: hub ? process.env.BRIDGE_URL : null, logs: LOG_DIR });
  if (!process.env.OPENAI_API_KEY) console.warn("! OPENAI_API_KEY не задан — сессии не откроются");
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (shuttingDown) return; shuttingDown = true;
  scheduler?.stop(); server.close();
  setTimeout(() => { jobStore?.close(); process.exit(0); }, 16000).unref();
});
