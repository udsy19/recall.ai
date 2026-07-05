# Mobile Recording SDK — Design

Record **phone calls** and **in-person meetings** from iOS/Android apps. (Recall.ai lists this as "coming soon" — there is no incumbent design to mirror, so this doc is constraint-driven.)

## 1. Hard platform constraints (design around these, not against them)

| Capability | iOS | Android |
|---|---|---|
| Record cellular calls (PSTN) | ❌ No API, ever. iOS 18.1+ has *system* call recording (user-initiated, announced to both parties, saved to Notes) — **no third-party API** | ❌ Since Android 10: call audio restricted to the default dialer / system apps. Accessibility-service workarounds banned from Play Store (2022 policy) |
| Record VoIP calls **inside your own app** | ✅ You own the audio path (CallKit + AVAudioSession) | ✅ You own the audio path |
| Record ambient/in-person audio | ✅ AVAudioSession + background audio mode | ✅ AudioRecord + foreground service (`microphone` type) |
| Record other apps' meeting audio (Zoom on the phone) | ❌ (no system-audio capture for third parties) | ❌ (`AudioPlaybackCapture` requires the *played* app to allow it; meeting apps opt out) |

**Conclusion:** the SDK ships three capture modes, and "record any phone call" is delivered **telephony-side**, not device-side.

## 2. Mode A — In-person (ambient) recording  [v0, both platforms]

The Granola-iOS / Otter-mobile use case: phone on the table during a meeting.

- **iOS:** `AVAudioSession(.playAndRecord, mode: .default, options: [.allowBluetooth])`, `AVAudioEngine` input tap → 16 kHz mono PCM; `audio` background mode keeps capture alive with the screen locked; handle interruptions (incoming call pauses → auto-resume, gap recorded as an event); Live Activity showing recording state (required for trust + review).
- **Android:** `AudioRecord` (`VOICE_RECOGNITION` source — AGC/NS tuned for speech) in a foreground service with `foregroundServiceType="microphone"`, POST_NOTIFICATIONS + RECORD_AUDIO permissions, Doze-safe.
- **Speaker attribution:** single mic, no UI to scrape → pure Soniox diarization (`Speaker 1..N`). Two boosts: the device owner's voice is enrollable ("read this sentence" at setup → map their diarization cluster to their identity via voice-profile similarity, or cheaper: the cluster with highest energy/proximity heuristic is *usually* the owner — we A/B against enrollment); calendar enrichment (doc 03) names likely participants for the customer's UI to offer as label suggestions.
- **Offline-first:** ring buffer → encrypted chunks (Opus 24 kbps) on disk → resumable upload when network returns; live-streaming mode (WS → Soniox realtime) when online. Battery target: <8%/hr recording with screen off.

## 3. Mode B — In-app VoIP calls  [v1]

For customers whose apps make calls (sales dialers, telehealth): CallKit/ConnectionService + WebRTC where **we are the audio path**, so we tap both directions cleanly: local mic + remote RTP stream = two channels, perfect me/them separation, same pipeline as the Desktop SDK's two-channel model. Zero diarization needed for 1:1 calls.

## 4. Mode C — Telephony-side recording  [v1, the "any phone call" answer]

Recording happens in the cloud, on the call leg — the phone is just a phone:
1. **Recording line / merge-call:** app dials our Twilio number, conferences the callee (or user merges an ongoing call) → conference with per-leg **dual-channel recording** (`record=record-from-answer-dual`). Per-leg audio ⇒ perfect speaker separation ⇒ per-participant tracks like a Zoom SDK bot.
2. **SIP trunk / native integration:** customers on Twilio/Telnyx/RingCentral hand us recording webhooks or media streams (Twilio Media Streams WS → straight into our realtime Soniox pipeline for live transcripts of phone calls).
3. **Caveats:** per-minute cost, caller-ID handling, and **consent**: recording announcements are configurable and legally required in two-party-consent jurisdictions — the SDK exposes `consent_announcement: auto` (plays "this call is being recorded") and we document per-region defaults.

## 5. SDK surface (both platforms)

```
RecallMobile.configure(apiKey, region)
session = RecallMobile.startRecording(mode: .inPerson | .voip(call) | .telephony(number),
                                      realtime: true, metadata: {...})
session.events   // roster/labels, chunk-upload progress, live transcript segments
session.stop() -> uploadHandle -> recording_id     // same Recording object as bots/desktop
```
Swift Package + Kotlin/AAR; a thin React Native / Flutter wrapper over both (large share of target customers). Uploads tagged `source.type = mobile_sdk`, `source.platform = phone | in_person` — identical downstream pipeline, transcripts, webhooks.

## 6. Store-review & privacy posture
Visible recording state at all times (Live Activity / persistent notification), mic-permission rationale strings, no background *start* of recording (user or CallKit action initiates), on-device encryption at rest, configurable retention. These aren't just compliance — reviewers reject ambient-recording apps that look covert.

## 7. Testing strategy
1. **Simulator/emulator:** capture pipeline with injected audio files (AVAudioEngine manual rendering / Android `AudioRecord` shadow), chunker + resumable-upload unit tests with network-fault injection (airplane mode mid-upload).
2. **Physical-device matrix:** battery drain (8-hr soak), interruption storms (calls, Siri, app kill), Bluetooth mic switching, Doze/App-Standby on Android.
3. **Diarization accuracy:** scripted 2/3/4-speaker table reads (TTS through separate physical speakers around a phone) → word-level speaker accuracy vs. known script; compare owner-enrollment vs. heuristic labeling.
4. **Telephony e2e:** Twilio test creds — scripted call between two legs playing TTS, assert dual-channel artifact, per-leg attribution, live `transcript.data` latency < 2 s.
