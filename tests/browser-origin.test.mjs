import test from 'node:test';
import assert from 'node:assert/strict';
import {browserOriginAllowed} from '../lib/browser-origin.mjs';
const origins = new Set(['https://4pj.com.ru']);
test('публичный GUI принимает свой Origin и локальные служебные запросы', () => {
  assert.equal(browserOriginAllowed({headers:{origin:'https://4pj.com.ru','sec-fetch-site':'same-origin'}}, origins), true);
  assert.equal(browserOriginAllowed({headers:{}}, origins), true);
});
test('чужой Origin и cross-site запрос блокируются, включая WebSocket', () => {
  assert.equal(browserOriginAllowed({headers:{origin:'https://foreign.invalid'}}, origins), false);
  assert.equal(browserOriginAllowed({headers:{'sec-fetch-site':'cross-site'}}, origins), false);
});
