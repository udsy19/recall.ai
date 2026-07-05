import WebSocket from 'ws';

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

/**
 * Minimal Soniox realtime client. Feed it s16le PCM, get tokens back.
 * Final tokens accumulate in `finalTokens` (transcript-engine format:
 * {text, startMs, endMs, speaker?, confidence}).
 */
export class SonioxRealtime {
  /**
   * @param {{apiKey: string, model?: string, sampleRate?: number,
   *   diarization?: boolean, languageHints?: string[], contextTerms?: string[],
   *   onTokens?: (finals: object[], nonFinals: object[]) => void,
   *   url?: string}} opts   `url` overridable for tests
   */
  constructor(opts) {
    this.opts = opts;
    this.finalTokens = [];
    this.ws = null;
    this._finished = null;
    this.dead = false;
    this._buffer = [];        // PCM queued before the socket opens
    this._bufferBytes = 0;
    this._connecting = null;
  }

  /** Idempotent; call as late as possible — Soniox 408s if audio doesn't
   *  arrive shortly after config, so don't connect while e.g. waiting for
   *  meeting admission. sendPcm() buffers until the socket opens. */
  connect() {
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url ?? SONIOX_WS_URL);
      this.ws = ws;
      ws.once('open', () => {
        ws.send(JSON.stringify({
          api_key: this.opts.apiKey,
          model: this.opts.model ?? 'stt-rt-v5',
          audio_format: 'pcm_s16le',
          sample_rate: this.opts.sampleRate ?? 16000,
          num_channels: 1,
          enable_speaker_diarization: this.opts.diarization ?? true,
          enable_endpoint_detection: true,
          language_hints: this.opts.languageHints ?? ['en'],
          ...(this.opts.contextTerms?.length ? { context: { terms: this.opts.contextTerms } } : {}),
        }));
        for (const pcm of this._buffer) ws.send(pcm);
        this._buffer = [];
        this._bufferBytes = 0;
        resolve();
      });
      ws.once('error', (err) => { this._fail(err); reject(err); });
      ws.on('message', (buf) => this._onMessage(buf));
    });
    return this._connecting;
  }

  _fail(err) {
    this.dead = true;
    this._buffer = [];
    this.opts.onError?.(err);
    this._finished?.resolve(); // finish() returns whatever finals we have
  }

  _onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.error_code) {
      this._fail(new Error(`Soniox ${msg.error_code}: ${msg.error_message}`));
      return;
    }
    const finals = [], nonFinals = [];
    for (const t of msg.tokens ?? []) {
      if (t.text === '<end>' || t.text === '<fin>') continue; // endpoint/finalize control tokens, not words

      const tok = {
        text: t.text,
        startMs: t.start_ms,
        endMs: t.end_ms,
        speaker: t.speaker,
        confidence: t.confidence,
      };
      (t.is_final ? finals : nonFinals).push(tok);
    }
    this.finalTokens.push(...finals);
    this.opts.onTokens?.(finals, nonFinals);
    if (msg.finished && this._finished) this._finished.resolve();
  }

  /** @param {Buffer} pcm s16le mono at configured sample rate.
   *  Triggers connect() on first audio; buffers (up to 2 min) until open. */
  sendPcm(pcm) {
    if (this.dead) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      return;
    }
    this.connect().catch(() => {});
    if (this._bufferBytes < 2 * 60 * 16000 * 2) {
      this._buffer.push(pcm);
      this._bufferBytes += pcm.length;
    }
  }

  /** Signal end-of-audio, wait for remaining tokens, return all finals. */
  async finish() {
    if (this.dead || !this.ws || this.ws.readyState !== WebSocket.OPEN) return this.finalTokens;
    const done = new Promise((resolve, reject) => { this._finished = { resolve, reject }; });
    this.ws.send('');
    const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
    await Promise.race([done, timeout]);
    this.ws.close();
    return this.finalTokens;
  }
}
