# GUI звонков и scheduler: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор проверяет, запускает и планирует звонки; сервер сохраняет задания и не повторяет попытку с неизвестным исходом.

**Architecture:** Один dispatcher на model server, SQLite на постоянном диске, snapshot профиля и session при создании задания. Все телефонные пути используют общий CallHub admission gate; PBX/Live cleanup определяет окончательный результат.

**Tech Stack:** Node 22.22.1+, `node:sqlite`, Express, существующие WebSocket/Live API, HTML/CSS/JavaScript без сборки.

**Spec:** `docs/superpowers/specs/2026-10-05-call-control-design.md` (подтверждена владельцем).

## Global Constraints

- Два сервера, Asterisk/PJSIP/ARI/externalMedia, PCMA 8 kHz; MIT attribution сохранён.
- Один канал, `record=off`, allowlist не открывается; никаких реальных или платных smoke.
- Длительность 30–1800 секунд, default 300; окно допустимого опоздания 120 секунд.
- Терминальные задания не возвращаются в очередь; at-most-once attempt.
- Default timezone `Europe/Moscow`; DST gap/fold отклоняются.
- Русская документация и содержательные комментарии; локальный UI через loopback/SSH tunnel.
- Task-ветка `codex/call-control-gui-20261005`; только commit/push и handoff, без main integration/deployment.

## Review Focus

- HTML/script в имени, transcript и файлах: текст остаётся текстом, без HTML execution (задача 5).
- Повтор submit после потери HTTP-ответа: одна запись и одна попытка (задачи 1, 4).
- Изменение профиля после планирования: разговор использует сохранённый snapshot (задача 4).
- PID reuse/нечитаемый lock: второй dispatcher не стартует; неизвестность не снимает lock (задача 1).
- Финальный usage после PBX ended: итог доступен после reload, преждевременного completed нет (задачи 2, 3).

## Файлы и границы

Создать `lib/job-store.mjs` (SQLite/lock), `lib/job-input.mjs` (поля/timezone),
`lib/scheduler.mjs` (state machine), `lib/jobs-api.mjs` (HTTP handlers),
`public/phone-control.mjs` и `public/phone-control.css` (телефонный поток).
Изменить `lib/calls.mjs`, `server.mjs`, `public/index.html`, `package.json`,
`.gitignore`, `CHANGELOG.md`, `DEPLOY.md`, `HANDOFF.md`.
Новые tests используют `node:test`, временные каталоги, fake clock и mock sockets.
Не переписывать браузерный WebRTC и не менять PBX протокол без доказанной необходимости.

## Task 1: Устойчивое хранилище и валидация

**Files:** `lib/job-store.mjs`, `lib/job-input.mjs`, `tests/job-store.test.mjs`, `tests/job-input.test.mjs`, `.gitignore`.

**Interfaces:**
- `openJobStore({path, clock}) -> store`; методы `createJob(input,key)`, `getJob(id)`, `listJobs({limit})`, `claim(id,now)`, `cancel(id)`, `updateAttempt(id,patch)`, `recover(now)`, `saveContact(input)`, `deleteContact(id)`, `listContacts()`, `close()`.
- `resolveTime({localTime,timeZone}) -> {scheduledAt,localTime,timeZone,offset}`.
- `validateJobInput(body,now) -> normalizedInput`; `validateContact(body)`.
- Job содержит `id,state,attemptId,callId,scheduledAt,createdAt,brief,maxDurationSeconds,result`; brief — immutable snapshot после задачи 4. `result` содержит transcript, времена, reason, usage и cleanup evidence.

- [ ] Написать tests: reopen сохраняет job/contact; `createJob(payload,key)` дважды даёт один id; другой payload с тем же key — conflict; cancel и claim взаимно исключаются; recovery `dispatching/active -> unknown`; stale scheduled `-> missed`.
- [ ] Добавить tests lock ownership/PID reuse, повреждённой БД и write failure: открытие/claim прекращаются, пустая БД не создаётся поверх повреждённой. Проверить отдельным child process второй dispatcher.
- [ ] Написать input tests: 29/1801 секунд отклонены, default 300; прошлое время отклонено; Moscow offset +03:00; `America/New_York` 2026-03-08 02:30 и 2026-11-01 01:30 отклонены; invalid timezone/номер/нестроковые поля отклонены.
- [ ] Запустить `node --test tests/job-store.test.mjs tests/job-input.test.mjs` и подтвердить RED.
- [ ] Реализовать SQLite transactions/WAL/FULL, versioned schema, process lock с PID и process-start identity; путь `JOB_DB_PATH` либо `data/calls.sqlite`, каталог 0700 и файлы 0600. Lock вне Git; нельзя автоматически удалять lock с неизвестным owner. Ограничения: 1000 контактов, 10000 jobs, list default 100/max 500; имя 60, номер 64, тема 200, цель/context 6000, instructions 40000, 50 файлов/120000 символов суммарно. Превышения отклонять явно.
- [ ] Реализовать timezone resolver через Intl: перебрать допустимые offsets в окне ±24 часа, round-trip wall components; ровно один match обязателен. Хранить UTC instant и исходный offset.
- [ ] Подтвердить GREEN командой выше, добавить `data/` в ignore, scoped commit.

