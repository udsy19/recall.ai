/**
 * Page init script (runs before any meeting JS): hooks RTCPeerConnection so
 * every remote audio track is mixed through an AudioWorklet and shipped to
 * Node as 16 kHz s16le mono PCM via the __botPcmChunk binding.
 *
 * Exported as a string so Playwright can inject it with addInitScript.
 */
export const CAPTURE_INIT_SCRIPT = `(() => {
  if (window.__botCaptureInstalled) return;
  window.__botCaptureInstalled = true;
  window.__botTrackCount = 0;

  let ctx = null, mixBus = null, ready = null;

  function ensurePipeline() {
    if (ready) return ready;
    ready = (async () => {
      ctx = new AudioContext({ sampleRate: 48000 });
      const workletSrc =
        'class PCMTap extends AudioWorkletProcessor {' +
        '  process(inputs) {' +
        '    const ch = inputs[0] && inputs[0][0];' +
        '    if (ch && ch.length) this.port.postMessage(ch.slice(0));' +
        '    return true;' +
        '  }' +
        '}' +
        "registerProcessor('pcm-tap', PCMTap);";
      const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      mixBus = ctx.createGain();
      const tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
      mixBus.connect(tap);
      tap.port.onmessage = (e) => {
        const f = e.data; // Float32Array @48k
        // 48k -> 16k: average each group of 3 samples (crude anti-alias, fine for speech STT)
        const out = new Int16Array(Math.floor(f.length / 3));
        for (let i = 0; i < out.length; i++) {
          const v = (f[i * 3] + f[i * 3 + 1] + f[i * 3 + 2]) / 3;
          out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
        const bytes = new Uint8Array(out.buffer);
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        if (window.__botPcmChunk) window.__botPcmChunk(btoa(s));
      };
      if (ctx.state === 'suspended') await ctx.resume();
      return ctx;
    })();
    return ready;
  }

  async function attachAudioTrack(track, streams) {
    await ensurePipeline();
    const stream = (streams && streams[0]) || new MediaStream([track]);
    // Chromium quirk: remote WebRTC audio only flows into WebAudio while the
    // stream is also consumed by a media element.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    sink.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    src.connect(mixBus);
    window.__botTrackCount++;
  }

  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    const Hooked = function (...args) {
      const pc = new OrigPC(...args);
      pc.addEventListener('track', (ev) => {
        if (ev.track.kind === 'audio') attachAudioTrack(ev.track, ev.streams);
      });
      return pc;
    };
    Hooked.prototype = OrigPC.prototype;
    Object.setPrototypeOf(Hooked, OrigPC);
    window.RTCPeerConnection = Hooked;
  }

  // Fallback for pages that route audio via <audio>/<video> elements instead
  // of exposing tracks (some platform web clients). Enabled on demand.
  window.__botAttachMediaElements = async () => {
    await ensurePipeline();
    for (const el of document.querySelectorAll('audio, video')) {
      if (el.__botTapped || !(el.srcObject || el.src)) continue;
      el.__botTapped = true;
      try {
        const src = el.srcObject
          ? ctx.createMediaStreamSource(el.srcObject)
          : ctx.createMediaElementSource(el);
        src.connect(mixBus);
        if (!el.srcObject) src.connect(ctx.destination); // keep element audible
        window.__botTrackCount++;
      } catch (e) { /* element without audio */ }
    }
  };
})();`;
