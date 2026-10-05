import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTime,validateJobInput,validateContact} from '../lib/job-input.mjs';
const now=Date.parse('2026-10-05T09:00:00Z');
test('Moscow timezone roundtrip',()=>assert.equal(resolveTime({localTime:'2026-10-05T13:00',timeZone:'Europe/Moscow'}).scheduledAt,'2026-10-05T10:00:00.000Z'));
for(const localTime of ['2026-03-08T02:30','2026-11-01T01:30']) test(`DST rejects ${localTime}`,()=>assert.throws(()=>resolveTime({localTime,timeZone:'America/New_York'})));
test('duration defaults and bounds',()=>{
 assert.equal(validateJobInput({to:'test:sim1',when:'now'},now).maxDurationSeconds,300);
 for(const maxDurationSeconds of [29,1801,'300']) assert.throws(()=>validateJobInput({to:'test:sim1',maxDurationSeconds},now));
 assert.throws(()=>validateJobInput({to:'123',when:'now'},now));
 assert.throws(()=>validateJobInput({to:'test:sim1',when:'scheduled',localTime:'2026-10-04T12:00',timeZone:'Europe/Moscow'},now));
});
test('invalid types and file budgets reject explicitly',()=>{
 for(const body of [{to:5},{to:'test:sim1',name:{}},{to:'test:sim1',when:'other'},{to:'test:sim1',files:{}},{to:'test:sim1',files:Array.from({length:51},()=>({name:'x',text:'a'}))},{to:'test:sim1',files:[{name:'x',text:'a'.repeat(120001)}]}])assert.throws(()=>validateJobInput(body,now));
 assert.throws(()=>resolveTime({localTime:'2026-02-30T12:00',timeZone:'Europe/Moscow'}));assert.throws(()=>resolveTime({localTime:'2026-10-05T12:00',timeZone:'invalid'}));
});
test('scheduled calls require an explicit timezone',()=>assert.throws(()=>resolveTime({localTime:'2026-10-06T13:00'})));
test('validation identifies the field needing correction',()=>{try{validateJobInput({to:'test:sim1',maxDurationSeconds:1},now);assert.fail('expected validation');}catch(e){assert.equal(e.field,'maxDurationSeconds');}try{validateContact({to:'bad'});assert.fail();}catch(e){assert.equal(e.field,'to');}});
