import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MeetingBot } from '@recall-clone/meet-bot/src/bot.js';
import { meetAdapter } from '@recall-clone/meet-bot/src/adapters/meet.js';

/**
 * Owns bot records + running MeetingBot instances. Bot records follow
 * Recall's shape: id, meeting_url, bot_name, status_changes[], metadata,
 * recording pointers. Emits bot.status_change / recording.done webhooks.
 */
export class BotManager {
  /**
   * @param {{artifactsRoot: string, dispatcher: import('./webhooks.js').WebhookDispatcher,
   *   soniox?: {apiKey: string}, adapters?: object[], headless?: boolean}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.bots = new Map();       // id -> record
    this.instances = new Map();  // id -> MeetingBot
    this.adapters = opts.adapters ?? [meetAdapter];
  }

  adapterFor(url) {
    return this.adapters.find((a) => a.matches(url)) ?? null;
  }

  list() { return [...this.bots.values()]; }
  get(id) { return this.bots.get(id) ?? null; }

  _setStatus(record, code, subCode = null) {
    record.status_changes.push({
      code, sub_code: subCode, created_at: new Date().toISOString(),
    });
    this.opts.dispatcher.send('bot.status_change', {
      bot_id: record.id, status: { code, sub_code: subCode }, metadata: record.metadata,
    });
  }

  /** POST /api/v1/bot */
  create(body) {
    const { meeting_url, bot_name = 'Recall Clone Notetaker', metadata = {} } = body;
    if (!meeting_url) throw Object.assign(new Error('meeting_url required'), { statusCode: 400 });
    const adapter = this.adapterFor(meeting_url);
    if (!adapter) throw Object.assign(new Error('unsupported meeting platform'), { statusCode: 400 });

    const id = crypto.randomUUID();
    const record = {
      id, meeting_url, bot_name, metadata,
      status_changes: [],
      recording_id: null,
      media_shortcuts: null,
    };
    this.bots.set(id, record);
    this._setStatus(record, 'ready');
    this._run(record, adapter).catch((err) => {
      if (!record.status_changes.some((s) => s.code === 'fatal')) {
        this._setStatus(record, 'fatal', err.message);
      }
    });
    return record;
  }

  async _run(record, adapter) {
    const artifactsDir = path.join(this.opts.artifactsRoot, record.id);
    const bot = new MeetingBot({
      meetingUrl: record.meeting_url,
      botName: record.bot_name,
      adapter,
      artifactsDir,
      headless: this.opts.headless ?? true,
      soniox: this.opts.soniox,
      onStatus: (s) => {
        // MeetingBot statuses map 1:1 onto Recall codes; 'ready' already emitted.
        if (s !== 'ready') this._setStatus(record, s);
      },
    });
    this.instances.set(record.id, bot);
    await bot.run();
  }

  /** POST /api/v1/bot/{id}/leave_call — finalizes recording + artifacts. */
  async leave(id) {
    const record = this.get(id);
    const bot = this.instances.get(id);
    if (!record || !bot) throw Object.assign(new Error('bot not found'), { statusCode: 404 });
    if (record.media_shortcuts) return record; // already finalized
    await bot.stop();
    this.instances.delete(id);

    const dir = path.join(this.opts.artifactsRoot, record.id);
    record.recording_id = crypto.randomUUID();
    record.media_shortcuts = {
      audio_mixed: { path: path.join(dir, 'audio.wav') },
      transcript: { path: path.join(dir, 'transcript.json'), provider: this.opts.soniox ? 'soniox' : 'none' },
      participant_events: { path: path.join(dir, 'participant_events.json') },
      meeting_metadata: { path: path.join(dir, 'meeting_metadata.json') },
    };
    this.opts.dispatcher.send('recording.done', {
      bot_id: record.id, recording_id: record.recording_id, metadata: record.metadata,
    });
    return record;
  }

  artifact(id, name) {
    const record = this.get(id);
    const p = record?.media_shortcuts?.[name]?.path;
    if (!p || !fs.existsSync(p)) return null;
    return p;
  }

  /** Graceful shutdown: leave all calls. */
  async stopAll() {
    for (const id of [...this.instances.keys()]) {
      await this.leave(id).catch(() => {});
    }
  }
}
