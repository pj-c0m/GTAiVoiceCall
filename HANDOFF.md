# Handoff project main: MVP1

Task branch: `codex/mvp1-launch-20261005`, база `a258a36`. Worktree сохранён. Интеграция main и deployment handoff завершающего acceptance не выполнялись. Scoped deployment уже разрешён и выполнен на двух хостах.

Подтверждено: безопасный split env и backup; Node/Asterisk/nginx/dialer active; Mango Registered на UDP 60000; TLS bridge connected с проверками 401/200/403; очистка PBX при отказе Live; 6 offline regression PASS; secret scan кандидатных файлов без совпадений. Минимальные исправления вызваны воспроизведёнными allowlist/bridge/Live проблемами. Детали в DEPLOY.md и docs/evidence/mvp1-20261005.md.

Внешний blocker: key из локального config не имеет доступа к gpt-live-1. Ранний local smoke PASS использовал другой inherited key; он исключён из acceptance. Точный configured-key WebRTC и server WebSocket smoke отказали по model access. Voice model не заменялся. Пользовательский dotenv не изменён. Owner request о предоставлении доступа отправлен в task UI.

Продолжение: после owner сообщения о доступе перечитать config безопасным parser, сохранить `.deployment-secrets.env` текущего worktree (не Git), обновить только model env/deployment. Явно изолировать key локального smoke от inherited env. Повторить WebRTC check и test:sim1 с transcript/Live usage/cleanup. До PASS не открывать allowlist и не звонить. Затем уведомить владельца в task UI, выполнить единственный разрешённый звонок на owner number, получить duplex/interruption/silence/hangup confirmation, снова закрыть allowlist, сохранить sanitized evidence. Только после этого branding/acceptance и окончательный handoff.

Один PSTN звонок ещё не использован. `ALLOWED_NUMBERS=none` на PBX. Не удалять worktree: в нём закрытый игнорируемый deployment state; перед переносом credentials/state сохранять отдельно. Не публиковать raw transcript, owner number или config. Не заявлять MVP1 PASS по service/registration status.
