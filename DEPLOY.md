# GTAiVoiceCall: deployment и эксплуатация

Производная от [kpshinnik/gpt_voice_pbx](https://github.com/kpshinnik/gpt_voice_pbx), база `22419d6e02b023d230b455446a5607143ddb4754`. MIT LICENSE и attribution сохранены. Upstream `SETUP-AGENT.md` описывает исходное решение; для этой ветки deployment выполняется по этому документу.

## Фактическое размещение на 2026-10-05

| Роль | Хост | Компоненты |
|---|---|---|
| Модель, NL | `root@147.45.132.111` | Ubuntu 26.04.1, Node 22.22.1, `/srv/gpt-voice`, `gpt-voice-web` |
| PBX, РФ | `root@5.42.124.215` | Ubuntu 26.04.1, Asterisk 22.5.2, nginx 1.28.3, Python venv, `/srv/gpt-voice-dialer`, `gpt-voice-dialer` |
| Bridge | `wss://4pj.com.ru/pbx/bridge` | Let's Encrypt, IP allowlist сервера модели, bearer token |
| SIP | Mango, account-specific registrar из закрытого config | UDP 60000, alaw/PCMA 8 kHz, expiration 180 s |

Операторский интерфейс — `127.0.0.1:3000` на сервере модели. ARI — `127.0.0.1:8088`, dialer — `127.0.0.1:8130` на PBX. AMI выключен. UFW PBX допускает SIP только из `81.88.86.0/24`, RTP на локальные порты `10000:10200` из `81.88.86.0/24` и `81.88.88.0/24`. Остальные правила сохраняются. Разрешение `10050/tcp` сохраняет исходную доступность уже установленного Zabbix; его конфигурация и сервис не изменялись.

Сети проверены по [документации Mango](https://docs.mango-office.ru/ru/7_podderzhka/11_faq/2_sip-oborudovanie-i-softfony/4_tipovye_nastroyki_sistem_ogranicheniya_dostupa_ip_adresa_mango_office_firewall_fayrvoll_brandmauery_/index.html). У сервера свои RTP-порты из `rtp.conf`; открывать весь диапазон 1024–65535 на нём не требуется. В первоначальной диагностике один DNS IP оказался недостаточной спецификацией source allowlist. UDP 5060 не отвечал, 60000 дал `Registered`.

## Конфигурация и зависимости

Локально нужны Node 22+, npm, Python 3 с venv, SSH, rsync и dig. `npm ci`; для offline regression — `python3 -m venv .venv` и `.venv/bin/pip install -r pbx-server/requirements.txt`.

Общий закрытый dotenv находится в project main: `/Users/pj-com/CODEX/GTAiVoice Call/GTAiVoiceCall-MVP1.env`. Права `600`. Не публиковать, не source-ить и не пересылать его на сервер. `scripts/prepare-deploy.mjs` использует `util.parseEnv`, проверяет обязательные поля/authorizations/единственный разрешённый номер и создаёт две проекции. На model server передаются только OpenAI/model/bridge значения; SIP и ARI туда не попадают. На PBX нет OpenAI key.

Сгенерированные `BRIDGE_TOKEN`/`ARI_PASSWORD` сохраняются в игнорируемом `.deployment-secrets.env` текущего checkout (`600`). Этот файл требуется для повторного deployment с теми же credentials; сохранить его отдельно при переносе/закрытии worktree. Можно задать закрытый путь через `MVP_DEPLOY_STATE_PATH`. Он не входит в Git. Перенос credentials на новое рабочее место выполнять отдельно от clone.

Каждый deployment PBX выставляет `ALLOWED_NUMBERS=none`, `MAX_CALLS=1`, `RECORD_CALLS=off`; даже заполненный owner number в исходном файле не включается автоматически. Пустой allowlist тоже запрещает PSTN. Доступны локальные `test:<scenario>`.

## Запуск и обновление

```bash
npm ci
bash model-server/deploy.sh /absolute/path/GTAiVoiceCall-MVP1.env /absolute/path/ssh-key
MVP_SIP_PORT=60000 bash pbx-server/deploy.sh /absolute/path/GTAiVoiceCall-MVP1.env /absolute/path/ssh-key
```

`MVP_SIP_PORT=60000` — подтверждённая диагностикой настройка этого цикла; исходный пользовательский config не изменялся. На другом хосте использовать его фактическую настройку. Нужны выделенные серверы и подтверждённые flags в config; installer не подходит для произвольного общего хоста. Он ставит пакеты, пишет scoped конфиги, сохраняет backup, перезапускает только проектные сервисы и сохраняет SSH/Zabbix доступ. Нет `rsync --delete` всего workspace.

Сборка отсутствует: `server.mjs` и static UI запускаются непосредственно Node. Для локального smoke создайте закрытую model-проекцию и запустите сервер с её env. Унаследованный `OPENAI_API_KEY` имеет приоритет над `.env` в Node: перед `npm start` очистите переменную либо явно передайте key из нужного файла безопасным parser. Не используйте shell substitution для ключа. Пустой `ALLOWED_ORIGINS` нужно исключать из окружения, чтобы применился upstream default localhost.

`npm run check` требует запущенного localhost-сервера и выполняет реальный WebRTC API smoke. PASS требует `session.started` и `session.closed`. После этого проверить WebSocket/PCMA отдельно через `POST /api/calls` с `to=test:sim1`: оба счётчика речи/аудио, обе стороны transcript, Live started/closed/usage, освобождение каналов/bridge/Live. WebRTC PASS другого key не засчитывается выбранному проекту.

Доступ к UI:

```bash
ssh -i /absolute/path/ssh-key -L 3000:127.0.0.1:3000 root@147.45.132.111
```

Открыть `http://localhost:3000`. Статус — `GET /api/pbx/status`. Логи/расшифровки — `/srv/gpt-voice/logs`, `/var/log/gpt-voice`, записи local sim — `/var/spool/asterisk/recording`. Они могут содержать личные данные; в публичный Git добавлять только sanitized evidence. Не включать SIP logger постоянно.

## Первый реальный звонок

Только после успешного self-test и уведомления владельца открыть allowlist ровно для его номера из закрытого config в `/etc/gpt-voice/dialer.env` и перезапустить `gpt-voice-dialer`. Номер и name передавать безопасным parser в JSON API; не печатать в terminal/chat/Git. Выполнить один разрешённый звонок. После него вернуть `ALLOWED_NUMBERS=none`. Повторный звонок требует согласования владельца.

Критерии: фактический двусторонний PSTN-разговор, подтверждение владельцем слышимости/перебивания/тишины/hangup; transcript обеих сторон, Live started/closed с usage; PBX и model calls пусты, channels и bridge освобождены. Сервис `active`, регистрация или counters сами по себе acceptance не закрывают. Branding выполняется после этого.

## Rollback и остановка

До установки сохранены `/root/gtaivc-rollback-20261005/{packages.txt,units.txt,ports.txt,etc-baseline.tar.gz}` на обоих серверах. На PBX также сохранены package-default `asterisk` и `nginx`. Новые installer-запуски создают `/root/gtaivc-rollback-<UTC timestamp>/configs.tar.gz` с текущими scoped конфигами и приложениями. Архивы закрыты root; могут содержать secrets.

При rollback остановить `gpt-voice-web` или `gpt-voice-dialer`/`asterisk`, извлечь нужные scoped файлы из выбранного архива, выполнить `systemctl daemon-reload`, проверить nginx и запустить предыдущую версию. Не извлекать весь `/etc` поверх текущей системы и не удалять общие пакеты. Для первого развёртывания предыдущих project-сервисов не было: можно отключить только project units и scoped nginx vhost, сохранив SSH/Zabbix. Снятие UFW после первого deployment допустимо только при восстановлении точно исходного network policy; не отключать его автоматически при обычном code rollback.

## Подтверждённый результат и ограничения

MVP1 **принят 2026-10-05**. После предоставления доступа к модели успешно выполнены WebRTC smoke с явным configured key, прямой PCMA WebSocket smoke на NL и полный `test:sim1`. Затем выполнен один согласованный PSTN-звонок. Владелец подтвердил двустороннюю слышимость, перебивание, паузу и завершение; transcript обеих сторон, Live usage и cleanup подтверждены логами. Allowlist снова `none`.

Первоначальный отказ `model_not_found` сохранён как диагностическая история. Доступ к WebSocket применился позже WebRTC/model lookup; гипотеза — задержка распространения доступа, точная внутренняя причина OpenAI неизвестна. Ранний smoke с иным inherited key не засчитывался. Voice model сохранился `gpt-live-1`, backend user config — `gpt-6-luna`.

Новая независимая проверка: `node scripts/live-smoke.mjs /absolute/path/config.env` (на model server можно без аргумента). Она явно читает key из выбранного dotenv, создаёт PCMA Live-сессию и проверяет started/closed. Нельзя source-ить общий config или выводить его. Последующий deployment всё равно сначала закрывает PSTN.

Проверены только один owner number, один voice и текущая инфраструктура. Массовый обзвон, другие операторы, восстановление backup в аварийном режиме, нагрузка и долгие звонки не проверялись. Поле `usage_seconds=null` означает неизвестное значение. Evidence: `docs/evidence/mvp1-20261005.md`.
