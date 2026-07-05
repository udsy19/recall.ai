/**
 * End-to-end pipeline test against the fake-meeting harness:
 * real Chromium, real WebRTC, real TTS audio (macOS `say`), Meet-like DOM.
 *
 * Verifies: WebRTC audio capture (non-silent WAV of correct duration),
 * participant events (join/speech on-off matching the schedule), and the full
 * attribution pipeline. With SONIOX_API_KEY set, tokens come from real Soniox;
 * otherwise synthetic tokens derived from the observed speech windows exercise
 * the same code path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeetingBot } from '../src/bot.js';
import { harnessAdapter } from './harness/adapter.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(DIR, 'harness', 'generated');
const ARTIFACTS = path.join(GEN, 'artifacts');

const SPEAKERS = [
  { pid: 'p1', name: 'Alice Chen', voice: 'Samantha', text: 'Hello everyone welcome to the quarterly review meeting' },
  { pid: 'p2', name: 'Bob Marley', voice: 'Daniel', text: 'Thanks Alice the sales pipeline looks strong this quarter' },
];

const hasTts = (() => { try { execSync('which say ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; } })();

let server, baseUrl;

before(async () => {
  if (!hasTts) return;
  fs.mkdirSync(GEN, { recursive: true });
  for (const s of SPEAKERS) {
    const aiff = path.join(GEN, `${s.pid}.aiff`), wav = path.join(GEN, `${s.pid}.wav`);
    execSync(`say -v ${s.voice} -o ${JSON.stringify(aiff)} ${JSON.stringify(s.text)}`);
    execSync(`ffmpeg -y -loglevel error -i ${JSON.stringify(aiff)} -ar 48000 -ac 1 ${JSON.stringify(wav)}`);
  }
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'meeting.html';
    const file = path.join(DIR, 'harness', rel);
    if (!file.startsWith(path.join(DIR, 'harness')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'audio/wav' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

/** Spread a script's words across an observed speech window as STT-like tokens. */
function syntheticTokens(text, startMs, endMs, speaker) {
  const words = text.split(' ');
  const step = (endMs - startMs) / words.length;
  return words.map((w, i) => ({
    text: (i === 0 ? '' : ' ') + w,
    startMs: Math.round(startMs + i * step),
    endMs: Math.round(startMs + (i + 1) * step),
    speaker,
    confidence: 1,
  }));
}

test('full pipeline: capture, events, attribution, artifacts', { skip: !hasTts, timeout: 180000 }, async () => {
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  const statuses = [];
  const useSoniox = !!process.env.SONIOX_API_KEY;
  const bot = new MeetingBot({
    meetingUrl: `${baseUrl}/meeting.html`,
    botName: 'Test Bot',
    adapter: harnessAdapter,
    artifactsDir: ARTIFACTS,
    soniox: useSoniox ? { apiKey: process.env.SONIOX_API_KEY } : undefined,
    onStatus: (s) => statuses.push(s),
  });
  await bot.run();

  // Scripted meeting: Alice at 500ms, Bob 800ms after Alice ends.
  const schedule = await bot.page.evaluate(() => window.startMeeting([
    { pid: 'p1', wavUrl: '/generated/p1.wav', startMs: 500 },
    { pid: 'p2', wavUrl: '/generated/p2.wav', afterPid: 'p1', gapMs: 800 },
  ]));
  const totalMs = Math.max(...schedule.map((s) => s.startMs + s.durationMs));
  await new Promise((r) => setTimeout(r, totalMs + 2500));

  // --- events captured while live ---
  const joins = bot.events.filter((e) => e.type === 'join').map((e) => e.participantId).sort();
  assert.deepEqual(joins, ['p1', 'p2'], 'both participants joined via roster scrape');
  assert.equal(bot.roster.get('p1').name, 'Alice Chen');
  assert.equal(bot.roster.get('p1').isHost, true, 'host marker parsed');
  assert.equal(bot.roster.get('p2').name, 'Bob Marley');

  for (const s of schedule) {
    const on = bot.events.find((e) => e.type === 'speech_on' && e.participantId === s.pid);
    const off = bot.events.find((e) => e.type === 'speech_off' && e.participantId === s.pid);
    assert.ok(on && off, `speech on/off observed for ${s.pid}`);
    const observed = off.tsMs - on.tsMs;
    assert.ok(Math.abs(observed - s.durationMs) < 1500,
      `${s.pid} speech window ${observed}ms ~ scheduled ${s.durationMs}ms`);
  }

  // Without a Soniox key, feed synthetic tokens through the same merge path.
  if (!useSoniox) {
    bot.injectedTokens = schedule.flatMap((s, i) => {
      const on = bot.events.find((e) => e.type === 'speech_on' && e.participantId === s.pid);
      const off = bot.events.find((e) => e.type === 'speech_off' && e.participantId === s.pid);
      return syntheticTokens(SPEAKERS[i].text, on.tsMs, off.tsMs, String(i + 1));
    });
  }

  const { segments, attributionStats } = await bot.stop();
  assert.deepEqual(statuses, ['joining_call', 'in_call_recording', 'call_ended', 'done']);

  // --- attribution ---
  assert.ok(segments.length >= 2, `got ${segments.length} segments`);
  const aliceText = segments.filter((s) => s.speakerName === 'Alice Chen').map((s) => s.text).join(' ').toLowerCase();
  const bobText = segments.filter((s) => s.speakerName === 'Bob Marley').map((s) => s.text).join(' ').toLowerCase();
  if (useSoniox) {
    assert.match(aliceText, /welcome|quarterly|review/, 'Alice words attributed to Alice');
    assert.match(bobText, /pipeline|quarter|thanks/, 'Bob words attributed to Bob');
  } else {
    assert.match(aliceText, /hello everyone welcome to the quarterly review meeting/);
    assert.match(bobText, /thanks alice the sales pipeline looks strong this quarter/);
  }
  assert.ok(!attributionStats.unattributed, 'no unattributed words');

  // --- artifacts ---
  const wavPath = path.join(ARTIFACTS, 'audio.wav');
  const wavBytes = fs.statSync(wavPath).size;
  const wavMs = ((wavBytes - 44) / 2 / 16000) * 1000;
  assert.ok(wavMs > totalMs - 1000, `captured ${Math.round(wavMs)}ms audio for ~${Math.round(totalMs)}ms meeting`);
  const probe = execSync(`ffmpeg -i ${JSON.stringify(wavPath)} -af astats=metadata=1 -f null - 2>&1 | grep -m1 "RMS level"`).toString();
  const rms = parseFloat(probe.split(':').pop());
  assert.ok(rms > -50, `WAV is not silent (RMS ${rms} dB)`);

  for (const f of ['transcript.json', 'participant_events.json', 'meeting_metadata.json']) {
    assert.ok(fs.existsSync(path.join(ARTIFACTS, f)), `${f} written`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'meeting_metadata.json')));
  assert.equal(meta.participants.length, 2);
  assert.match(meta.title ?? '', /Weekly Sync/);
});
