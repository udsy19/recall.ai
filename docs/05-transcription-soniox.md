# Transcription & Speaker Attribution — Soniox Integration

How raw meeting audio becomes a **speaker-attributed, word-timestamped transcript**. This is the layer where "more metadata than Recall" is won: we fuse STT-side diarization with platform-side participant signals instead of relying on either alone.

## 1. Soniox real-time API (verified against current docs)

- **Endpoint:** `wss://stt-rt.soniox.com/transcribe-websocket`
- **Handshake:** first message is JSON config; then binary audio frames; end with an empty frame.

```jsonc
// config we send per stream
{
  "api_key": "<SONIOX_API_KEY>",
  "model": "stt-rt-v5",
  "audio_format": "pcm_s16le", "sample_rate": 16000, "num_channels": 1,
  "enable_speaker_diarization": true,       // token-level "speaker": "1" | "2" | ...
  "enable_language_identification": true,
  "enable_endpoint_detection": true,        // finalizes tokens at pauses → low latency
  "max_endpoint_delay_ms": 2000,
  "language_hints": ["en"],
  "context": { "terms": ["<attendee names from calendar>", "<company terms>"] },
  "client_reference_id": "recording_<uuid>"
}
```

```jsonc
// responses: tokens accumulate; non-final tokens are revised until finalized
{ "tokens": [ { "text": " hello", "start_ms": 12410, "end_ms": 12790,
                "confidence": 0.97, "is_final": true, "speaker": "1", "language": "en" } ],
  "final_audio_proc_ms": 13000, "total_audio_proc_ms": 14500 }
// control: {"type":"finalize"} forces pending tokens final; {"finished":true} closes
// errors: {"error_code": 429, "error_message": ...} — reconnect with backoff, resume from buffer
```

Limits that shape the design: **300 min max per stream** (rotate streams on long meetings: overlap 5 s, splice on token timestamps), context ≤ 10k chars, 402 = credits exhausted (surface as platform alert, buffer audio for async retry). Async/batch API (`api.soniox.com`) uses the same token schema — used for desktop/mobile offline uploads and re-transcription.

**Calendar-boosted accuracy:** attendee names + company terms from the Calendar API go into `context.terms` per meeting — proper nouns are where meeting STT visibly fails, and this is nearly free.

## 2. Stream topology per source

| Source | Streams sent to Soniox | Attribution quality |
|---|---|---|
| Meet browser bot | 1 mixed stream (+ optional per-active-speaker taps) | UI events + diarization fusion |
| Zoom SDK bot | 1 stream **per participant** (diarization off — identity is known) | Perfect |
| Desktop SDK | 2 streams: mic ("me", diarization off) + app audio ("them", diarization on) | Me = perfect; them = diarization + AX names |
| Mobile in-person | 1 mixed (diarization on) | Diarization + owner enrollment |
| Telephony | 1 per call leg (diarization off) | Perfect |

Per-participant streams cost more Soniox-hours but eliminate attribution error — configurable per bot (`transcription.per_participant: true`), mirroring how Recall prices per-participant audio as premium.

## 3. The attribution algorithm (`packages/transcript-engine`, built & tested)

Inputs on one capture clock: **final tokens** (`start_ms/end_ms/speaker`), **speaker events** (`speech_on/off` per participant from DOM/getStats/AX/SDK), **roster**.

1. `eventsToIntervals` — collapse on/off events into per-participant speech intervals (dangling starts close at capture end; stray stops dropped).
2. `attributeTokens`, pass 1 — pad intervals ±700 ms (UI indicators lag audio); a token overlapping **exactly one** participant's padded interval is attributed `ui_exclusive`, and casts a duration-weighted vote binding its diarization label → that participant.
3. Label map — a diarization label maps to a participant only with ≥60% of vote weight (cross-talk noise can't poison it).
4. Pass 2 — contested/orphan tokens: label map first (`diarization_map`), else best overlap (`ui_best_overlap`), else `unattributed` (never guessed).
5. `buildSegments` — consecutive same-speaker tokens merge into utterances, splitting at >2 s gaps; each word keeps its own timestamps.

Why fusion beats either signal alone: UI events know **who** (real names, real identities) but lag and miss cross-talk; diarization knows **when** (audio-precise boundaries) but only cluster ids. Pass 1 uses clean turn-taking to *learn the join* between them; pass 2 spends that map exactly where the UI signal is weak. Every word records its attribution method, so accuracy is measurable per recording (`attributionStats`) — a metadata field Recall doesn't expose.

**Test status:** 6/6 unit tests green — clean turn-taking, cross-talk word-level accuracy, UI-miss fallback, 600 ms indicator lag, dangling events, segment splitting. Next: fake-meeting harness feeds real TTS audio through real Soniox for end-to-end accuracy scoring (doc 01 §5).

## 4. Realtime fan-out

Bot/SDK PCM → ingestion gateway → one Soniox WS per stream. Soniox non-final tokens → `transcript.partial_data` to customer realtime endpoints immediately (typical <1 s behind speech); finalized tokens → attribution (incremental — intervals and label map update as events arrive) → `transcript.data` with the full Recall-shaped payload:

```jsonc
{ "event": "transcript.data",
  "data": { "data": {
      "words": [{ "text": "hello", "start_timestamp": {"relative": 12.41}, "end_timestamp": {"relative": 12.79} }],
      "participant": { "id": 100, "name": "Alice Chen", "is_host": true, "platform": "google_meet", "email": "alice@acme.com", "extra_data": {} },
      "language_code": "en" },
    "recording": {"id": "..."}, "bot": {"id": "..."} } }
```

Post-meeting, the final transcript is re-built from the complete event set (attribution improves with full context vs. incremental) — stored as the canonical artifact; the realtime feed is never silently different in schema, only potentially in attribution confidence.

## 5. Cost & operational notes
Realtime billed per audio-hour per stream — mixed-stream mode keeps cost flat regardless of participant count; per-participant mode scales linearly (price it accordingly). Reconnect strategy: 3 s audio ring buffer upstream of the WS; on drop, reconnect and replay buffer (tokens are idempotent by `start_ms` — dedupe on splice). Monitor `total_audio_proc_ms - final_audio_proc_ms` as a lag gauge; sustained growth ⇒ finalize-nudge (`{"type":"finalize"}`) or stream rotation.
