# Handoff project main: MVP1

Task branch: `codex/mvp1-launch-20261005`, база `a258a36`. **MVP1 принят 2026-10-05**: успешный `test:sim1`, один разрешённый PSTN-разговор, Live transcript/usage/cleanup; владелец подтвердил «Всё работало нормально» для слышимости, перебивания, паузы и завершения.

PSTN `pc-muv0nhi3-1`, PBX `call-1-6452a2bd`: talk 46 s, Live usage 44 s, errors 0. После звонка allowlist снова `none`, recording off, max calls 1; channels/bridge/model calls пусты. Разрешённый звонок использован, повтор требует согласования. SIP Registered на UDP 60000, bridge connected, Zabbix сохранён active.

Подтверждены безопасный split env, inventory/backup до mutations, scoped deployment двух серверов, минимальные исправления воспроизведённых allowlist/bridge/Live проблем и 6 offline regression PASS. Branding выполнен после acceptance. Подробности: DEPLOY.md и docs/evidence/mvp1-20261005.md. Ранний smoke с inherited key исключён из acceptance; итоговые проверки использовали configured key и gpt-live-1.

Scoped commits/push task-ветки разрешены; на момент первоначального handoff main не был интегрирован. Worktree был сохранён. Игнорируемый `.deployment-secrets.env` требуется для повторного deployment, хранить закрыто и отдельно от Git; общий пользовательский config остаётся только в project main. Не удалять worktree до отдельного переноса этого state. Последующий deployment PBX автоматически закрывает PSTN. Новые звонки, массовый обзвон и deployment иных изменений не входят в завершённый acceptance.

## Синхронизация 2026-10-05

По подтверждению владельца MVP1 интегрирован fast-forward в project main до `b85ea666bcbcdbeebbba3dda8026f3c3cedb0068`. Все 6 regression tests после интеграции прошли. Закрытый `.deployment-secrets.env` сохранён в project main с правами `600`, вне Git. Синхронизация не выполняет нового deployment или звонка. Следующая самостоятельная задача — GUI управления и серверное планирование звонков в отдельном task-chat/worktree.
