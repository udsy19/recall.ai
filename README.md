# recall-clone

An open Recall.ai-style conversation-data platform: meeting bots, botless desktop recording, calendar sync, and mobile capture — all normalized into one API with speaker-attributed, word-timestamped transcripts (Soniox STT).

## Design docs

| Doc | Covers |
|---|---|
| [00 — Architecture](docs/00-architecture.md) | Unified data model, clock discipline, API surface, scaling |
| [01 — Meeting Bot API](docs/01-meeting-bot-api.md) | Browser bots vs native SDK bots, WebRTC audio capture, DOM scraping, per-participant audio |
| [02 — Desktop Recording SDK](docs/02-desktop-recording-sdk.md) | ScreenCaptureKit / CoreAudio process taps, me/them channels, meeting detection |
| [03 — Calendar API](docs/03-calendar-api.md) | Google/Graph sync, link parsing, auto-record rules, email enrichment |
| [04 — Mobile Recording SDK](docs/04-mobile-recording-sdk.md) | iOS/Android constraints, in-person capture, telephony-side recording |
| [05 — Transcription (Soniox)](docs/05-transcription-soniox.md) | Realtime WS integration, diarization + UI-event fusion attribution |

## Packages

- `packages/transcript-engine` — ✅ who-said-what-when merge engine (tokens × speaker events × roster), tested
- `packages/meet-bot` — ✅ Google Meet browser bot (Playwright): join, WebRTC audio capture, participant events, Soniox realtime; e2e-tested against a fake-meeting harness with real STT
- `packages/server` — ✅ Recall-compatible REST API (`POST /api/v1/bot`, artifacts, Svix-signed webhooks), integration-tested
- `packages/calendar-sync` — ✅ meeting-link parser (Zoom/Meet/Teams/Webex canonical dedup keys); sync engine per docs/03 (WIP)
- `packages/desktop-sdk`, `packages/mobile-sdk` — per design docs (WIP)

## Develop

```bash
npm install && npx playwright install chromium
npm test                      # all workspace tests (uses macOS `say` + ffmpeg for the e2e harness)

# run the API server (.env: SONIOX_API_KEY, API_TOKEN, WEBHOOK_URL)
node packages/server/src/index.js
curl -X POST localhost:3000/api/v1/bot -H 'Authorization: Token dev' \
  -d '{"meeting_url": "https://meet.google.com/xxx-xxxx-xxx", "bot_name": "My Notetaker"}'

# or drive a bot directly from the CLI
SONIOX_API_KEY=... node packages/meet-bot/src/cli.js --url https://meet.google.com/xxx-xxxx-xxx --headful
```