## Task 2: CallHub admission и подтверждённый lifecycle

**Files:** `lib/calls.mjs`, `tests/calls.test.mjs`, `tests/call-hub.test.mjs`.

**Interfaces:**
- `hub.availability() -> {ready,busy,reason}`; readiness после hello, максимум один local/PBX/pending-cleanup call.
- `hub.start({...existing,maxDurationSeconds}) -> PhoneCall` использует общий gate.
- `call.result() -> {pbxEnded,liveClosed,cleanupConfirmed,reason,transcript,usage,startedAt,answeredAt,endedAt}`; события `event` и `closed` сохраняются.

- [ ] Написать RED tests с mock bridge/Live: open без hello запрещает start; hello orphan блокирует; два start — одна команда; disconnect сбрасывает readiness; старый slot не освобождает admission до подтверждения cleanup.
- [ ] Добавить tests PBX ended до session.closed, дубли ended/closed, Live error и закрытие сокета: teardown идемпотентен, итог usage не теряется, absence PBX ended не считается cleanup.
- [ ] Реализовать tracked PBX snapshot, состояние pending cleanup и bounded confirmation timeout. После reconnect пустой hello подтверждает отсутствие orphan; существующие orphan не завершать автоматически. Подтверждённые ended удаляют PBX slot. При неизвестности channel gate остаётся закрытым.
- [ ] Добавить answered-based deadline timer, повтор hangup безопасен; по deadline послать hangup и дождаться PBX/Live результата. Локальный teardown не доказывает cleanup.
- [ ] Запустить `node --test tests/calls.test.mjs tests/call-hub.test.mjs`, подтвердить GREEN и scoped commit.

## Task 3: Dispatcher и crash semantics

**Files:** `lib/scheduler.mjs`, `tests/scheduler.test.mjs`.

**Interfaces:** `new Scheduler({store,hub,clock,setTimer,clearTimer})`; методы `start()`, `tick()`, `stop()`, `stopJob(id)`. Consumes store задачи 1 и hub задачи 2; принимает только сохранённые session snapshots.

- [ ] RED tests с fake clock: scheduled запускается без browser; tick race отправляет одну команду; busy/disconnected даёт waiting; через 120 секунд missed; граница окна точна; cancel до claim исключает start.
- [ ] RED crash tests: открыть ту же БД после остановки до claim, после claim/до send и после send/до callId; в последних двух повторных команд ноль. Exceptions после claim дают unknown, не requeue.
- [ ] RED lifecycle tests: active до cleanup; completed только после PBX/Live подтверждения, отказ/no answer failed, disconnect/cleanup timeout unknown; финальные transcript/usage переживают reopen; max duration enforced.
- [ ] Реализовать serialized tick, transactional claim до `hub.start`, listeners до обработки completion, persistence существенных событий. Если event write не удался, остановить dispatcher и завершать текущую попытку без нового звонка. Метровые/audio events не писать в БД.
- [ ] Реализовать recovery и stop; SIGTERM останавливает admission и посылает hangup активной попытке, неподтверждённое завершение остаётся unknown при следующем запуске.
- [ ] Запустить `node --test tests/scheduler.test.mjs`, GREEN, scoped commit.

## Task 4: HTTP API и интеграция сервера

**Files:** `lib/jobs-api.mjs`, `server.mjs`, `tests/jobs-api.test.mjs`, `package.json`.

**Interfaces:** `mountJobsApi(app,{store,scheduler,buildBrief,clock,allowedOrigins})`; endpoints spec плюс `POST /api/jobs/preview`, `POST /api/jobs/:id/stop`, `GET/POST /api/contacts`, `DELETE /api/contacts/:id`. `buildBrief(input)` возвращает snapshot profile/session через existing sessionFor.

