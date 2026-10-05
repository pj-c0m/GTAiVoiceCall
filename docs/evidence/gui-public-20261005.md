# Публичный GUI GTAiVoiceCall — 2026-10-05

Владелец запросил полноценный доступ с любого ПК и пароль из guipass.env.
Адрес: https://4pj.com.ru/?profile=example-call, логин admin. Пароль не
включён в evidence; на PBX передан только crypt hash.

## Подтверждено

- HTTPS с проверкой сертификата; anonymous UI/static/API/SSE/audio получает 401.
- Неверный пароль получает 401, чужой Origin — 403.
- Контакт создан, прочитан и удалён; текст файла извлечён через публичный API.
- Карточка preview, расписание и отмена сохранены в production SQLite.
- Настоящий test:sim1 через публичный jobs API: job `b59cf5d2-f6ce-4e3a-94ff-5db560408815`,
  call `pc-muv504ig-1`, completed, talk 30 s, usage 29 s,
  оценка Live $0.024167; четыре transcript turns обеих сторон.
- Authenticated audio WebSocket получил 1838 кадров.
- Лимит 30 s завершил sim, PBX и Live cleanupConfirmed=true, канал освобождён.
- WebRTC через публичный /api/session: session.started и session.closed, usage 15 s.
- Запланированный job `0c63aba4-c206-4ae9-ae58-de09ae9e31c4` пережил restart gpt-voice-web,
  стартовал без браузера в 11:02 UTC; call `pc-muv543ku-1` остановлен после ответа,
  completed, talk 1 s, cleanupConfirmed=true.
- Desktop 1440 и mobile 390: интерфейс доступен после авторизации, page errors=0,
  горизонтальный overflow отсутствует. Проверены screenshots.
- 43 Node tests и 3 Python regressions PASS.

## Размещение и rollback

NL: существующий /srv/gpt-voice, gpt-voice-web, БД data/calls.sqlite 0600,
каталог 0700, loopback 3000. PBX: nginx HTTPS, новый gpt-voice-gui-tunnel,
loopback 13000. SSH key ограничен PBX source IP и destination 127.0.0.1:3000.
SIP Mango Registered, PCMA bridge сохранён. Zabbix active на обоих хостах.

Первый rollback: /root/gtaivc-gui-rollback-20261005T105535Z на обоих серверах.
В начале deployment исправлены воспроизведённые проблемы: cp -a наследовал
закрытые owner/mode stage для корневого каталога приложения; неверная key option
блокировала tunnel. Installer теперь выставляет root:gptvoice 0750,
ограничивает remote forwarding через sshd Match и проверяет доступность tunnel
перед успешным завершением. Cleartext credentials в Git/evidence отсутствуют.

## Ограничения

Новый реальный PSTN-звонок не выполнялся. Production ALLOWED_NUMBERS=none
сохранён до ответа владельца о политике номеров и разрешении проверочного звонка.
Нельзя выдавать симулятор за реальный PSTN acceptance. Проверен HTTP/WebRTC
transport, живой микрофон пользователя с другого ПК не проверялся. Main не
интегрирован; task branch/worktree сохраняются.


Обновление после нового решения владельца: PSTN_NUMBER_POLICY=prefix7
включена, любые номера +7 разрешены. Предыдущая заметка ALLOWED_NUMBERS=none
описывает состояние до этого решения; при prefix7 доступ определяет
проверка префикса. Новый PSTN smoke не выполнялся.
Evidence: [Обновление +7/contacts](gui-prefix7-contacts-20261005.md).
