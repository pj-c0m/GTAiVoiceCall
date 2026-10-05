# Handoff project main: GUI и устойчивый scheduler

Task branch: `codex/call-control-gui-20261005`; база `043ce43`.
Кодовая контрольная точка публичного GUI: `44ab5fe`; итоговый SHA документации сообщён в task-chat.
Не интегрировано в main. По новому прямому запросу владельца 2026-10-05
GUI развёрнут на production с HTTPS-авторизацией: https://4pj.com.ru/.

Добавлены операторский GUI, contacts/jobs API, SQLite history и scheduler,
transactional claim до команды PBX, lifecycle gate и безопасный restore snapshot.
Полный scope и evidence: [GUI report](docs/evidence/gui-scheduler-20261005.md).
Deployment/runtime/backup: [DEPLOY.md](DEPLOY.md).

PASS: 41 Node tests на Node 25.3.0 и 22.22.1, 3 Python regressions,
localhost browser desktop/mobile smoke и независимый UI review ship.
Production deployment, WebRTC, test:sim1, audio, schedule/restart/stop/cleanup проверены.
NOT VERIFIED: новый PSTN smoke; выбор политики номеров ожидает владельца.
Номера/allowlist/recording production не менялись; общий dotenv не копировался.

Рекомендуемая проверка координатора после integration: npm ci, npm test,
Python regression; deployment уже выполнен из подтверждённой task-ветки.
Нужны Node 22.22.1+, постоянный writable data каталог и один model process;
не размещать operator API публично без отдельной аутентификации.
Главный runtime компромисс: unknown/missed не повторяются автоматически,
а окно допустимого опоздания — 120 секунд. Разрешение нового PSTN отдельно.

Task worktree сохраняется. Push относится только к task branch;
main push/cleanup не выполнялись; scoped deployment разрешён отдельным запросом владельца.

## История: MVP1

Task branch: `codex/mvp1-launch-20261005`, база `a258a36`. **MVP1 принят 2026-10-05**: успешный `test:sim1`, один разрешённый PSTN-разговор, Live transcript/usage/cleanup; владелец подтвердил «Всё работало нормально» для слышимости, перебивания, паузы и завершения.

PSTN `pc-muv0nhi3-1`, PBX `call-1-6452a2bd`: talk 46 s, Live usage 44 s, errors 0. После звонка allowlist снова `none`, recording off, max calls 1; channels/bridge/model calls пусты. Разрешённый звонок использован, повтор требует согласования. SIP Registered на UDP 60000, bridge connected, Zabbix сохранён active.

Подтверждены безопасный split env, inventory/backup до mutations, scoped deployment двух серверов, минимальные исправления воспроизведённых allowlist/bridge/Live проблем и 6 offline regression PASS. Branding выполнен после acceptance. Подробности: DEPLOY.md и docs/evidence/mvp1-20261005.md. Ранний smoke с inherited key исключён из acceptance; итоговые проверки использовали configured key и gpt-live-1.

Scoped commits/push task-ветки разрешены; на момент первоначального handoff main не был интегрирован. Worktree был сохранён. Игнорируемый `.deployment-secrets.env` требуется для повторного deployment, хранить закрыто и отдельно от Git; общий пользовательский config остаётся только в project main. Не удалять worktree до отдельного переноса этого state. Последующий deployment PBX автоматически закрывает PSTN. Новые звонки, массовый обзвон и deployment иных изменений не входят в завершённый acceptance.

## Синхронизация 2026-10-05

По подтверждению владельца MVP1 интегрирован fast-forward в project main до `b85ea666bcbcdbeebbba3dda8026f3c3cedb0068`. Все 6 regression tests после интеграции прошли. Закрытый `.deployment-secrets.env` сохранён в project main с правами `600`, вне Git. Синхронизация не выполняет нового deployment или звонка. Следующая самостоятельная задача — GUI управления и серверное планирование звонков в отдельном task-chat/worktree.

Публичный runtime evidence: [GUI HTTPS report](docs/evidence/gui-public-20261005.md).
