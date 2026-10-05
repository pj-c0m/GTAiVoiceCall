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

Локально нужны Node 22.22.1+, npm, Python 3 с venv, SSH, rsync и dig. `npm ci`; для offline regression — `python3 -m venv .venv` и `.venv/bin/pip install -r pbx-server/requirements.txt`.

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


## GUI и scheduler: подготовлено локально, не развёрнуто

В task-ветке добавлено серверное планирование и новый интерфейс телефонии.
Два сервера и audio path сохранены. Новая версия требует Node 22.22.1+
с доступным `node:sqlite`; Node сообщает ExperimentalWarning SQLite.
Реальные API smoke, deployment и PSTN для этой функции не выполнялись.

Локальный запуск без model key и bridge пригоден для проверки формы/API:

```bash
npm ci
npm test
PORT=3000 JOB_DB_PATH=/absolute/private/path/calls.sqlite npm start
```

Не задавайте OpenAI/bridge credentials для offline проверки. Закрытый config
main не нужен GUI worktree. Без bridge задания ожидают линию до истечения окна,
затем становятся missed. `npm run check` является платным Live smoke и в этом
цикле не запускается. Python regression: создать `.venv`, установить
`pbx-server/requirements.txt`, запустить `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`.

### Постоянные данные и единственный процесс

Default БД: `/srv/gpt-voice/data/calls.sqlite` (локально `data/calls.sqlite`).
`JOB_DB_PATH` может переопределить путь. БД содержит номера/имена, инструкции,
тексты приложений и transcript; каталог 0700, файл/lock 0600. Каталог должен
принадлежать сервисному пользователю и сохраняться между обновлениями.
WAL/SHM — часть работающей SQLite БД, не удалять вручную. Данные и backup
исключены из Git; перенос между рабочими местами требует отдельного защищённого
переноса state, обычный clone содержит только код.

Только один model-server процесс на БД. Lock проверяет PID владельца;
нечитаемый lock, живой PID (включая переиспользованный) или lock recovery guard
блокирует scheduler. После crash доказанно отсутствующий PID допускает recovery.
Не удалять lock на работающем сервисе. При аварии во время lock recovery может
остаться `.lock.recovery`: перед ручным удалением нужно убедиться, что сервис
остановлен и восстанавливающего процесса нет. Ошибка хранения останавливает
новые телефонные попытки; не создавать пустую БД вместо повреждённой.

Заготовки installer/unit создают `data` и разрешают запись через
`ReadWritePaths=/srv/gpt-voice/logs /srv/gpt-voice/data`. Stage содержит новые
`lib`, `public` и restore script; `data` не попадает в stage и не перезаписывается.
При нестандартном JOB_DB_PATH нужен отдельный systemd override ReadWritePaths.
Эти изменения ещё не применены к production. Deployment — отдельное решение
координатора после inventory/rollback и acceptance выбранного scope.

### Restart, пропущенное время и неизвестный исход

Задание запускается максимум через 120 секунд после назначенного времени.
Занятый канал, отсутствие bridge hello и orphan PBX канал дают waiting;
истёкшее окно — missed. DST gap/fold и отсутствие явного timezone отклоняются.
Фиксируется UTC instant; timezone браузера после создания ничего не меняет.

До команды PBX транзакционно сохраняются dispatching и attemptId. После этой
границы исключение или crash не возвращают задание в очередь. При restart
active/dispatching становятся unknown. Новый разговор требует нового задания;
автоматических retries или recurring calls нет. Это at-most-once attempt,
не гарантия exactly-once PSTN. Ошибка до фактической отправки после claim может
потерять звонок — такой компромисс выбран ради отсутствия случайного дубля.

Один канал enforced CallHub для новых jobs и старых immediate/campaign API.
Отсутствие подтверждения PBX/Live cleanup удерживает gate. Лимит 30–1800 секунд
(default 300) начинается от ответа; ожидание ответа ограничено 60 секундами.
Закрытие browser не вызывает hangup server job. «Отмена» применима до claim;
после начала используется «Завершить», и UI ждёт подтверждения lifecycle.

Карточка проверки фиксирует профиль/session на 10 минут в памяти сервера;
restart требует проверки заново. После POST задание устойчиво. Повтор HTTP
использует Idempotency-Key; изменённый payload с тем же key получает 409.
API mutations проверяют Origin. UI рассчитан на loopback/SSH tunnel, без
публичной аутентификации; не публиковать порт в интернете в этом scope.

### Backup, restore и rollback

Остановите сервис перед файловым backup и проверьте отсутствие процесса.
Копировать только `calls.sqlite` при активном WAL нельзя. Например, после
остановки сохраните весь каталог данных, исключив process locks:

```bash
systemctl stop gpt-voice-web
umask 077
tar -C /srv/gpt-voice/data -czf /root/gtaivc-calls-backup.tar.gz --exclude='*.lock*' .
```

Это инструкции для отдельно авторизованной эксплуатации, не выполненные
серверные команды текущей задачи. Backup защищать как личные данные.
При restore остановить сервис, сохранить текущий state отдельно, восстановить
согласованный архив с владельцем gptvoice и закрытыми правами. **До запуска**:

```bash
cd /srv/gpt-voice
sudo -u gptvoice node scripts/restore-job-state.mjs /srv/gpt-voice/data/calls.sqlite
```

Restore script требует существующую БД и переводит runnable задания в unknown:
старый snapshot не доказывает, что звонок не выполнился после backup. Активные
попытки также unknown; терминальные состояния сохраняются. Оператор проверяет
АТС и создаёт новые задания вручную. Никогда не возобновлять расписание прямо
из старого backup. Rollback к прежнему коду сохраняет каталог БД; прежний код
не выполняет новое расписание. При возвращении новой версии после restore
обязательна эта подготовка, иначе старые задания могут быть выполнены повторно.

### Интерпретация результата

Completed требует PBX ended и подтверждённого закрытия Live. Failed — подтверждённый
отказ/no answer. Unknown не является успешным звонком и не повторяется автоматически.
Transcript/usage доступны после restart; промежуточные данные crash не выдаются
за окончательные. «Оценка Live» использует сохранённый тариф проекта $0.05/мин
по usage seconds, без PBX/backend. При отсутствии usage — «Нет данных», не $0.
Тариф не подтверждает актуальный полный счёт провайдеров.

Хранилище ограничено 10000 заданиями и 1000 контактами, list API — последними
100 карточками. При заполнении создание отклоняется; автоматического удаления
истории нет. Редактирование сохранённого задания выполняется отменой и созданием
нового. Local tests не доказывают новый production/PSTN acceptance.
