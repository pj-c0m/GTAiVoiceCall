// Телефонные звонки: «мозг» держит одно WebSocket-соединение с диалером на сервер телефонии,
// на каждый звонок открывает Live-сессию (A-law 8 кГц) и гонит звук в обе стороны.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { LiveWS } from "openai/resources/live/ws";
import { brainLog, callEvent, callSummary, Transcript } from "./log.mjs";

const FRAME = 160;                 // 20 мс A-law
const INPUT_BATCH = FRAME * 3;     // шлём в модель по 60 мс
const SILENCE_CAP = 8000 * 2;      // буфер входа до session.started — 2 с

// Пиковый уровень кадра A-law (G.711) — для полосы дуплекса в интерфейсе
function alawLevel(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i] ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else t = (t + 0x108) << (seg - 1);
    if (t > peak) peak = t;
  }
  return Math.min(1, (peak / 32768) * 2.4);
}

export class PhoneCall extends EventEmitter {
  constructor(hub, slot, { to, name = "", session, label, profileId = "" }) {
    super();
    this.hub = hub;
    this.slot = slot;
    this.to = to;
    this.name = name;
    this.label = label;
    this.profileId = profileId;
    this.session = session;
    this.id = `pc-${Date.now().toString(36)}-${slot}`;
    this.state = "dialing";
    this.liveState = "idle";
    this.history = [];
    this.inbuf = [];
    this.pending = Buffer.alloc(0);
    this.levels = { you: 0, agent: 0 };
    // Для лога и сводки
    this.transcript = new Transcript();
    this.startedAt = Date.now(); this.answeredAt = null; this.endedAt = null;
    this.liveId = null; this.usage = null; this.delegations = 0; this.errors = 0; this.reason = null;
    this.summarized = false;
    this.live = new LiveWS(hub.openai);
    this.live.on("event", (e) => this.onLive(e));
    this.live.on("error", (error) => this.push({ type: "error", error: { code: "live", message: error.message } }));
    this.live.socket.on("open", () => brainLog("live: сокет открыт", { call: this.id }));
    this.live.socket.on("close", (code, reason) => {
      brainLog("live: сокет закрыт", { call: this.id, code, reason: String(reason ?? "") });
      if (this.liveState !== "closed") this.finish("live-соединение закрылось");
    });
    this.meterTimer = setInterval(() => {
      if (this.state === "answered") this.push({ type: "meter", ...this.levels });
      this.levels.you *= 0.6; this.levels.agent *= 0.6;
    }, 100);
  }

  push(event) {
    this.history.push(event);
    if (this.history.length > 2000) this.history.shift();
    if (event.type !== "meter") callEvent(this.id, event);
    switch (event.type) {
      case "session.input_transcript.delta": this.transcript.add("you", event.delta, event.start_ms, event.end_ms); break;
      case "session.output_transcript.delta": this.transcript.add("agent", event.delta, event.start_ms, event.end_ms); break;
      case "session.started": this.liveId = event.session?.id ?? null; break;
      case "session.usage.updated": this.usage = event.usage; break;
      case "session.closed": this.usage = event.usage ?? this.usage; break;
      case "session.delegation.created": this.delegations++; break;
      case "error": this.errors++; break;
    }
    this.emit("event", event);
  }

  // ── события от диалера ─────────────────────────────────────────────────
  onBridge(msg) {
    if (msg.id) this.dialerId = msg.id;
    if (msg.state === "answered") {
      this.state = "answered";
      this.answeredAt = Date.now();
      this.push({ type: "call.state", state: "answered", to: this.to });
      this.liveState = "starting";
      this.live.send({ type: "session.start", event_id: "start", session: this.session });
    } else if (msg.state === "ended") {
      this.reason = msg.reason ?? "ended";
      this.push({ type: "call.state", state: "ended", reason: msg.reason, talked: msg.talked, to: this.to });
      this.finish(msg.reason ?? "ended");
    } else {
      this.state = msg.state;
      this.push({ type: "call.state", state: msg.state, to: this.to });
    }
  }

  fromPhone(payload) {
    this.levels.you = Math.max(this.levels.you, alawLevel(payload));
    this.emit("audio", 0, payload);
    if (this.liveState === "live") {
      this.pending = Buffer.concat([this.pending, payload]);
      while (this.pending.length >= INPUT_BATCH) {
        this.live.send({ type: "session.input_audio.append", audio: this.pending.subarray(0, INPUT_BATCH).toString("base64") });
        this.pending = this.pending.subarray(INPUT_BATCH);
      }
    } else if (this.liveState === "starting") {
      this.inbuf.push(payload);
      while (this.inbuf.length * FRAME > SILENCE_CAP) this.inbuf.shift();
    }
  }

  // ── события от модели ──────────────────────────────────────────────────
  onLive(e) {
    switch (e.type) {
      case "session.started":
        this.liveState = "live";
        this.push(e);
        for (const chunk of this.inbuf.splice(0)) this.fromPhone(chunk);
        break;
      case "session.output_audio.delta": {
        const bytes = Buffer.from(e.delta, "base64");
        this.levels.agent = Math.max(this.levels.agent, alawLevel(bytes));
        this.emit("audio", 1, bytes);
        if (this.state === "answered") this.hub.sendAudio(this.slot, bytes);
        break;
      }
      case "session.closed":
        this.liveState = "closed";
        this.push(e);
        if (this.state !== "ended") this.hub.hangup(this.slot);
        this.teardown();
        break;
      default:
        this.push(e);
    }
  }

