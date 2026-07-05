#!/usr/bin/env node
/**
 * Run a bot against a real meeting:
 *   SONIOX_API_KEY=... node src/cli.js --url https://meet.google.com/xxx-xxxx-xxx \
 *     [--name "My Notetaker"] [--out ./artifacts] [--headful] [--max-minutes 60]
 * Stop with Ctrl-C (graceful: leaves the call, flushes STT, writes artifacts).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MeetingBot } from './bot.js';
import { meetAdapter } from './adapters/meet.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    name: { type: 'string', default: 'Recall Clone Notetaker' },
    out: { type: 'string', default: './artifacts' },
    headful: { type: 'boolean', default: false },
    'max-minutes': { type: 'string', default: '120' },
  },
});
if (!args.url) {
  console.error('usage: cli.js --url <meeting-url> [--name ...] [--out ...] [--headful]');
  process.exit(1);
}
if (!meetAdapter.matches(args.url)) {
  console.error('only Google Meet URLs are supported so far (meet.google.com/xxx-xxxx-xxx)');
  process.exit(1);
}
if (!process.env.SONIOX_API_KEY) {
  console.warn('⚠ SONIOX_API_KEY not set — recording audio + events only, no transcription');
}

const bot = new MeetingBot({
  meetingUrl: args.url,
  botName: args.name,
  adapter: meetAdapter,
  artifactsDir: path.resolve(args.out, `recording_${Date.now()}`),
  profileDir: path.resolve(args.out, '.chrome-profile'),
  headless: !args.headful,
  soniox: process.env.SONIOX_API_KEY ? { apiKey: process.env.SONIOX_API_KEY } : undefined,
  onStatus: (s) => console.log(`[status] ${s}`),
  onEvent: (e) => console.log(`[event ] ${Math.round(e.tsMs)}ms ${e.type} ${e.name ?? e.participantId ?? ''} ${e.text ?? ''}`),
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nleaving call, finalizing…');
  const { segments, attributionStats } = await bot.stop();
  console.log(`\n=== transcript (${segments.length} segments, attribution: ${JSON.stringify(attributionStats)}) ===`);
  for (const s of segments) {
    console.log(`[${(s.startMs / 1000).toFixed(1)}s] ${s.speakerName}: ${s.text}`);
  }
  console.log(`\nartifacts: ${bot.opts.artifactsDir}`);
  process.exit(0);
}
process.on('SIGINT', shutdown);
setTimeout(shutdown, Number(args['max-minutes']) * 60000);

try {
  await bot.run();
  console.log('bot is in the call — Ctrl-C to leave and finalize');
} catch (err) {
  console.error(`join failed: ${err.message}`);
  process.exit(1);
}
