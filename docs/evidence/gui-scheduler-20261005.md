# GUI управления звонками и scheduler: локальное evidence

Дата: 2026-10-05. База main: `043ce4364b9de6df5ae77187530698843fce3bba`.
Task branch: `codex/call-control-gui-20261005`.
Кодовая контрольная точка: `5ed6284` (документация/evidence добавляются следующим commit).

## Проверенный scope

Контакты/manual номер и имя; сейчас/date/time с явным IANA timezone; тема/цель,
дополнительные инструкции, файлы, сценарий/голос и лимит разговора; отдельная
карточка проверки; server jobs, отмена до claim и stop начавшейся попытки;
история, transcript, длительность и оценка Live. Инструкции нового GUI дополняют
выбранный сценарий; старый prompt API сохраняет upstream replacement semantics.

SQLite на постоянном диске, snapshot профиля/session, transactional claim до PBX
команды. Terminal jobs не возвращаются в runnable; missed и unknown не повторяются.
Два сервера/Asterisk/PJSIP/ARI/externalMedia/PCMA 8 kHz сохранены.

## PASS

- `npm test`: 41/41 Node offline/mock tests на Node 25.3.0.
- Те же tests на целевом Node 22.22.1: 41/41 (SQLite ExperimentalWarning ожидаем).
- `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`: 3/3 существующих PBX regressions.
- Syntax checks server, job-store/jobs-api/scheduler/phone-control и `git diff --check`.
- БД reopen, idempotency/conflict, cancel против claim, recovery/missed window,
  duplicate ticks, busy channel/orphan hello, disk-write failure в scheduler,
  повреждённая БД и read-only каталог, stale/unknown/PID-reuse lock.
- Отдельный child process: SIGKILL после фактического получения `call.start`
  mock PBX → restart/recovery unknown → ровно одна команда, второго вызова нет.
- Настоящие mock WebSocket bridge + Live с CallHub и scheduler: обе стороны
  transcript, итоговый usage, confirmed PBX/Live cleanup, освобождение admission.
- PBX ended затем Live socket.close, forced Live timeout, pending Live gate,
  длительность по PBX end, max duration от ответа и duplicate answered.
- Реальный HTTP API с temporary SQLite: repeat key, изменённый payload 409,
  Origin 403, invalid input, snapshot профиля/preview, отмена и contacts CRUD.
- Restore snapshot запрещает автоматический запуск старых runnable jobs;
  отсутствующий snapshot отклоняется, пустая БД вместо него не создаётся.
- DST gap/fold и отсутствие timezone отклоняются; Moscow round-trip проверен.
- Deployment fixtures: новые modules/static assets входят в stage; `data` не
  переносится из worktree. Unit/installer подготовлены к persistent directory.

## Browser и визуальная проверка

Локальный сервер: loopback, порт 3017, временная БД под `/tmp`, key/bridge отсутствуют.
Ни OpenAI, ни production PBX не подключались. Только synthetic `test:sim1` данные.

Проверены заполнение формы, extraction markdown файла, review со всеми полями,
потеря ответа после server POST и retry тем же key (один job), cancellation,
reload, contacts save/delete, malicious HTML в имени как plain text, сохранение
keyboard focus на polling, adjacent timezone error/aria-invalid/focus.

В Git сохранён воспроизводимый `tests/browser/phone-smoke.js`:
`playwright-cli run-code --filename=tests/browser/phone-smoke.js` после открытия
локального UI. Script отказывается работать вне localhost или с key/bridge,
создаёт synthetic future job и отменяет его; не выполняет call.start.

Desktop viewport 1440×1000, mobile 390×844. Full-page PNG имеют ширину 1425/375:
Chrome исключил системный scrollbar 15 px. Browser evidence: innerWidth 390,
clientWidth/scrollWidth 375, DPR 1; horizontal overflow отсутствует.
Снимки открыты и проверены, demo result явно обозначен как синтетический:

- [Desktop](gui-scheduler-20261005/desktop.png)
- [Mobile](gui-scheduler-20261005/mobile.png)

Независимый backend review нашёл два P1 lifecycle дефекта и P2 duration:
все воспроизведены RED и исправлены GREEN с regression tests.
Независимый UI review: **ship** для локального GUI/handoff. Его замечание об
общем error block дополнительно закрыто полевой validation и browser smoke.
Impeccable detect нового phone-control.mjs: `[]`.
Design-system check: incumbent `:root` побайтно сохранён; branding/fonts и
light/graphite/lime мир не заменены, новые DESIGN.md/tokens не создавались.

## NOT VERIFIED и ограничения

- Production deployment, новые PSTN-звонки, реальный OpenAI/Live smoke этой функции.
- Production systemd sandbox с новой БД; installer/unit проверены offline,
  команды на сервере не выполнялись.
- Реальный исчерпанный диск: fault injection write failure использует store
  adapter; настоящие filesystem checks покрывают read-only и corruption.
- Конкурентный recovery stale lock несколькими child processes не fault-injected;
  recovery guard сериализует снятие lock, unknown/живой owner блокирует запуск.
- «Стоимость» — только оценка Live по тарифу проекта, не актуальный полный счёт.

Один разрешённый MVP1 PSTN-звонок уже использован ранее; allowlist/record/max_calls
на production не менялись. Новая функция не наследует acceptance старого MVP1.

## Принятые решения и небольшие улучшения

- Unix `ps` используется для process identity lock; недоступность проверки
  блокирует scheduler, а живой переиспользованный PID требует ручной проверки.
- Preview snapshot хранится 10 минут в памяти; restart требует проверки карточки
  заново. Созданные jobs устойчивы в SQLite.
- Persistent data path и systemd write permission подготовлены локально;
  их применение требует отдельного deployment решения координатора.
- Offline/mock smoke исключает paid API/PSTN; живой пользовательский путь остаётся NOT VERIFIED.
- Отложены небольшие UI улучшения: заметная стрелка select и формулировка
  static header lamp (реальная readiness отдельно показана рядом с формой).
