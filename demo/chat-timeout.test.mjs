import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const request = (port, path) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    res.on('error', reject);
  });
  r.on('error', reject);
  r.end('{}');
});

test('real edge carries delayed chat streaming beyond 15s while ordinary API still times out', { timeout: 30_000 }, async () => {
  const timers = new Set();
  const api = http.createServer((req, res) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      const end = setTimeout(() => { timers.delete(end); res.end('data: last\n\n'); }, 100);
      timers.add(end);
    }, 16_500);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
    req.resume();
  });
  const apiPort = await listen(api);
  const reservation = http.createServer();
  const edgePort = await listen(reservation);
  await new Promise((r) => reservation.close(r));
  const edge = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(edgePort), API_PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      edge.stdout.once('data', resolve);
      edge.once('error', reject);
      edge.once('exit', (code) => reject(new Error(`edge exit ${code}`)));
    });
    const [chat, ordinary] = await Promise.all([
      request(edgePort, '/api/tenants/demo/ai/conversations/cv-0123456789ab/chat'),
      request(edgePort, '/api/tenants/demo/ai/models/test'),
    ]);
    assert.equal(chat.status, 200);
    assert.equal(chat.type, 'text/event-stream');
    assert.equal(chat.body, 'data: first\n\ndata: last\n\n');
    assert.equal(ordinary.status, 504);
    assert.equal(ordinary.body, 'upstream timeout');
  } finally {
    edge.kill('SIGKILL');
    for (const timer of timers) clearTimeout(timer);
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
  }
});
