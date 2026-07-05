import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildTranscript } from '@recall-clone/transcript-engine';
import { CAPTURE_INIT_SCRIPT } from './capture-inject.js';
import { makeScraperScript } from './event-scraper.js';
import { SonioxRealtime } from './soniox-client.js';
import { WavWriter } from './wav.js';

const CHROME_ARGS = [
  '--use-fake-device-for-media-capture',
  '--use-fake-ui-for-media-capture',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--lang=en-US',
];

/**
 * One bot = one browser = one recording. Drives: join → capture PCM +
 * scrape events → (Soniox realtime) → on leave, merge into a
 * speaker-attributed transcript and write artifacts.
 */
export class MeetingBot {
  /**
   * @param {{meetingUrl: string, botName?: string, adapter: object,
   *   artifactsDir: string, soniox?: {apiKey: string, url?: string},
   *   headless?: boolean, onEvent?: (e) => void, onStatus?: (s) => void}} opts
   */
  constructor(opts) {
    this.opts = { botName: 'Recall Clone Notetaker', headless: true, ...opts };
    this.status = 'ready';
    this.events = [];          // {type, participantId, name, tsMs, ...}
    this.roster = new Map();   // participantId -> {id, name, isHost}
    this.chat = [];
    this.meetingTitle = null;
    this._t0 = null;           // epoch ms of first PCM chunk (capture clock zero)
    this._pcmMs = 0;
    this._startedAt = null;
  }

  _setStatus(s) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  _now() {
    return this._t0 === null ? 0 : Date.now() - this._t0;
  }

  async run() {
    const { meetingUrl, adapter, artifactsDir } = this.opts;
    fs.mkdirSync(artifactsDir, { recursive: true });
    const wav = new WavWriter(path.join(artifactsDir, 'audio.wav'), 16000);

    let soniox = null;
    if (this.opts.soniox?.apiKey) {
      // Connects lazily on the first PCM chunk — Soniox 408s idle sessions,
      // and no audio flows while the bot waits for meeting admission.
      soniox = new SonioxRealtime({
        ...this.opts.soniox,
        diarization: true,
        contextTerms: this.opts.contextTerms,
        onError: (err) => console.error(`[soniox] ${err.message} — recording continues without STT`),
      });
    }
    this.soniox = soniox;

    // A persistent profile keeps cookies across runs — repeated cookie-less
    // anonymous joins trip Google's anti-abuse block page.
    let context;
    if (this.opts.profileDir) {
      context = await chromium.launchPersistentContext(this.opts.profileDir, {
        headless: this.opts.headless, args: CHROME_ARGS, permissions: ['microphone', 'camera'],
      });
      this.browser = context;
    } else {
      this.browser = await chromium.launch({ headless: this.opts.headless, args: CHROME_ARGS });
      context = await this.browser.newContext({ permissions: ['microphone', 'camera'] });
    }

    await context.exposeBinding('__botPcmChunk', (_src, b64) => {
      const pcm = Buffer.from(b64, 'base64');
      if (this._t0 === null) {
        this._t0 = Date.now();
        this._startedAt = new Date().toISOString();
      }
      this._pcmMs += (pcm.length / 2 / 16000) * 1000;
      wav.write(pcm);
      soniox?.sendPcm(pcm);
    });

    await context.exposeBinding('__botEvent', (_src, json) => {
      const e = JSON.parse(json);
      e.tsMs = this._now();
      if (e.type === 'title') { this.meetingTitle = e.text; return; }
      if (e.type === 'chat_message') { this.chat.push(e); }
      if (e.type === 'join' || e.type === 'update') {
        this.roster.set(e.participantId, { id: e.participantId, name: e.name, isHost: !!e.isHost });
      }
      this.events.push(e);
      this.opts.onEvent?.(e);
    });

    await context.addInitScript(CAPTURE_INIT_SCRIPT);

    const page = await context.newPage();
    this._setStatus('joining_call');
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });

    const outcome = await adapter.join(page, { botName: this.opts.botName });
    if (outcome !== 'in_call') {
      // Capture what the bot actually saw — join failures are usually an
      // unexpected page (block page, policy dialog, changed selectors).
      await page.screenshot({ path: path.join(this.opts.artifactsDir, 'join-failure.png') }).catch(() => {});
      const text = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
      fs.writeFileSync(path.join(this.opts.artifactsDir, 'join-failure.txt'), `${page.url()}\n\n${text}`);
      this._setStatus('fatal');
      await this.browser.close();
      throw new Error(`join failed: ${outcome}`);
    }
    await adapter.prepareInCall?.(page);
    this._setStatus('in_call_recording');
    await page.evaluate(makeScraperScript(adapter.selectors));
    this.page = page;
    this._wav = wav;
    return this;
  }

  /** Leave, flush STT, merge, write artifacts. Returns the transcript. */
  async stop() {
    this._setStatus('call_ended');
    await this.opts.adapter.leave?.(this.page).catch(() => {});
    await this.browser.close();
    this._wav.close();

    const captureEndMs = Math.max(this._pcmMs, this._now());
    const tokens = this.soniox ? await this.soniox.finish() : (this.injectedTokens ?? []);

    // Scraper events -> engine inputs
    const speakerEvents = this.events
      .filter((e) => e.type === 'speech_on' || e.type === 'speech_off')
      .map((e) => ({ tsMs: e.tsMs, participantId: e.participantId, type: e.type === 'speech_on' ? 'speech_start' : 'speech_stop' }));
    const roster = [...this.roster.values()];

    const { segments, attributionStats } = buildTranscript({
      tokens, events: speakerEvents, roster, captureEndMs,
    });

    const dir = this.opts.artifactsDir;
    const artifact = (name, data) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));

    artifact('transcript.json', {
      segments: segments.map((s) => ({
        participant: s.participant ? { id: s.participant.id, name: s.participant.name, is_host: s.participant.isHost ?? false } : null,
        speaker_name: s.speakerName,
        text: s.text,
        start_timestamp: { relative: s.startMs / 1000 },
        end_timestamp: { relative: s.endMs / 1000 },
        words: s.words.map((w) => ({
          text: w.text.trim(),
          start_timestamp: { relative: w.startMs / 1000 },
          end_timestamp: { relative: w.endMs / 1000 },
        })),
      })),
      attribution_stats: attributionStats,
    });
    artifact('participant_events.json', this.events);
    artifact('meeting_metadata.json', {
      title: this.meetingTitle,
      url: this.opts.meetingUrl,
      started_at: this._startedAt,
      duration_ms: Math.round(captureEndMs),
      participants: roster,
      chat_messages: this.chat.map(({ name, text, tsMs }) => ({ name, text, tsMs })),
    });
    this._setStatus('done');
    return { segments, attributionStats, events: this.events, roster };
  }
}
