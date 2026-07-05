/**
 * API integration test: drives a real bot (Chromium + WebRTC harness page)
 * entirely through the HTTP API, and verifies Svix-style webhook delivery
 * with signature checks. Soniox is intentionally not used here (covered by
 * meet-bot's pipeline test) — this test is about the API contract.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from '../src/bot-manager.js';
import { WebhookDispatcher } from '../src/webhooks.js';
import { createApiServer } from '../src/server.js';
import { harnessAdapter } from '@recall-clone/meet-bot/test/harness/adapter.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(DIR, '../../meet-bot/test/harness');
const GEN = path.join(HARNESS, 'generated');
const API_TOKEN = 'test-token';
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('server-test-secret').toString('base64');

const hasTts = (() => { try { execSync('which say ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; } })();

let harnessSrv, apiSrv, hookSrv, manager, dispatcher, baseUrl, apiUrl;
const hooks = [];

before(async () => {
  if (!hasTts) return;
  fs.mkdirSync(GEN, { recursive: true });
  for (const [pid, voice, text] of [
    ['p1', 'Samantha', 'Hello everyone welcome to the quarterly review meeting'],
    ['p2', 'Daniel', 'Thanks Alice the sales pipeline looks strong this quarter'],
  ]) {
    const wav = path.join(GEN, `${pid}.wav`);
    if (fs.existsSync(wav)) continue;
    const aiff = path.join(GEN, `${pid}.aiff`);
    execSync(`say -v ${voice} -o ${JSON.stringify(aiff)} ${JSON.stringify(text)}`);
    execSync(`ffmpeg -y -loglevel error -i ${JSON.stringify(aiff)} -ar 48000 -ac 1 ${JSON.stringify(wav)}`);
  }

  harnessSrv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'meeting.html';
    const file = path.join(HARNESS, rel);
    if (!file.startsWith(HARNESS) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'audio/wav' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => harnessSrv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${harnessSrv.address().port}`;

  hookSrv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    hooks.push({ headers: req.headers, body: raw });
    res.writeHead(200); res.end();
  });
  await new Promise((r) => hookSrv.listen(0, '127.0.0.1', r));

  dispatcher = new WebhookDispatcher({
    url: `http://127.0.0.1:${hookSrv.address().port}/hook`,
    secret: WEBHOOK_SECRET,
  });
  manager = new BotManager({
    artifactsRoot: path.join(GEN, 'server-artifacts'),
    dispatcher,
    adapters: [harnessAdapter],
  });
  apiSrv = createApiServer({ apiToken: API_TOKEN, manager });
  await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${apiSrv.address().port}`;
});

after(async () => {
  await manager?.stopAll();
  for (const s of [harnessSrv, hookSrv, apiSrv]) s?.close();
});

const api = (method, p, body) =>
  fetch(`${apiUrl}${p}`, {
    method,
    headers: { authorization: `Token ${API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

test('auth is enforced', { skip: !hasTts }, async () => {
  const res = await fetch(`${apiUrl}/api/v1/bot`);
  assert.equal(res.status, 401);
});

test('bot lifecycle over HTTP: create → record → leave → artifacts → webhooks', { skip: !hasTts, timeout: 180000 }, async () => {
  const created = await api('POST', '/api/v1/bot', {
    meeting_url: `${baseUrl}/meeting.html`,
    bot_name: 'API Test Bot',
    metadata: { customer_ref: 'abc123' },
  });
  assert.equal(created.status, 201);
  const bot = await created.json();
  assert.ok(bot.id);
  assert.equal(bot.status_changes[0].code, 'ready');

  // Poll until in-call.
  let record;
  for (let i = 0; i < 60; i++) {
    record = await (await api('GET', `/api/v1/bot/${bot.id}`)).json();
    if (record.status_changes.some((s) => s.code === 'in_call_recording')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(record.status_changes.some((s) => s.code === 'in_call_recording'), 'bot reached in_call_recording');

  // Drive the scripted meeting through the live bot instance.
  const page = manager.instances.get(bot.id).page;
  const schedule = await page.evaluate(() => window.startMeeting([
    { pid: 'p1', wavUrl: '/generated/p1.wav', startMs: 400 },
    { pid: 'p2', wavUrl: '/generated/p2.wav', afterPid: 'p1', gapMs: 700 },
  ]));
  const totalMs = Math.max(...schedule.map((s) => s.startMs + s.durationMs));
  await new Promise((r) => setTimeout(r, totalMs + 2000));

  const left = await (await api('POST', `/api/v1/bot/${bot.id}/leave_call`)).json();
  assert.ok(left.recording_id, 'recording id assigned');
  assert.ok(left.media_shortcuts.transcript, 'media shortcuts populated');

  const events = await (await api('GET', `/api/v1/bot/${bot.id}/participant_events`)).json();
  const types = new Set(events.map((e) => e.type));
  for (const t of ['join', 'speech_on', 'speech_off']) assert.ok(types.has(t), `event ${t} captured`);

  const meta = await (await api('GET', `/api/v1/bot/${bot.id}/meeting_metadata`)).json();
  assert.equal(meta.participants.length, 2);

  const transcript = await (await api('GET', `/api/v1/bot/${bot.id}/transcript`)).json();
  assert.ok(Array.isArray(transcript.segments));

  const audio = await api('GET', `/api/v1/bot/${bot.id}/audio`);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.ok((await audio.arrayBuffer()).byteLength > 100000, 'audio artifact has content');

  // Webhooks: ordered status sequence + recording.done, valid signatures.
  await dispatcher.drain();
  const parsed = hooks.map((h) => ({ ...JSON.parse(h.body), headers: h.headers }));
  const codes = parsed.filter((p) => p.event === 'bot.status_change').map((p) => p.data.status.code);
  for (const expected of ['ready', 'joining_call', 'in_call_recording', 'call_ended', 'done']) {
    assert.ok(codes.includes(expected), `webhook for status ${expected}`);
  }
  assert.ok(parsed.some((p) => p.event === 'recording.done' && p.data.recording_id === left.recording_id));

  const h = hooks[0];
  const key = Buffer.from(WEBHOOK_SECRET.slice(6), 'base64');
  const expectedSig = 'v1,' + crypto.createHmac('sha256', key)
    .update(`${h.headers['svix-id']}.${h.headers['svix-timestamp']}.${h.body}`).digest('base64');
  assert.equal(h.headers['svix-signature'], expectedSig, 'webhook HMAC verifies');
});
