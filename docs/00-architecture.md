# Platform Architecture — Building a Recall.ai-Class Conversation-Data Platform

**Goal:** one API that captures audio, video, transcripts, and rich metadata from conversations regardless of where they happen — video meetings (bot or botless), phone calls, or in-person — and exposes them through a single, uniform data model.

```
                            ┌─────────────────────────────────────────────┐
   CAPTURE SOURCES          │                CORE PLATFORM                │         CONSUMERS
                            │                                             │
 ┌──────────────────┐       │  ┌───────────┐   ┌──────────────────────┐   │   ┌──────────────────┐
 │ Meeting Bot      │──────▶│  │ Ingestion │──▶│ Recording Store      │   │──▶│ REST API         │
 │ (Meet/Zoom/Teams)│  WS   │  │ Gateway   │   │ (S3 + Postgres)      │   │   │ GET /recordings  │
 └──────────────────┘       │  └───────────┘   └──────────────────────┘   │   └──────────────────┘
 ┌──────────────────┐       │        │         ┌──────────────────────┐   │   ┌──────────────────┐
 │ Desktop SDK      │──────▶│        ├────────▶│ Transcript Engine    │   │──▶│ Webhooks (Svix-  │
 │ (macOS/Windows)  │       │        │         │ (Soniox + attribution)│  │   │  style delivery) │
 └──────────────────┘       │        │         └──────────────────────┘   │   └──────────────────┘
 ┌──────────────────┐       │        │         ┌──────────────────────┐   │   ┌──────────────────┐
 │ Mobile SDK       │──────▶│        └────────▶│ Event Timeline Store │   │──▶│ Real-time WS     │
 │ (iOS/Android)    │       │                  │ (participant events) │   │   │ (transcript.data)│
 └──────────────────┘       │                  └──────────────────────┘   │   └──────────────────┘
 ┌──────────────────┐       │  ┌─────────────────────────────────────┐    │
 │ Calendar Sync    │──────▶│  │ Bot Scheduler (calendar → bot jobs) │    │
 │ (Google/MS Graph)│       │  └─────────────────────────────────────┘    │
 └──────────────────┘       └─────────────────────────────────────────────┘
```

## The unifying insight

Every capture source, no matter how different its mechanics, is normalized into the **same three time-aligned streams** on a shared clock (t=0 = recording start):

1. **Media** — mixed audio (16 kHz mono PCM canonical), optional per-participant audio, optional video (mixed and/or per-participant).
2. **STT tokens** — words with `start_ms`/`end_ms`/`confidence`, optionally a diarization `speaker` label (we use Soniox `stt-rt-v5`, which emits exactly this).
3. **Event timeline** — participant roster + timestamped events: `join`, `leave`, `speech_on`, `speech_off`, `webcam_on/off`, `screenshare_on/off`, `chat_message`, `mute/unmute`, host changes.

The **transcript engine** (`packages/transcript-engine`) merges streams 2 + 3 into speaker-attributed utterances. Because the merge is source-agnostic, a Meet bot, a desktop recorder, and a phone call all produce identical transcript JSON — this is what makes "one API for all conversation data" possible.

## Core data model (mirrors Recall.ai's, verified against their docs)

```jsonc
// Recording — the top-level artifact, regardless of source
{
  "id": "uuid",
  "source": { "type": "meeting_bot" | "desktop_sdk" | "mobile_sdk", "platform": "google_meet" | "zoom" | "teams" | "webex" | "phone" | "in_person" },
  "started_at": "ISO8601", "completed_at": "ISO8601",
  "status": "recording" | "processing" | "done" | "failed",
  "media_shortcuts": {
    "video_mixed": { "url": "..." },
    "audio_mixed": { "url": "..." },
    "transcript":  { "url": "...", "provider": "soniox" },
    "participant_events": { "url": "..." },
    "meeting_metadata": { "title": "...", "calendar_event_id": "..." }
  },
  "metadata": { /* customer-supplied */ }
}

// Participant — one identity per person in the conversation
{
  "id": 100, "name": "Alice Chen", "is_host": true,
  "platform": "google_meet", "email": "alice@acme.com",  // email via calendar enrichment
  "extra_data": { "platform_user_id": "..." }
}

// Transcript segment (our engine's output; word-level under the hood)
{
  "participant": { "id": 100, "name": "Alice Chen" },
  "words": [ { "text": "hello", "start_timestamp": {"relative": 12.41}, "end_timestamp": {"relative": 12.79} } ],
  "text": "hello everyone", "start_ms": 12410, "end_ms": 13800,
  "attribution": "ui_exclusive" | "diarization_map" | "ui_best_overlap" | "unattributed"
}

// Participant event (timeline entry)
{
  "type": "participant_events.speech_on",
  "participant": { "id": 100, "name": "Alice Chen", "is_host": true },
  "timestamp": { "absolute": "2026-07-05T19:00:12.410Z", "relative": 12.41 }
}
```

