# Meeting Bot API — Design

Bots that join video calls as a visible participant and capture **audio, video, transcripts, chat, and participant metadata**. This is the least-restricted capture path and the only one that lets an AI agent participate in a meeting.

## 1. The two fundamentally different bot architectures

### A. Browser bot (Google Meet, Teams web, Webex web, Zoom web fallback)
A real Chromium instance, driven by Playwright, joins through the platform's **web guest flow** exactly like a human. Everything the platform renders — remote audio, video tiles, roster, speaking indicators, chat — is available inside the page.

**Why this wins:** no platform SDK approval, no OAuth, works the moment you have a meeting URL. **Cost:** metadata comes from DOM scraping (selector maintenance) and audio is a single mixed stream (diarization needed — solved in doc 05).

### B. Native SDK bot (Zoom Linux SDK, Teams Graph media bots)
- **Zoom Meeting SDK (Linux, headless):** after Zoom app review + "raw data" enablement, the SDK delivers **per-participant raw audio streams** (`onOneWayAudioRawDataReceived`, one 32 kHz PCM stream per attendee with their Zoom user id), raw video per participant, and structured events (join/leave/mute/active-speaker) as callbacks. Perfect speaker attribution with zero diarization. Requires the host to grant local-recording permission, and Zoom shows a recording-consent banner.
- **Microsoft Graph communications bots (application-hosted media):** an Azure-registered bot joins Teams calls natively; the Real-time Media Platform delivers unmixed audio per participant + `dominantSpeakerChanged` events. Heavy: tenant admin consent, Windows-hosted media stack, certification for some scenarios. Ship the Teams *web* browser bot first; Graph bot is the enterprise upgrade path.

**Build order:** Meet browser bot (v0, this repo) → Zoom web bot → Zoom Linux SDK bot → Teams web bot → Teams Graph bot → Webex.

## 2. Browser bot mechanics (Google Meet reference implementation)

### 2.1 Joining
1. Launch Chromium with:
   ```
   --use-fake-device-for-media-capture      # synthetic mic/cam (bot sends silence/static)
   --use-fake-ui-for-media-capture          # auto-accept device permission prompts
   --autoplay-policy=no-user-gesture-required
   --disable-blink-features=AutomationControlled   # reduce bot fingerprint
   --lang=en-US                             # stable selectors/aria labels
   ```
2. Navigate to `https://meet.google.com/xxx-xxxx-xxx`. Unauthenticated guest flow: fill the "Your name" input with `bot_name`, click **Ask to join**.
3. Three outcomes → bot statuses: admitted (`in_call_not_recording`), waiting (`in_waiting_room`, poll for admission until `automatic_leave.waiting_room_timeout`), denied/ended (`fatal` with sub_code).
4. On admission: mute mic, turn camera off (or render `automatic_video_output` image to the fake cam), open the People panel once to force-mount roster DOM.

Signed-in bot accounts (Google Workspace identity) reduce "ask to join" friction for org-internal meetings — optional config, not required for v0.

### 2.2 Audio capture — hook WebRTC, not the speaker
The naive path (virtual audio device + ffmpeg) needs PulseAudio/X11 plumbing and gives you one blended stream at the OS layer. The better path used by modern bots: **hook `RTCPeerConnection` inside the page** before Meet's JS loads (`page.addInitScript`):

```js
const pcs = new Set();
const OrigPC = window.RTCPeerConnection;
window.RTCPeerConnection = function (...args) {
  const pc = new OrigPC(...args);
  pcs.add(pc);
  pc.addEventListener('track', (e) => {
    if (e.track.kind === 'audio') __botOnRemoteAudioTrack(e.track, e.streams);
  });
  return pc;
};
```

Each remote audio track feeds a shared `AudioContext`:
`MediaStreamAudioSourceNode → AudioWorkletNode(mixer/resampler)`, which posts **16 kHz s16le mono PCM frames** to Node via a Playwright binding. Node fan-outs the PCM to: (a) Soniox realtime WS, (b) disk (WAV/Opus for the artifact), (c) customer `audio_mixed_raw` realtime endpoints.

**Per-participant audio on Meet:** Meet sends ~3 active audio streams (SFU top-N mixing), each track tagged with an SSRC that maps to a participant via `pc.getStats()` (`RTCInboundRtpStreamStats.trackIdentifier` ↔ contributing source `ssrc`/`csrc`). We capture each hooked track to its own worklet tap → near-per-participant audio (accurate for whoever is audible, which is what matters). Zoom SDK gives true per-participant audio; Meet gives per-active-speaker tracks — both feed the same `audio_separate_raw` output.

**Video capture:** `getDisplayMedia` self-capture of the meeting tab (`preferCurrentTab`) → `MediaRecorder` (VP9/H.264 webm) → chunked upload. Per-participant video = periodic canvas grabs of each tile (`video_separate_png`, 2 fps) — matches Recall's format.

### 2.3 Participant metadata — the "who said what, when" inputs
Two complementary sources, both timestamped on the capture clock:

**(a) WebRTC stats (robust, selector-free):** `pc.getStats()` every 250 ms → per-SSRC `audioLevel`/`totalAudioEnergy`. Rising energy on a track = that participant is speaking. Combined with the SSRC→participant map this yields `speech_on`/`speech_off` events with ~250 ms resolution, independent of UI classes.