- [ ] RED real HTTP tests без внешней сети: duplicate Idempotency-Key, mismatch 409, malformed input 400, limit 413, cancel claimed 409, stop идемпотентен, unknown id 404, чужой Origin 403, DB unavailable 503; list не содержит internal session.
- [ ] Test profile mutation: создать job, изменить fixture profile, выполнить job и assert прежние voice/instructions/files; preview и POST одинаково разрешают timezone. GET detail показывает сохранённый transcript после reopen.
- [ ] Реализовать HTTP layer, snapshot темы/цели в instructions/context без замены базового поведения профиля; server initializes store/scheduler и shutdown hooks. Ошибка storage запрещает телефонные launches, интерфейс показывает причину.
- [ ] Сохранить `/api/calls`, campaigns/events/audio; проверить legacy immediate/campaign не обходят gate и не претендуют на persistence. Новый UI использует jobs для now и scheduled.
- [ ] Добавить `test` script для `node --test tests/*.test.mjs`. Запустить `node --test tests/jobs-api.test.mjs tests/call-hub.test.mjs`, GREEN, scoped commit.

## Task 5: Телефонный интерфейс

**Files:** `public/index.html`, `public/phone-control.mjs`, `public/phone-control.css`, `tests/phone-control.test.mjs`.

**Interfaces:** `mountPhoneControl(root,{fetch,now})`; root — телефонная поверхность; existing profile/voice/files APIs сохраняются. Форма использует preview, then POST с удерживаемым UUID key до окончательного ответа.

- [ ] Прочитать craft-floor Impeccable; сохранить incumbent цвета/типографику, выбрать Operate. Подготовить UI на существующем light/graphite/lime, без изменения browser modes.
- [ ] Реализовать contact/manual choice, now/date/time/timezone, тему/цель, profile/voice, instructions/files, duration и отдельную confirmation card. Snapshot подтверждается серверным preview; редактирование после preview возвращает в форму.
- [ ] Реализовать list/detail, cancellation/stop, waiting/missed/unknown explanations, ring/talk/usage/transcript и «Оценка Live» с null = «Нет данных». Poll bounded и visibility-aware; закрытие вкладки не отменяет server job.
- [ ] Добавить tests на stable submit key, потерю HTTP-response/retry, escape/render text, reload read-only, невозможность cancel активного задания; UI labels/error focus/live announcements.
- [ ] Проверить локально mock HTTP с synthetic data, без ключей/bridge. Desktop 1440 и mobile 390: заполнение, файлы, preview, создание, отмена, busy/error, reload, длинный transcript и malicious markup как plain text. Сохранить screenshots; inspect оба в одном проходе, batch исправления и максимум один confirmation pass.
- [ ] Выполнить review по применённому UI skill, устранить material findings; scoped commit.

## Task 6: Проверки, документация и handoff

**Files:** `CHANGELOG.md`, `DEPLOY.md`, `HANDOFF.md`, `docs/evidence/gui-scheduler-20261005.md`.

- [ ] Запустить `npm test`; existing Python regression через доступную venv (`python -m unittest discover -s tests -p 'test_*.py'`). Не запускать `npm run check`: он платный. Syntax-check server/modules и `git diff --check`.
- [ ] Проверить runtime `node:sqlite` на минимальной поддерживаемой версии Node 22.22.1, если локально доступна; иначе явно NOT VERIFIED. Проверить installer file allowlist: новые modules/static assets входят в deployment payload, постоянная БД не перезаписывается. Installer не запускать.
- [ ] Описать JOB_DB_PATH, единственный процесс, crash/missed/unknown, restart/backup/restore. Backup через SQLite backup API или после остановки процесса; нельзя копировать только основной файл при активном WAL. Restore не разрешает автоматический повтор неизвестных попыток. Защитить backups как личные данные.
- [ ] Добавить пользовательские изменения в Unreleased, sanitized mock evidence и handoff с PASS/NOT VERIFIED. Production, PSTN и платные API остаются NOT VERIFIED.
- [ ] Проверить scope/clean state, commit документации, push только task branch, подтвердить remote SHA и передать main branch/SHA/команды/ограничения. Не удалять worktree и не интегрировать main.

## Execution handoff

Рекомендация: Native — задачи последовательно зависят от общего lifecycle,
поэтому реализация в этом чате сохраняет контекст и снижает повторные чтения.
После реализации провести один независимый review всей ветки. Альтернатива:
Subagent-driven — отдельный исполнитель и reviewer на каждую задачу, с
дополнительной стоимостью свежего контекста.

План ожидает review владельца и выбора execution method до product code.