Recall.ai's real-time payloads use this exact participant shape (`id`, `name`, `is_host`, `platform`, `extra_data`, `email`) and dual `absolute`/`relative` timestamps — we match it for drop-in compatibility.

## API surface (v1)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/bot` | Send a bot to a meeting (`meeting_url`, `bot_name`, `join_at`, `recording_config`, `automatic_leave`, `chat`, `metadata`) |
| `GET /api/v1/bot/{id}` | Bot state + status_changes + recording pointers |
| `POST /api/v1/bot/{id}/leave_call` | Remove bot |
| `GET /api/v1/recording/{id}` | Recording + media_shortcuts |
| `GET /api/v1/transcript/{id}` | Speaker-attributed transcript JSON |
| `POST /api/v1/calendars` / `GET /api/v1/calendar-events` | Calendar API (see doc 03) |
| `POST /api/v1/sdk-upload` | Desktop/Mobile SDK ingestion handshake |

**Bot status lifecycle** (matches Recall): `ready` → `joining_call` → `in_waiting_room` → `in_call_not_recording` → `in_call_recording` → `call_ended` → `done`, with `fatal` as terminal error. Every transition emits a `bot.status_change` webhook.

**Real-time delivery** — customers register `realtime_endpoints` on bot creation:
- WebSocket push of `transcript.data` / `transcript.partial_data` (Soniox non-final tokens map to partials — sub-second latency).
- `audio_mixed_raw.data`: base64 16 kHz mono PCM frames; `audio_separate_raw.data` per participant where the platform provides it.
- All `participant_events.*` live.

**Webhooks** — HMAC-signed (Svix-compatible headers: `svix-id`, `svix-timestamp`, `svix-signature`), with retry/backoff and an event log for replay.

## Repo layout

```
packages/
  server/             REST API + webhook dispatcher + orchestrator (Node/Express, SQLite→Postgres)
  meet-bot/           Google Meet bot: Playwright joiner, WebRTC audio capture, DOM event scraper
  transcript-engine/  ✅ built & tested — token/event/roster merge → who-said-what-when
  calendar-sync/      Google Calendar + MS Graph sync, link parsing, auto-record rules
  desktop-sdk/        macOS Swift core (ScreenCaptureKit + CoreAudio taps) + uploader
  mobile-sdk/         iOS/Android in-person + VoIP capture
docs/                 these design docs
```

## Clock discipline (the thing that makes or breaks metadata quality)

All three streams must share one clock. Rules:

1. **t=0 is defined by the capture process** the instant the first audio sample is captured, recorded as an absolute epoch (`started_at`). Every event gets `relative = (event_wall_time - started_at)`.
2. **STT timestamps are audio-sample-derived** (Soniox `start_ms` counts audio milliseconds sent), so if capture pauses, we track cumulative-samples-sent to convert Soniox time → capture time. Never use wall clock for STT alignment.
3. **UI-scraped events lag real audio by 200–800 ms** (speaking indicators animate late). The attribution engine pads intervals ±700 ms and prefers diarization labels in contested windows — measured, not assumed (see doc 01 §Testing).

## Scaling model (what Recall does, per their engineering blog)

- **One bot = one isolated container** (Chromium + capture pipeline), scheduled on Kubernetes; a warm pool of pre-booted browsers cuts join latency from ~30 s to ~2 s.
- Bots are CPU-bound on video encode; audio-only bots are ~10× cheaper. Recall famously runs thousands of concurrent bots and optimized WebSocket payload copies at the kernel level (their "million dollar TCP_NODELAY" / zero-copy posts).
- Media flows bot → ingestion gateway over WebSocket (PCM + events), object storage for artifacts, Postgres for metadata, Redis for scheduler state.
- **v0 (this repo):** single-host — bot as a local process, SQLite, filesystem artifacts. Same interfaces, so the K8s move is a deployment change, not a rewrite.

## Where each product doc picks up

- **[01 — Meeting Bot API](01-meeting-bot-api.md):** platform-by-platform join + capture + scraping mechanics; per-participant audio; scaling.
- **[02 — Desktop Recording SDK](02-desktop-recording-sdk.md):** botless capture via OS APIs; me/them channel separation; meeting detection.
- **[03 — Calendar API](03-calendar-api.md):** OAuth, sync, meeting-link parsing, auto-record rules, attendee-email enrichment.
- **[04 — Mobile Recording SDK](04-mobile-recording-sdk.md):** what iOS/Android actually allow; telephony-side recording; in-person capture.
- **[05 — Transcription (Soniox)](05-transcription-soniox.md):** exact Soniox integration, diarization, and the attribution algorithm.
