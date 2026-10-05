#!/usr/bin/env python3
"""Диалер на сервер телефонии: мост между Asterisk (ARI + RTP) и «мозгом» (WebSocket).

Мозг подключается сюда по WSS через nginx с токеном. Команды — JSON, звук —
бинарные кадры: первый байт — слот звонка, дальше 160 байт A-law (20 мс).
Asterisk зарегистрирован в АТС (например, onlinePBX) как внутренний номер и звонит через АТС;
звук ходит через externalMedia на localhost.
"""
import asyncio
import json
import logging
import logging.handlers
import os
import random
import secrets
import re
import struct
import time
import uuid
from collections import deque

from aiohttp import BasicAuth, ClientSession, ClientTimeout, WSMsgType, web

log = logging.getLogger("dialer")
LOG_DIR = os.environ.get("LOG_DIR", "/var/log/gpt-voice")


def record(**fields):
    """Одна строка JSON на факт — /var/log/gpt-voice/calls.jsonl, для анализа."""
    try:
        with open(os.path.join(LOG_DIR, "calls.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **fields}, ensure_ascii=False) + "\n")
    except OSError as error:
        log.warning("не могу писать calls.jsonl: %s", error)

ARI_URL = os.environ.get("ARI_URL", "http://127.0.0.1:8088/ari").rstrip("/")
ARI_USER = os.environ["ARI_USER"]
ARI_PASSWORD = os.environ["ARI_PASSWORD"]
BRIDGE_TOKEN = os.environ["BRIDGE_TOKEN"]
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("BIND_PORT", "8130"))
APP = os.environ.get("ARI_APP", "gpt-voice")
PBX_ENDPOINT = os.environ.get("PBX_ENDPOINT", "obpx_endpoint")
CALLER_ID = os.environ.get("CALLER_ID", "")        # номер/добавочный для поля From; deploy.sh задаёт из .env
DIAL_PREFIX = os.environ.get("DIAL_PREFIX", "7")          # формат номера для АТС: onlinePBX принимает 7XXXXXXXXXX (на 8… отвечает 404)
RTP_HOST = os.environ.get("RTP_HOST", "127.0.0.1")
RTP_PORT_BASE = int(os.environ.get("RTP_PORT_BASE", "40000"))
MAX_CALLS = int(os.environ.get("MAX_CALLS", "2"))
RING_TIMEOUT = int(os.environ.get("RING_TIMEOUT", "45"))
# Пустой список и none запрещают реальные звонки; локальные сценарии доступны.
ALLOWED_NUMBERS = {n.strip() for n in os.environ.get("ALLOWED_NUMBERS", "none").split(",") if n.strip()}
PSTN_NUMBER_POLICY = os.environ.get("PSTN_NUMBER_POLICY", "allowlist")
if PSTN_NUMBER_POLICY not in ("allowlist", "prefix7"):
    raise RuntimeError("Неизвестная PSTN_NUMBER_POLICY")
RECORD_CALLS = os.environ.get("RECORD_CALLS", "off").lower() in ("on", "1", "yes")   # писать все звонки

FRAME = 160                     # байт A-law = 20 мс при 8 кГц
SILENCE = b"\xd5" * FRAME       # тишина в A-law
OUTBUF_CAP = FRAME * 100        # 2 с: дальше отстаём — режем старое


def normalize_number(raw: str):
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 11 and digits[0] in "78":
        return DIAL_PREFIX + digits[1:]
    if len(digits) == 10:
        return DIAL_PREFIX + digits
    return None


def pstn_number_allowed(raw: str, number: str):
    if PSTN_NUMBER_POLICY == "prefix7":
        cleaned = "".join(ch for ch in raw if ch not in " ()-\t")
        return bool(re.fullmatch(r"\+?7[0-9]{10}", cleaned))
    return number[-10:] in {n[-10:] for n in ALLOWED_NUMBERS if normalize_number(n)}


# ── ARI ────────────────────────────────────────────────────────────────────
class Ari:
    def __init__(self):
        self.http = None

    def open(self):
        self.http = ClientSession(headers={"Authorization": BasicAuth(ARI_USER, ARI_PASSWORD).encode()},
                                  timeout=ClientTimeout(total=15))

    async def call(self, method, path, **params):
        async with self.http.request(method, f"{ARI_URL}/{path}", params=params) as r:
            body = await r.text()
            if r.status >= 400:
                raise RuntimeError(f"ARI {method} {path} → {r.status}: {body[:200]}")
            return json.loads(body) if body else None

    async def events(self):
        url = f"{ARI_URL.replace('http', 'ws', 1)}/events"
        return await self.http.ws_connect(url, params={"app": APP, "subscribeAll": "true",
                                                       "api_key": f"{ARI_USER}:{ARI_PASSWORD}"},
                                          heartbeat=20)

    async def close(self):
        await self.http.close()


# ── RTP-плечо: Asterisk ↔ мы, по localhost ─────────────────────────────────
class RtpLeg(asyncio.DatagramProtocol):
    def __init__(self, call):
        self.call = call
        self.transport = None
        self.remote = None
        self.seq = random.randint(0, 0xFFFF)
        self.ts = random.randint(0, 0xFFFFFFFF)
        self.ssrc = random.randint(0, 0xFFFFFFFF)

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if len(data) < 12 or (data[0] >> 6) != 2:
            return
        if self.remote is None:
            self.remote = addr
        if data[1] & 0x7F != 8:              # только PCMA
            return
        offset = 12 + 4 * (data[0] & 0x0F)
        if data[0] & 0x10:                   # extension header
            if len(data) < offset + 4:
                return
            offset += 4 + 4 * struct.unpack("!H", data[offset + 2:offset + 4])[0]
        payload = data[offset:]
        if payload:
            self.call.from_pbx(payload)

    def send(self, payload):
        if not self.transport or not self.remote:
            return
        header = struct.pack("!BBHII", 0x80, 8, self.seq, self.ts, self.ssrc)
        self.transport.sendto(header + payload, self.remote)
        self.seq = (self.seq + 1) & 0xFFFF
        self.ts = (self.ts + len(payload)) & 0xFFFFFFFF


# ── Один звонок ────────────────────────────────────────────────────────────
class Call:
    def __init__(self, hub, slot, number, to_display, record=False):
        self.hub = hub
        self.slot = slot
        self.number = number
        self.to = to_display
        self.record = record
        self.id = f"call-{slot}-{uuid.uuid4().hex[:8]}"
        self.channel_id = f"{self.id}-pbx"
        self.ext_id = f"{self.id}-media"
        self.bridge_id = f"{self.id}-bridge"
        self.state = "dialing"
        self.started = time.monotonic()
        self.answered_at = None
        self.rtp = None
        self.rtp_transport = None
        self.outbuf = bytearray()
        self.pacer = None
        self.closing = False
        self.frames_in = 0          # кадров получено из Asterisk (абонент)
        self.frames_out = 0         # кадров отправлено в Asterisk (модель)
        self.frames_silence = 0     # из них — тишина, когда модели нечего было сказать
        self.stats = None

    @property
    def endpoint(self):
        if self.number.startswith("test:"):          # локальная самопроверка, без АТС
            return f"Local/{self.number[5:]}@gpt-test/n"
        return f"PJSIP/{self.number}@{PBX_ENDPOINT}"

    async def dial(self):
        loop = asyncio.get_running_loop()
        self.rtp_transport, self.rtp = await loop.create_datagram_endpoint(
            lambda: RtpLeg(self), local_addr=(RTP_HOST, RTP_PORT_BASE + self.slot))
        params = dict(endpoint=self.endpoint, app=APP, appArgs="outbound", timeout=RING_TIMEOUT,
                      channelId=self.channel_id)
        if CALLER_ID:
            params["callerId"] = f"Agent <{CALLER_ID}>"
        await self.hub.ari.call("POST", "channels", **params)
        log.info("%s: набираем %s через %s", self.id, self.to, self.endpoint)
        record(call=self.id, event="dial", to=self.to, endpoint=self.endpoint, slot=self.slot)

    async def answered(self):
        if self.state in ("answered", "ended"):
            return
        ari = self.hub.ari
        await ari.call("POST", "bridges", type="mixing", bridgeId=self.bridge_id)
        await ari.call("POST", f"bridges/{self.bridge_id}/addChannel", channel=self.channel_id)
        await ari.call("POST", "channels/externalMedia", channelId=self.ext_id, app=APP,
                       external_host=f"{RTP_HOST}:{RTP_PORT_BASE + self.slot}", format="alaw",
                       encapsulation="rtp", transport="udp", connection_type="client")
        for attempt in range(5):     # медиа-канал входит в Stasis чуть позже создания
            try:
                await ari.call("POST", f"bridges/{self.bridge_id}/addChannel", channel=self.ext_id)
                break
            except RuntimeError as error:
                if attempt == 4:
                    raise
                await asyncio.sleep(0.2)
        if self.number.startswith("test:") or self.record:   # запись моста — что слышал абонент
            prefix = "gpt-test" if self.number.startswith("test:") else "call"
            await ari.call("POST", f"bridges/{self.bridge_id}/record", name=f"{prefix}-{self.id}",
                           format="wav", ifExists="overwrite", beep="false", terminateOn="none")
            log.info("%s: пишу запись %s-%s.wav", self.id, prefix, self.id)
            record(call=self.id, event="recording", file=f"/var/spool/asterisk/recording/{prefix}-{self.id}.wav")
        port = await ari.call("GET", f"channels/{self.ext_id}/variable", variable="UNICASTRTP_LOCAL_PORT")
        self.rtp.remote = (RTP_HOST, int(port["value"]))
        self.state = "answered"
        self.answered_at = time.monotonic()
        self.pacer = asyncio.create_task(self.pace())
        log.info("%s: ответили через %.1f с, RTP Asterisk на порту %s", self.id,
                 time.monotonic() - self.started, port["value"])
        record(call=self.id, event="answered", ring_s=round(time.monotonic() - self.started, 1),
               rtp_port=int(port["value"]))
        self.stats = asyncio.create_task(self.report_stats())
        await self.hub.notify(self, "answered")

    async def report_stats(self):
        """Раз в 10 с — как идёт звук: это главное для разбора «не слышно»."""
        while self.state == "answered":
            await asyncio.sleep(10)
            if self.state != "answered":
                break
            log.info("%s: звук — из АТС %s кадров, в АТС %s (речь %s), буфер %d мс",
                     self.id, self.frames_in, self.frames_out, self.frames_out - self.frames_silence,
                     len(self.outbuf) // 8)
            record(call=self.id, event="audio", frames_in=self.frames_in, frames_out=self.frames_out,
                   speech_out=self.frames_out - self.frames_silence, buffer_ms=len(self.outbuf) // 8)

    def from_pbx(self, payload):
        if self.state == "answered":
            self.frames_in += 1
            self.hub.audio_out(self.slot, payload)

    def to_pbx(self, payload):
        if self.state != "answered":
            return
        self.outbuf += payload
        if len(self.outbuf) > OUTBUF_CAP:
            del self.outbuf[:len(self.outbuf) - OUTBUF_CAP]
            log.warning("%s: буфер воспроизведения переполнен, режу старое", self.id)

    def flush(self):
        self.outbuf.clear()

    async def pace(self):
        next_at = time.monotonic()
        while self.state == "answered":
            next_at += 0.02
            if len(self.outbuf) >= FRAME:
                chunk = bytes(self.outbuf[:FRAME])
                del self.outbuf[:FRAME]
            else:
                chunk = SILENCE
                self.frames_silence += 1
            self.frames_out += 1
            self.rtp.send(chunk)
            await asyncio.sleep(max(0.0, next_at - time.monotonic()))

    async def hangup(self):
        try:
            await self.hub.ari.call("DELETE", f"channels/{self.channel_id}")
        except RuntimeError as error:
            log.info("%s: hangup: %s", self.id, error)

    async def ended(self, reason):
        if self.closing:
            return
        self.closing = True
        self.state = "ended"
        if self.pacer:
            self.pacer.cancel()
        if self.stats:
            self.stats.cancel()
        if self.rtp_transport:
            self.rtp_transport.close()
        for method, path in (("DELETE", f"channels/{self.ext_id}"), ("DELETE", f"bridges/{self.bridge_id}")):
            try:
                await self.hub.ari.call(method, path)
            except RuntimeError:
                pass
        talked = round(time.monotonic() - self.answered_at) if self.answered_at else 0
        log.info("%s: завершён (%s), разговор %s с; из АТС %s кадров, в АТС %s (речь %s, тишина %s)",
                 self.id, reason, talked, self.frames_in, self.frames_out,
                 self.frames_out - self.frames_silence, self.frames_silence)
        record(call=self.id, event="ended", reason=reason, talk_s=talked, to=self.to,
               frames_in=self.frames_in, frames_out=self.frames_out,
               speech_out=self.frames_out - self.frames_silence, silence_out=self.frames_silence)
        await self.hub.notify(self, "ended", reason=reason, talked=talked)
        self.hub.calls.pop(self.slot, None)


# ── Хаб: одно соединение с мозгом + события ARI ────────────────────────────
class Hub:
    def __init__(self):
        self.ari = Ari()
        self.calls = {}
        self.brain = None
        self.outq = deque()
        self.pump = None

    # -- мозг → диалер
    async def handle_bridge(self, request):
        auth = request.headers.get("Authorization", "")
        if not secrets.compare_digest(auth, f"Bearer {BRIDGE_TOKEN}"):
            return web.Response(status=401, text="unauthorized")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        if self.brain is not None and not self.brain.closed:
            await self.brain.close(code=4000, message=b"replaced")
        self.brain = ws
        peer = request.headers.get("X-Real-IP", request.remote)
        log.info("мозг подключился с %s", peer)
        record(event="brain_connected", ip=peer)
        await ws.send_json({"type": "hello", "calls": [self.describe(c) for c in self.calls.values()], "pstn": {"policy": PSTN_NUMBER_POLICY}})
        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    call = self.calls.get(msg.data[0]) if msg.data else None
                    if call:
                        call.to_pbx(msg.data[1:])
                elif msg.type == WSMsgType.TEXT:
                    try:
                        await self.command(ws, json.loads(msg.data))
                    except Exception as error:
                        log.exception("ошибка при выполнении команды %s: %s", msg.data[:120], error)
                elif msg.type == WSMsgType.ERROR:
                    log.error("мост: ошибка сокета от мозга: %r", ws.exception())
                    break
                else:
                    log.info("мост: кадр типа %s", msg.type)
        except Exception as error:
            log.exception("мост: исключение в обработке: %s", error)
        finally:
            if self.brain is ws:
                self.brain = None
                log.info("мозг отключился (%s), код закрытия %s, активных звонков: %d",
                         peer, ws.close_code, len(self.calls))
                record(event="brain_disconnected", ip=peer, close_code=ws.close_code, active_calls=len(self.calls))
                self.outq.clear()
                for call in list(self.calls.values()):
                    await call.hangup()
                    await call.ended("мост с моделью отключился")
        return ws

    async def command(self, ws, cmd):
        kind = cmd.get("type")
        if kind != "ping":
            log.info("команда от мозга: %s", json.dumps(cmd, ensure_ascii=False)[:200])
        if kind == "call.start":
            await self.start_call(ws, cmd)
        elif kind == "call.hangup":
            call = self.calls.get(int(cmd.get("slot", -1)))
            if call:
                await call.hangup()
        elif kind == "call.flush":
            call = self.calls.get(int(cmd.get("slot", -1)))
            if call:
                call.flush()
        elif kind == "ping":
            await ws.send_json({"type": "pong"})

    async def start_call(self, ws, cmd):
        slot = int(cmd.get("slot", 0))
        raw = str(cmd.get("to", ""))
        is_test = raw.startswith("test:") and raw[5:].isalnum()
        number = raw if is_test else normalize_number(raw)
        problem = None
        if not 1 <= slot <= 255:
            problem = "плохой слот"
        elif slot in self.calls:
            problem = "слот занят"
        elif len(self.calls) >= MAX_CALLS:
            problem = "достигнут лимит одновременных звонков"
        elif not number:
            problem = "не разобрал номер"
        elif not is_test and not pstn_number_allowed(raw, number):
            problem = "Разрешены только номера +7 и ещё 10 цифр" if PSTN_NUMBER_POLICY == "prefix7" else "номер не в списке разрешённых для тестов"
        if problem:
            log.warning("звонок отклонён: %s (to=%s, slot=%s)", problem, raw, slot)
            record(event="rejected", reason=problem, to=raw, slot=slot)
            await ws.send_json({"type": "call.state", "slot": slot, "state": "ended", "reason": problem})
            return
        call = Call(self, slot, number, str(cmd.get("to")), record=bool(cmd.get("record", RECORD_CALLS)))
        self.calls[slot] = call
        try:
            await call.dial()
            await self.notify(call, "dialing")
        except Exception as error:
            log.error("%s: не удалось набрать: %s", call.id, error)
            await call.ended(f"не удалось набрать: {error}")

    def describe(self, call):
        return {"slot": call.slot, "id": call.id, "to": call.to, "state": call.state}

    async def notify(self, call, state, **extra):
        if self.brain and not self.brain.closed:
            await self.brain.send_json({"type": "call.state", "slot": call.slot, "id": call.id,
                                        "to": call.to, "state": state, **extra})

    # -- диалер → мозг (звук), через очередь, чтобы не плодить задачи из UDP-колбэка
    def audio_out(self, slot, payload):
        if self.brain and not self.brain.closed:
            self.outq.append(bytes([slot]) + payload)
            if len(self.outq) > 500:
                self.outq.popleft()

    async def pump_audio(self):
        while True:
            if self.outq and self.brain and not self.brain.closed:
                try:
                    await self.brain.send_bytes(self.outq.popleft())
                    continue
                except Exception:
                    pass
            await asyncio.sleep(0.005)

    # -- события Asterisk
    async def ari_loop(self):
        while True:
            try:
                ws = await self.ari.events()
                log.info("ARI: слушаем события приложения %s", APP)
                async for msg in ws:
                    if msg.type != WSMsgType.TEXT:
                        continue
                    await self.ari_event(json.loads(msg.data))
            except Exception as error:
                log.warning("ARI: соединение потеряно: %s", error)
                record(event="ari_lost", error=str(error)[:200])
            await asyncio.sleep(2)

    async def ari_event(self, event):
        kind = event.get("type")
        channel = event.get("channel") or {}
        call = next((c for c in self.calls.values()
                     if channel.get("id") in (c.channel_id, c.ext_id)), None)
        if not call:
            return
        is_pbx_leg = channel.get("id") == call.channel_id
        log.info("%s: ARI %s %s state=%s cause=%s", call.id, kind, "pbx" if is_pbx_leg else "media",
                 channel.get("state"), event.get("cause_txt", ""))
        if kind == "StasisStart" and is_pbx_leg:
            try:
                await call.answered()
            except Exception as error:
                log.error("%s: не удалось поднять медиа: %s", call.id, error)
                await call.hangup()
        elif kind == "ChannelStateChange" and is_pbx_leg and channel.get("state") == "Ringing":
            if call.state == "dialing":
                call.state = "ringing"
                await self.notify(call, "ringing")
        elif kind == "ChannelDestroyed" and is_pbx_leg:
            await call.ended(event.get("cause_txt") or "hangup")

    async def health(self, request):
        auth = request.headers.get("Authorization", "")
        if not secrets.compare_digest(auth, f"Bearer {BRIDGE_TOKEN}"):
            return web.Response(status=401, text="unauthorized")
        try:
            info = await self.ari.call("GET", "asterisk/info")
            asterisk = info["system"]["version"]
        except Exception as error:
            asterisk = f"недоступен: {error}"
        return web.json_response({"asterisk": asterisk, "brain": bool(self.brain and not self.brain.closed), "pstn": {"policy": PSTN_NUMBER_POLICY},
                                  "calls": [self.describe(c) for c in self.calls.values()]})


async def main():
    handlers = [logging.StreamHandler()]
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        handlers.append(logging.handlers.RotatingFileHandler(
            os.path.join(LOG_DIR, "dialer.log"), maxBytes=5_000_000, backupCount=5, encoding="utf-8"))
    except OSError as error:
        print("лог в файл недоступен:", error)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    hub = Hub()
    hub.ari.open()
    app = web.Application()
    app.router.add_get("/pbx/bridge", hub.handle_bridge)
    app.router.add_get("/pbx/health", hub.health)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, BIND_HOST, BIND_PORT).start()
    log.info("диалер слушает %s:%s, лимит звонков %s, разрешённые номера: %s",
             BIND_HOST, BIND_PORT, MAX_CALLS, ", ".join(sorted(ALLOWED_NUMBERS)) or "реальные звонки запрещены")
    hub.pump = asyncio.create_task(hub.pump_audio())
    record(event="dialer_started", max_calls=MAX_CALLS, allowed=sorted(ALLOWED_NUMBERS))
    try:
        await hub.ari_loop()
    finally:
        await hub.ari.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
