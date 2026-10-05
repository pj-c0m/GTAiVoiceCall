// Временная проверка: настоящий SDP-оффер → /api/session → данные по каналу oai-events.
import { RTCPeerConnection } from "werift";
import {readFileSync} from "node:fs";
import {parseEnv} from "node:util";
const origin = process.env.SMOKE_URL ?? "http://localhost:3000";
let auth = {};
if (process.env.GUI_PASSWORD_FILE) {
  const raw = readFileSync(process.env.GUI_PASSWORD_FILE, "utf8").trim();
  const password = raw.startsWith("GUI_PASSWORD=") ? parseEnv(raw).GUI_PASSWORD : raw;
  auth.Authorization = "Basic " + Buffer.from("admin:" + password).toString("base64");
}

const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
pc.addTransceiver("audio", { direction: "sendrecv" });
const dc = pc.createDataChannel("oai-events");

const seen = [];
dc.onMessage.subscribe((data) => {
  const e = JSON.parse(data.toString());
  seen.push(e.type);
  console.log("<<", e.type, e.type === "session.started" ? e.session.id : (e.type === "session.closed" ? e.reason + " " + JSON.stringify(e.usage) : ""));
  if (e.type === "session.started") setTimeout(() => { console.log(">> session.close"); dc.send(JSON.stringify({ type: "session.close" })); }, 2500);
  if (e.type === "session.closed") { console.log("РЕЗУЛЬТАТ: OK,", seen.join(", ")); process.exit(0); }
});

await pc.setLocalDescription(await pc.createOffer());
dc.stateChanged.subscribe((st) => console.log('канал:', st));
const res = await fetch(origin + "/api/session", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...auth },
  body: JSON.stringify({ sdp: pc.localDescription.sdp, voice: "cedar", profile: "free", context: "Тестовый прогон." }),
});
const body = await res.json();
if (!res.ok) { console.error("СЕРВЕР ОТКАЗАЛ:", body); process.exit(1); }
console.log("сессия создана:", body.session.id, "| голос:", body.meta.voice, "| профиль:", body.meta.profile, "| бэкенд:", body.meta.backendModel);
await pc.setRemoteDescription({ type: "answer", sdp: body.transport.sdp });
setTimeout(() => { console.error("ТАЙМАУТ. Получено:", seen); process.exit(1); }, 25000);
