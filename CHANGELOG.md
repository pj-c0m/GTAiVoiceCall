# Changelog

## [Unreleased]

- Deployment на Ubuntu 26.04 с inventory/backup, разделением OpenAI и SIP credentials и TLS bridge; исходящий PSTN закрыт до self-test.
- Поддержка Mango SIP через UDP 60000 и отдельных сетей сигнализации/RTP.
- Пустой allowlist больше не разрешает реальные звонки.
- Потеря bridge или ошибка Live завершает звонок и освобождает ресурсы; отсутствующий usage сохраняется как неизвестный.
- Исправлен разрыв bridge с кодом 1002 после keepalive ping при aiohttp 3.14: compression отключён, аудиопротокол сохранён.

- MVP1 подтверждён self-test и реальным двусторонним PSTN-звонком с подтверждением владельца, Live usage и cleanup.
- Минимальный branding GTAiVoiceCall в интерфейсе и metadata; upstream/MIT attribution сохранены.
