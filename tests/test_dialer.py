"""Регрессии ограничения набора и завершения при потере bridge; без PSTN."""
import importlib.util
import os
import tempfile
import unittest
from unittest.mock import AsyncMock
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

os.environ.update(ARI_USER='test', ARI_PASSWORD='test', BRIDGE_TOKEN='test', LOG_DIR=tempfile.mkdtemp())
spec = importlib.util.spec_from_file_location('dialer', 'pbx-server/dialer.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_command_after_keepalive_ping(self):
        import asyncio
        hub = d.Hub()
        app = web.Application()
        app.router.add_get('/pbx/bridge', hub.handle_bridge)
        async with TestServer(app) as server:
            code = '''
import { CallHub } from './lib/calls.mjs';
const hub = new CallHub({url: process.argv[1], token:'test', openai:{}});
hub.ws.on('open',()=>{hub.ws.ping();setTimeout(()=>hub.send({type:'ping'}),50);});
hub.ws.on('message',d=>{if(JSON.parse(d).type==='pong')process.exit(0);});
hub.ws.on('close',c=>{console.log('close',c);process.exit(1);});
setTimeout(()=>process.exit(2),1500);
'''
            proc = await asyncio.create_subprocess_exec('node', '--input-type=module', '-e', code, str(server.make_url('/pbx/bridge')).replace('http:', 'ws:'), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await proc.communicate()
            self.assertEqual(proc.returncode, 0, stdout.decode()+stderr.decode())

    async def test_empty_allowlist_never_originates(self):
        hub = d.Hub()
        d.ALLOWED_NUMBERS = set()
        hub.ari.call = AsyncMock(return_value={})
        ws = AsyncMock()
        await hub.start_call(ws, {'slot': 1, 'to': '79990000000'})
        self.assertEqual(hub.calls, {})
        self.assertFalse(hub.ari.call.called, 'Пустой allowlist вызвал originate')

    async def test_disconnect_releases_calls_and_audio_queue(self):
        hub = d.Hub()
        call = d.Call(hub, 1, 'test:sim1', 'test:sim1')
        hub.calls[1] = call
        hub.outq.append(b'old-audio')
        paths = []
        async def ari(method, path, **kw):
            paths.append((method, path))
            return {}
        hub.ari.call = ari
        app = web.Application()
        app.router.add_get('/pbx/bridge', hub.handle_bridge)
        async with TestServer(app) as server, ClientSession() as client:
            ws = await client.ws_connect(server.make_url('/pbx/bridge'), headers={'Authorization': 'Bearer test'})
            await ws.receive_json()
            await ws.close()
            for _ in range(20):
                if hub.brain is None:
                    break
                await __import__('asyncio').sleep(.01)
        self.assertEqual(hub.calls, {}, 'Разрыв bridge оставил активный звонок')
        self.assertFalse(hub.outq)
        self.assertIn(('DELETE', 'channels/' + call.channel_id), paths)
        self.assertIn(('DELETE', 'channels/' + call.ext_id), paths)
        self.assertIn(('DELETE', 'bridges/' + call.bridge_id), paths)

if __name__ == '__main__':
    unittest.main()