  mute(on) {
    if (this.liveState === "live")
      this.live.send({ type: on ? "session.input_audio.mute" : "session.input_audio.unmute" });
  }

  hangup() { this.hub.hangup(this.slot); }

  // Звонок завершён (или так и не состоялся): закрываем Live-сессию, дожидаясь итога.
  finish(reason) {
    if (this.state === "ended") return;
    this.state = "ended";
    this.reason ??= reason;
    if (this.liveState === "live" || this.liveState === "starting") {
      this.live.send({ type: "session.close" });
      setTimeout(() => { if (this.liveState !== "closed") { this.push({ type: "info", code: "no_final_usage", message: "session.closed не пришёл" }); this.liveState = "closed"; this.teardown(); } }, 15000);
    } else {
      this.liveState = "closed";
      this.push({ type: "session.closed", reason: reason, usage: { seconds: 0 }, session: { id: this.id } });
      this.teardown();
    }
  }

  teardown() {
    clearInterval(this.meterTimer);
    try { this.live.close(); } catch {}
    this.hub.calls.delete(this.slot);
    this.hub.finished.set(this.id, this);
    while (this.hub.finished.size > 100) this.hub.finished.delete(this.hub.finished.keys().next().value);
    this.summarize();
    this.emit("closed");
  }

  summarize() {
    if (this.summarized) return;
    this.summarized = true;
    this.endedAt = Date.now();
    const seconds = this.usage?.seconds ?? 0;
    const summary = {
      id: this.id, dialer_id: this.dialerId ?? null, mode: "phone", to: this.to, name: this.name, profile: this.profileId, label: this.label,
      voice: this.session?.audio?.output?.voice ?? "", live_session: this.liveId,
      started_at: new Date(this.startedAt).toISOString(),
      answered_at: this.answeredAt ? new Date(this.answeredAt).toISOString() : null,
      ended_at: new Date(this.endedAt).toISOString(),
      ring_seconds: Math.round(((this.answeredAt ?? this.endedAt) - this.startedAt) / 1000),
      talk_seconds: this.answeredAt ? Math.round((this.endedAt - this.answeredAt) / 1000) : 0,
      reason: this.reason, usage_seconds: seconds, cost_usd: Number(((seconds / 60) * 0.05).toFixed(4)),
      delegations: this.delegations, errors: this.errors, turns: this.transcript.turns.length,
    };
    callSummary(summary, this.transcript.render({ you: this.name || "Клиент", agent: this.agentName || "Агент" }));
    brainLog("звонок: сводка записана", { call: this.id, talk: summary.talk_seconds, reason: summary.reason, cost: summary.cost_usd });
  }
}

export class CallHub {
  constructor({ url, token, openai }) {
    this.url = url;
    this.token = token;
    this.openai = openai;
    this.calls = new Map();
    this.finished = new Map();   // последние завершённые — чтобы открыть расшифровку после звонка
    this.connected = false;
    this.attempt = 0;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on("open", () => { this.connected = true; this.attempt = 0; brainLog("мост: подключён", { url: this.url }); });
    ws.on("message", (data, isBinary) => {
      if (isBinary) { this.calls.get(data[0])?.fromPhone(data.subarray(1)); return; }
      const msg = JSON.parse(data.toString());
      if (msg.type === "call.state") this.calls.get(msg.slot)?.onBridge(msg);
      else if (msg.type === "hello") brainLog("мост: hello", { active_on_server: msg.calls.length });
    });
    ws.on("close", (code, reason) => {
      this.connected = false;
      const dropped = this.calls.size;
      for (const call of this.calls.values()) call.finish("мост с АТС отключился");
      const delay = Math.min(30000, 2000 * 2 ** this.attempt++);
      brainLog("мост: отключён", { code, reason: reason?.toString?.() ?? "", retry_in_s: delay / 1000, dropped_calls: dropped });
      setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (error) => brainLog("мост: ошибка", { message: error.message }));
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  }

  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  sendAudio(slot, bytes) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.concat([Buffer.from([slot]), bytes]), { binary: true });
  }
  hangup(slot) { this.send({ type: "call.hangup", slot }); }

  status() {
    return { configured: true, connected: this.connected,
             calls: [...this.calls.values()].map((c) => ({ id: c.id, to: c.to, state: c.state, label: c.label })) };
  }
  byId(id) { return [...this.calls.values()].find((c) => c.id === id) ?? this.finished.get(id); }

  start({ to, name = "", session, label, profileId = "", record = false }) {
    if (!this.connected) throw new Error("мост с АТС не подключён");
    let slot = 1;
    while (this.calls.has(slot)) slot++;
    if (slot > 255) throw new Error("нет свободных слотов");
    const call = new PhoneCall(this, slot, { to, name, session, label, profileId });
    this.calls.set(slot, call);
    brainLog("звонок: старт", { call: call.id, slot, to, name, profile: profileId, voice: session?.audio?.output?.voice, record });
    call.push({ type: "call.state", state: "dialing", to });
    this.send({ type: "call.start", slot, to, record: Boolean(record) });
    return call;
  }
}
