// Сводка разговоров из logs/calls.jsonl: node scripts/calls.mjs [--id <id>] [--today]
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { LOG_DIR } from "../lib/log.mjs";

const args = process.argv.slice(2);
const idAt = args.indexOf("--id");
if (idAt >= 0) {
  const file = resolve(LOG_DIR, "calls", `${args[idAt + 1]}.txt`);
  console.log(existsSync(file) ? readFileSync(file, "utf8") : `нет файла ${file}`);
  process.exit(0);
}
const index = resolve(LOG_DIR, "calls.jsonl");
if (!existsSync(index)) { console.log("разговоров ещё не было"); process.exit(0); }
let rows = readFileSync(index, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (args.includes("--today")) { const day = new Date().toISOString().slice(0, 10); rows = rows.filter((r) => (r.ended_at ?? "").startsWith(day)); }
const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
console.log(pad("когда", 17), pad("режим", 6), pad("кому", 16), pad("имя", 10), pad("профиль", 16), pad("гудки", 6), pad("разг.", 6), pad("$", 7), "причина");
for (const r of rows) {
  console.log(pad((r.ended_at ?? "").replace("T", " ").slice(0, 16), 17), pad(r.mode, 6), pad(r.to, 16), pad(r.name, 10), pad(r.profile, 16),
    pad(r.ring_seconds, 6), pad(r.talk_seconds, 6), pad(r.cost_usd?.toFixed?.(3), 7), r.reason ?? "");
}
const total = rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0), talk = rows.reduce((a, r) => a + (r.talk_seconds ?? 0), 0);
console.log(`\nвсего: ${rows.length} разговоров, ${Math.round(talk / 60)} мин, ≈$${total.toFixed(2)}; подробно: node scripts/calls.mjs --id <id>`);
