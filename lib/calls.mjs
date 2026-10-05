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
  constructor(hub, slot, { to, name = "", session, label, profileId = "", maxDurationSeconds = 300 }) {
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
    this.liveRequested = false; this.liveClosureConfirmed = false;
    this.dialTimer = setTimeout(() => { this.hangup(); this.finish("Истекло время ожидания ответа"); }, 60000);
    this.pbxEnded = false; this.teardownDone = false; this.maxDurationSeconds = maxDurationSeconds;
    this.live = new LiveWS(hub.openai);
    this.live.on("event", (e) => this.onLive(e));
    this.live.on("error", (error) => {
      this.push({ type: "error", error: { code: "live", message: error.message } });
      if (this.state === "ended") return;
      this.hub.hangup(this.slot);
      // Неуспешный session.start не породил Live-сессию с итоговым usage.
      if (this.liveState !== "live") this.liveState = "closed";
      this.finish("ошибка Live");
    });
    this.live.socket.on("open", () => brainLog("live: сокет открыт", { call: this.id }));
    this.live.socket.on("close", (code, reason) => {
      this.liveClosureConfirmed = true;
      this.hub.pendingLive?.delete(this.slot);
      brainLog("live: сокет закрыт", { call: this.id, code, reason: String(reason ?? "") });
      if (this.liveState !== "closed") {
        this.hub.hangup(this.slot);
        this.liveState = "closed";
        if (this.state === "ended") this.teardown(); else this.finish("live-соединение закрылось");
      }
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
      if (this.answeredAt || this.state === "ended") return;
      clearTimeout(this.dialTimer); this.liveRequested = true;
      this.state = "answered";
      this.answeredAt = Date.now();
      this.durationTimer = setTimeout(() => this.hangup(), this.maxDurationSeconds * 1000);
      this.push({ type: "call.state", state: "answered", to: this.to });
      this.liveState = "starting";
      this.live.send({ type: "session.start", event_id: "start", session: this.session });
    } else if (msg.state === "ended") {
      this.pbxEndedAt ??= Date.now();
      this.pbxEnded = true;
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
        this.liveClosureConfirmed = true;
        this.hub.pendingLive?.delete(this.slot);
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
      this.closeTimer = setTimeout(() => { if (this.liveState !== "closed") { this.push({ type: "info", code: "no_final_usage", message: "session.closed не пришёл" }); this.liveState = "closed"; this.teardown(); } }, 15000);
    } else {
      this.liveState = "closed";
      this.push({ type: "info", code: "no_final_usage", message: "Live-сессия не вернула итоговый usage" });
      this.teardown();
    }
  }

  result() {
    const seconds = this.usage?.seconds ?? null;
    return { callState: this.state, liveState: this.liveState, pbxEnded: Boolean(this.pbxEnded), liveClosed: this.liveState === "closed" && (!this.liveRequested || this.liveClosureConfirmed),
      cleanupConfirmed: Boolean(this.pbxEnded) && this.liveState === "closed" && (!this.liveRequested || this.liveClosureConfirmed), reason: this.reason,
      transcript: this.transcript.turns, usage: this.usage ?? null, startedAt: this.startedAt,
      answeredAt: this.answeredAt ?? null, endedAt: this.pbxEndedAt ?? this.endedAt ?? null,
      talkSeconds: this.answeredAt ? Math.round(((this.pbxEndedAt ?? this.endedAt ?? Date.now()) - this.answeredAt) / 1000) : 0,
      ringSeconds: Math.round(((this.answeredAt ?? this.pbxEndedAt ?? this.endedAt ?? Date.now()) - this.startedAt) / 1000),
      liveRateUsdPerMinute: 0.05, estimatedLiveCostUsd: seconds === null ? null : seconds / 60 * 0.05 };
  }

  teardown() {
    if (this.teardownDone) return;
    this.teardownDone = true;
    clearTimeout(this.durationTimer); clearTimeout(this.dialTimer); clearTimeout(this.closeTimer);
    if (!this.pbxEnded) this.hub.pendingCleanup?.add(this.slot);
    if (this.liveRequested && !this.liveClosureConfirmed) (this.hub.pendingLive ??= new Set()).add(this.slot);
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
    this.endedAt = this.pbxEndedAt ?? Date.now();
    const seconds = this.usage?.seconds ?? null;
    const summary = {
      id: this.id, dialer_id: this.dialerId ?? null, mode: "phone", to: this.to, name: this.name, profile: this.profileId, label: this.label,
      voice: this.session?.audio?.output?.voice ?? "", live_session: this.liveId,
      started_at: new Date(this.startedAt).toISOString(),
      answered_at: this.answeredAt ? new Date(this.answeredAt).toISOString() : null,
      ended_at: new Date(this.endedAt).toISOString(),
      ring_seconds: Math.round(((this.answeredAt ?? this.endedAt) - this.startedAt) / 1000),
      talk_seconds: this.answeredAt ? Math.round((this.endedAt - this.answeredAt) / 1000) : 0,
      reason: this.reason, usage_seconds: seconds, cost_usd: seconds === null ? null : Number(((seconds / 60) * 0.05).toFixed(4)),
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
    this.ready = false; this.pbxSlots = new Set(); this.pendingCleanup = new Set(); this.pendingLive = new Set();
    this.attempt = 0;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    // aiohttp 3.14 закрывает сжатую команду после ping с 1002; PCMA сжатию не нуждается.
    const ws = new WebSocket(this.url, { perMessageDeflate: false, headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on("open", () => { this.connected = true; this.attempt = 0; brainLog("мост: подключён", { url: this.url }); });
    ws.on("message", (data, isBinary) => {
      if (isBinary) { this.calls.get(data[0])?.fromPhone(data.subarray(1)); return; }
      const msg = JSON.parse(data.toString());
      this.onControl(msg);
    });
    ws.on("close", (code, reason) => {
      this.connected = false; this.ready = false;
      const dropped = this.calls.size;
      for (const call of this.calls.values()) call.finish("мост с АТС отключился");
      const delay = Math.min(30000, 2000 * 2 ** this.attempt++);
      brainLog("мост: отключён", { code, reason: reason?.toString?.() ?? "", retry_in_s: delay / 1000, dropped_calls: dropped });
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (error) => brainLog("мост: ошибка", { message: error.message }));
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  }

  close() {
    this.stopped = true; this.ready = false; this.connected = false;
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer);
    for (const call of this.calls.values()) call.hangup();
    this.ws?.close();
  }
  onControl(msg) {
    if (msg.type === "hello") {
      this.pbxSlots = new Set(msg.calls.map(c => c.slot));
      for (const slot of this.pendingCleanup) if (!this.pbxSlots.has(slot)) this.pendingCleanup.delete(slot);
      this.ready = true;
      brainLog("мост: hello", { active_on_server: msg.calls.length });
    } else if (msg.type === "call.state") {
      if (msg.state === "ended") { this.pbxSlots.delete(msg.slot); this.pendingCleanup.delete(msg.slot); }
      else this.pbxSlots.add(msg.slot);
      this.calls.get(msg.slot)?.onBridge(msg);
    }
  }
  availability() {
    const ready = Boolean(this.connected && this.ready);
    const busy = this.calls.size > 0 || this.pbxSlots.size > 0 || this.pendingCleanup.size > 0 || (this.pendingLive?.size ?? 0) > 0;
    return { ready, busy, reason: !ready ? "Состояние АТС не подтверждено" : busy ? "Канал занят или ожидает подтверждения завершения" : "Линия свободна" };
  }
  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  sendAudio(slot, bytes) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.concat([Buffer.from([slot]), bytes]), { binary: true });
  }
  hangup(slot) { this.send({ type: "call.hangup", slot }); }

  status() {
    return { configured: true, connected: this.connected,
             availability: this.availability(), calls: [...this.calls.values()].map((c) => ({ id: c.id, to: c.to, state: c.state, label: c.label })) };
  }
  byId(id) { return [...this.calls.values()].find((c) => c.id === id) ?? this.finished.get(id); }

  start({ to, name = "", session, label, profileId = "", record = false, maxDurationSeconds = 300 }) {
    const available = this.availability();
    if (!available.ready || available.busy) throw new Error(available.reason);
    let slot = 1;
    while (this.calls.has(slot)) slot++;
    if (slot > 255) throw new Error("нет свободных слотов");
    const call = new PhoneCall(this, slot, { to, name, session, label, profileId, maxDurationSeconds });
    this.calls.set(slot, call);
    brainLog("звонок: старт", { call: call.id, slot, to, name, profile: profileId, voice: session?.audio?.output?.voice, record });
    call.push({ type: "call.state", state: "dialing", to });
    this.send({ type: "call.start", slot, to, record: Boolean(record) });
    return call;
  }
}