**(b) DOM observation (names, roster, everything else):** a `MutationObserver` suite watching:
- **Roster:** participant list items carry stable `data-participant-id` attributes; name text + "(Host)" / "(You)" suffixes → `join`/`leave`/`update` events and the Participant table.
- **Speaking indicators:** Meet animates a waveform icon on the speaking tile; class-name churn is high, so match on structure (the tile containing `data-participant-id` gaining the animated indicator subtree) rather than class names, and **calibrate against signal (a)**.
- **Mute/camera state:** mic-off / cam-off icons per tile → `mute`/`unmute`, `webcam_on/off`.
- **Screenshare:** presentation tile appearing (`screenshare_on/off` + presenter identity).
- **Chat:** message nodes → `chat_message {participant, text, to}`.
- **Meeting title** from `document.title`; platform meeting id from URL.

All selectors live in one **versioned adapter file per platform** (`adapters/meet.selectors.json`) with a self-test (§5) that fails loudly when Google ships a UI change, because they will.

### 2.4 Sending media INTO the meeting (AI agent path)
The same fake-device flags let the bot *speak*: decode customer-supplied audio (`output_media.audio`) into the fake mic via WebAudio (`MediaStreamAudioDestinationNode` swapped into the sender track with `RTCRtpSender.replaceTrack`), and paint `automatic_video_output` frames onto a canvas piped to the fake camera track. Chat messages via DOM automation (`chat` config: `on_bot_join` message etc.).

### 2.5 Leaving
`automatic_leave` config (all timers, matching Recall semantics): `waiting_room_timeout` (default 1200 s), `noone_joined_timeout` (1200 s), `everyone_left_timeout` (2 s postlude), `in_call_not_recording_timeout`, `silence_detection` (100 s of <-50 dBFS), plus explicit `POST /bot/{id}/leave_call`. On leave: flush Soniox (send `""` end-of-audio), finalize artifacts, emit `call_ended` → `done`.

## 3. Zoom & Teams specifics

| Concern | Zoom web bot | Zoom Linux SDK bot | Teams web bot |
|---|---|---|---|
| Join | `zoom.us/wc/{id}/join` web client, guest name + passcode from URL | SDK `JoinMeeting` with meeting number/passcode | `teams.microsoft.com/l/meetup-join/...` anonymous join (tenant must allow) |
| Audio | Same RTCPeerConnection hook | Per-participant raw PCM callbacks | Same RTCPeerConnection hook |
| Roster/events | DOM scrape | SDK callbacks (authoritative) | DOM scrape (`data-tid` attributes — Teams DOM is test-id-friendly) |
| Consent | "This meeting is being recorded" banner if local recording granted | Host must grant recording permission | Recording banner via bot join notification |
| Gotchas | Waiting rooms, webclient A/B variants | App review for raw-data SDK; x86_64 Linux only | "Anonymous users can join" tenant policy; NAA popups |

## 4. Orchestration & scaling

- **v0 (this repo):** `POST /api/v1/bot` → server spawns a bot **process** (`packages/meet-bot`) with a job spec; process streams events/PCM back over local WS; server owns status machine, artifacts, webhooks.
- **v1:** bot process → Docker image (headless Chromium works with the WebRTC-hook capture — no X11/PulseAudio needed since we never touch the OS audio layer; this is a major simplification vs. ffmpeg-capture bots). One bot per container, ~1 vCPU / 2 GB with video, ~0.3 vCPU audio-only.
- **v2:** Kubernetes Jobs + warm pool (pre-launched Chromium parked on about:blank, join latency ~2 s), regional media gateways, autoscaling on scheduled calendar load.

## 5. Testing strategy (extensive, per requirement)

1. **Unit:** transcript-engine merge (✅ 6 tests passing), event-stream reducers, status machine, link parsers.
2. **Fake-meeting harness (`packages/meet-bot/test/harness`):** a local HTML page that *is* a synthetic meeting — creates real `RTCPeerConnection` loopback pairs playing `say`-generated speech WAVs for N fake participants, renders Meet-like DOM (tiles, roster, speaking indicators toggled in sync with audio). The bot runs its full pipeline against it: WebRTC hook → PCM → (mock or real) Soniox → attribution → transcript. Asserts word-level speaker accuracy against the known script. This catches 90% of pipeline bugs without touching Google.
3. **Live smoke test:** join a real Meet (human creates it), verify statuses, roster names, speech events vs. reality, chat capture, artifact integrity (`ffprobe` duration == event-timeline span ±1 s).
4. **Selector canary:** scheduled headless run against a real empty Meet lobby; adapter self-test fails → alert to update `meet.selectors.json`.
5. **Attribution accuracy metric:** harness reports % words attributed `ui_exclusive` vs `diarization_map` vs `unattributed` — regression-tracked.

## 6. Platform ToS & consent posture

Bots visibly join with a clear name (configurable "… Notetaker"); we surface recording state to the meeting where the platform supports it, honor ejection immediately (`fatal.sub_code = bot_removed`), and document per-jurisdiction consent obligations for customers. Zoom/Teams native paths carry platform-level consent banners by design. We do not implement waiting-room evasion, fingerprint spoofing beyond standard automation flags, or CAPTCHA bypass.
