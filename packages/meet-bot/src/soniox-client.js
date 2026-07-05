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
  }

  connect() {
    return new Promise((resolve, reject) => {
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
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (buf) => this._onMessage(buf));
    });
  }

  _onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.error_code) {
      const err = new Error(`Soniox ${msg.error_code}: ${msg.error_message}`);
      if (this._finished) this._finished.reject(err); else throw err;
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

  /** @param {Buffer} pcm s16le mono at configured sample rate */
  sendPcm(pcm) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }

  /** Signal end-of-audio, wait for remaining tokens, return all finals. */
  async finish() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return this.finalTokens;
    const done = new Promise((resolve, reject) => { this._finished = { resolve, reject }; });
    this.ws.send('');
    const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
    await Promise.race([done, timeout]);
    this.ws.close();
    return this.finalTokens;
  }
}
