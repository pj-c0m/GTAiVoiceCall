// Проверка проекции credentials через настоящий renderer и контролируемый DNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

test('Secrets разделены, PSTN закрыт, Mango subnet и port60000 сохранены',()=>{
 const root=mkdtempSync(join(tmpdir(),'gtaivc-test-'));
 try {
  const e={MVP_CONFIG_COMPLETE:'yes',MODEL_SSH:'root@192.0.2.1',PBX_SSH:'root@192.0.2.2',OPENAI_API_KEY:'fixture-openai-secret',PBX_EXTENSION:'fixtureuser',PBX_DOMAIN:'test.mangosip.ru',PBX_SIP_PASSWORD:'fixture-sip-secret',BRIDGE_DOMAIN:'pbx.example.invalid',ADMIN_EMAIL:'test@example.invalid',ALLOWED_NUMBERS:'79990000000',PBX_SIP_PORT:'60000'};
  const config=join(root,'config.env');
  writeFileSync(config,Object.entries(e).map(([k,v])=>`${k}=${v}`).join('\n'));
  mkdirSync(join(root,'bin'));
  writeFileSync(join(root,'bin','dig'),'#!/bin/sh\necho 192.0.2.2\n',{mode:0o700});
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,MVP_DEPLOY_STATE_PATH:join(root,'state.env')};
  for(const mode of ['model','pbx']) {
   const output=join(root,mode);
   const r=spawnSync(process.execPath,['scripts/prepare-deploy.mjs',config,output,mode],{env,encoding:'utf8'});
   assert.equal(r.status,0,r.stderr);
   if(mode==='model') {
    const projected=parseEnv(readFileSync(join(output,'.env'),'utf8'));
    assert.equal(projected.OPENAI_API_KEY,'fixture-openai-secret');
    assert.equal(projected.PBX_SIP_PASSWORD,undefined);
    assert.equal(projected.ALLOWED_NUMBERS,undefined);
    assert.match(readFileSync(join(output,'scripts/live-smoke.mjs'),'utf8'),/parseEnv/);
    assert.match(readFileSync(join(output,'scripts/calls.mjs'),'utf8'),/calls/);
   } else {
    const projected=parseEnv(readFileSync(join(output,'dialer.env'),'utf8'));
    assert.equal(projected.ALLOWED_NUMBERS,'none');
    assert.equal(projected.OPENAI_API_KEY,undefined);
    const sip=readFileSync(join(output,'asterisk/pjsip.conf'),'utf8');
    assert.match(sip,/server_uri=sip:test.mangosip.ru:60000/);
    assert.match(sip,/match=81.88.86.0\/24/);
    assert.match(sip,/password=fixture-sip-secret/);
   }
  }
  e.ALLOWED_NUMBERS='';
  writeFileSync(config,Object.entries(e).map(([k,v])=>`${k}=${v}`).join('\n'));
  const r=spawnSync(process.execPath,['scripts/prepare-deploy.mjs',config,join(root,'invalid'),'pbx'],{env,encoding:'utf8'});
  assert.notEqual(r.status,0);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test('model unit permits persistent scheduler data and installer creates it',()=>{
 const service=readFileSync('model-server/gpt-voice-web.service','utf8');assert.match(service,/ReadWritePaths=.*\/srv\/gpt-voice\/data/);
 const installer=readFileSync('scripts/deploy-mvp1.mjs','utf8');assert.match(installer,/install -d -m 700 -o gptvoice -g gptvoice \/srv\/gpt-voice\/data/);
});
