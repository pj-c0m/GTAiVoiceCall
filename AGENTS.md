# GTAiVoiceCall

Документацию и содержательные комментарии писать на русском языке.
Сохранять MIT LICENSE и attribution kpshinnik/gpt_voice_pbx.
База MVP1: 22419d6e02b023d230b455446a5607143ddb4754.

Project main координирует проект. Самостоятельная реализация выполняется в
отдельном task-chat, task-ветке и worktree от актуального локального main.
Не изменять пользовательские файлы вне задачи и не публиковать секреты.

Для MVP1 сначала запускать существующий upstream практически без изменений.
Сохранять два сервера, Asterisk/PJSIP/ARI/externalMedia, PCMA 8 kHz,
WebSocket bridge, Live API, call lifecycle, diagnostics и test:sim1.
Изменять компоненты только после диагностики доказанной проблемы.
Branding выполнять после подтверждённого реального звонка.

## Авторизация текущего цикла

Пользователь 2026-10-05 дал команду «старт» после заполнения локального
GTAiVoiceCall-MVP1.env и подтвердил продолжительное выполнение MVP1.
Разрешены создание отдельного task-chat/worktree и private GitHub repo
из конфигурации, scoped commits/push, deployment на два указанных сервера,
настройка Mango SIP, test:sim1 и один реальный звонок только на ALLOWED_NUMBERS.
Повторные реальные звонки согласовывать с владельцем.
Эта явная авторизация разрешает task-chat выполнить весь MVP1, включая
deployment, без повторных запросов разрешения для уже согласованных действий.
До серверных изменений выполнить inventory и сохранить rollback-конфигурацию.
Не трогать посторонние сервисы, включая установленный zabbix-agent.

Секретный файл доступен только в project main; прочитать его по абсолютному
пути без вывода значений. Не source-ить файл без проверки синтаксиса и
не копировать общий файл со всеми credentials на model server: OpenAI key
только на model server, SIP credentials только на PBX server.

Вести CHANGELOG.md и DEPLOY.md. Сохранять sanitized evidence звонка:
SHA, deployment/SIP/bridge status, call IDs, transcript, usage, hangup и cleanup.
MVP1 подтверждён только фактическим двусторонним PSTN-разговором и освобождением
каналов, bridge и Live-сессии. Старт сервиса не является acceptance.
