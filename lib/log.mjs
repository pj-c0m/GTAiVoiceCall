// Логи: факты соединений — logs/brain.log; каждое событие звонка — logs/calls/<id>.jsonl;
// сводка и расшифровка — logs/calls/<id>.txt; индекс всех разговоров — logs/calls.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "logs");
mkdirSync(resolve(LOG_DIR, "calls"), { recursive: true });

const stamp = () => new Date().toISOString();
const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);

export function brainLog(message, extra) {
  const line = `${stamp()} ${message}${extra ? " " + JSON.stringify(extra) : ""}`;
  console.log(line);
  appendFileSync(resolve(LOG_DIR, "brain.log"), line + "\n");
}

export function callEvent(id, event) {
  appendFileSync(resolve(LOG_DIR, "calls", `${safe(id)}.jsonl`), JSON.stringify({ t: stamp(), ...event }) + "\n");
}

export function callSummary(summary, transcriptText) {
  appendFileSync(resolve(LOG_DIR, "calls.jsonl"), JSON.stringify(summary) + "\n");
  const head = Object.entries(summary).map(([k, v]) => `${k}: ${v ?? ""}`).join("\n");
  writeFileSync(resolve(LOG_DIR, "calls", `${safe(summary.id)}.txt`), `${head}\n\n${transcriptText}\n`);
}

// Склейка дельт в реплики — по каждой стороне отдельно, как в интерфейсе.
export class Transcript {
  constructor(gapMs = 1400) { this.gapMs = gapMs; this.turns = []; this.last = {}; }
  add(channel, delta, startMs = 0, endMs = 0) {
    const last = this.last[channel];
    if (last && startMs - last.endMs < this.gapMs) { last.text += delta; last.endMs = endMs; return; }
    const turn = { channel, text: delta, startMs, endMs };
    this.turns.push(turn); this.last[channel] = turn;
  }
  render(labels = { you: "Клиент", agent: "Агент" }) {
    const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    return this.turns.map((t) => `${mmss(t.startMs)}  ${labels[t.channel] ?? t.channel}: ${t.text.replace(/\s+/g, " ").trim()}`).join("\n");
  }
}
