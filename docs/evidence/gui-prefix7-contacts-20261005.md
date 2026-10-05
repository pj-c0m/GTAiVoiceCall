# Номера +7 и сохранённые контакты — 2026-10-05

Владелец явно разрешил любые номера +7 из авторизованного GUI и попросил
уточнить назначение «Сохранить контакт». Runtime code SHA: 68f1808.
Адрес: https://4pj.com.ru/?profile=example-call.

## Выполнено

- На PBX PSTN_NUMBER_POLICY=prefix7, разрешены 7 и ещё 10 ASCII цифр,
  включая запись +7 и форматирование. 8…, локальные и другие коды запрещены.
- Jobs/contacts API нормализует номер в +7; legacy calls/campaigns также
  отклоняет другой код до открытия Live. PBX независимо проверяет префикс.
- Default allowlist остаётся закрытым; prefix7 включается deployment только
  отдельным аргументом. Владелец разрешил включить его в этом цикле.
- Сохранены MAX_CALLS=1 и RECORD_CALLS=off, SIP/ARI/bridge credentials.
- Список назван «Сохранённые контакты». Подпись поясняет, что контакты
  хранятся на сервере и доступны с любого ПК после входа.
- После сохранения новый контакт сразу выбран, поле номера нормализовано,
  доступна кнопка удаления, сообщение подтверждает место сохранения.

## Проверки

- 44 Node tests и 5 Python regressions PASS. Python mock originate
  подтверждает допуск +7 без реального звонка и отказ 8….
- Публичный browser smoke: контакт создан через GUI, автоматически выбран,
  появляется в отдельном browser context; тестовый контакт удалён по его ID.
- Production /api/pbx/status подтверждает policy=prefix7; foreign prefix
  получает HTTP 400 в jobs preview, calls и campaigns. Valid +7 preview — 200,
  не создаёт задания/звонка.
- Desktop/mobile: page errors=0, горизонтального overflow нет. Screenshots
  contacts-desktop.png и contacts-mobile.png в gui-scheduler-20261005; история
  пользователей на desktop закрыта маской.
- После deployment все project services и Zabbix active, SIP Registered,
  0 active channels/calls. Реальных звонков в этом обновлении не делали.

Rollback на обоих хостах: /root/gtaivc-gui-rollback-20261005T130429Z;
включает scoped configs, model code, PBX code и отдельную stopped DB.
Для возврата закрытой политики установить PSTN_NUMBER_POLICY=allowlist
при ALLOWED_NUMBERS=none и перезапустить только gpt-voice-dialer без активных
разговоров. Секреты, реальные номера и пользовательские transcript здесь
не публикуются. История ранее отклонённых jobs не менялась и не повторялась.
