# Desktop Recording SDK — Design

Records meetings **on the user's machine with no bot in the call**. A lightweight desktop component captures system audio + microphone, detects when a meeting starts, attributes speech to participants, and uploads through the same ingestion pipeline as bots — so recordings land in the identical API/data model.

## 1. What we're capturing, conceptually

A meeting on a desktop is two audio paths:
- **"Them":** remote participants' voices = the meeting app's **playback** audio.
- **"Me":** the local user's voice = the **microphone**.

Capturing these as **two separate channels** (not one blended stream) is the core trick: it gives perfect me/them separation for free, and diarization only has to split the "them" channel. This is how Granola-class apps get speaker labels without a bot.

## 2. macOS implementation (primary target)

### 2.1 System / per-app audio — Core Audio process taps (macOS 14.4+)
`CATapDescription` + `AudioHardwareCreateProcessTap` lets us tap the audio **of specific processes** (zoom.us, Microsoft Teams, Chrome/Safari/Arc when the tab is a meeting):

```swift
let tap = CATapDescription(stereoMixdownOfProcesses: [zoomPid])
tap.muteBehavior = .unmuted            // user still hears the call
var tapID = AudioObjectID(kAudioObjectUnknown)
AudioHardwareCreateProcessTap(tap, &tapID)
// wrap in an aggregate device -> AudioDeviceIOProc delivers PCM buffers
```

- Per-app tap ≫ whole-system tap: Spotify/notification sounds don't pollute the recording.
- Requires audio-capture TCC consent (macOS 14.4+; NSAudioCaptureUsageDescription on 15+).
- **Fallback (macOS 13.0–14.3):** ScreenCaptureKit `SCStream` with `capturesAudio = true` filtered to the meeting app's windows — same PCM delivery, needs Screen Recording permission.

### 2.2 Microphone — AVAudioEngine with voice processing
```swift
let engine = AVAudioEngine()
try engine.inputNode.setVoiceProcessingEnabled(true)  // Apple AEC
engine.inputNode.installTap(onBus: 0, ...) { buffer, when in ... }
```
`setVoiceProcessingEnabled(true)` runs Apple's echo canceller, so the meeting audio playing on speakers doesn't leak into the mic channel — without it, "me" would contain "them" and channel separation collapses. (Meeting apps run their own AEC on what they *send*; we need our own on what we *record*.)

### 2.3 Meeting detection (auto-record)
A detector polls lightweight signals every ~2 s:
- **Native apps:** `NSWorkspace.runningApplications` (zoom.us present) + CoreAudio "process is using microphone" (`kAudioHardwarePropertyProcessInputState`-style checks) → in a call vs. merely open. Zoom also exposes window titles ("Zoom Meeting") via `CGWindowListCopyWindowInfo`.
- **Browser meetings:** window/tab titles from CGWindowList ("Meet — xyz", "… | Microsoft Teams") — no extension needed for detection; an optional companion extension adds exact URL + tab audio state.
- Emits `meeting_detected {app, title, window_id}` → SDK host app (or our menu-bar reference app) starts/prompts recording per policy (`auto | prompt | manual`).

### 2.4 Participant metadata without a bot
No DOM to scrape, but three usable sources, merged by the same transcript engine:

1. **Accessibility API (AX):** with Accessibility permission, walk the meeting app's `AXUIElement` tree: Zoom's participant list and **active-speaker name label**, Meet/Teams web DOM surfaces through Chromium's accessibility tree (`AXWebArea` descendants). Poll at 2–4 Hz → roster + `speech_on/off` events. This is the desktop analogue of the bot's DOM scraper, one adapter per app.
2. **Window title / OCR (fallback):** Zoom floats the active speaker's name in its title bar in some layouts; targeted 1 fps OCR (Vision framework, `VNRecognizeTextRequest`) of the name-badge region of the meeting window when AX is unavailable.
3. **Calendar join:** the Calendar API (doc 03) tells us who *should* be in this meeting → attendee emails matched to observed display names.

Attribution then works exactly as in doc 05: mic channel = the SDK user (identity known!); "them" channel = Soniox diarization labels mapped to AX-observed active-speaker names. Worst case (no AX permission, no calendar) we still ship "You" + "Speaker 1/2/3" — never worse than a plain recorder.

### 2.5 Packaging
- **Core:** Swift `RecallKit.framework` (capture + detection + chunked resumable uploader with offline buffering) — embeddable in customers' Mac apps.
- **Electron bridge:** prebuilt native node module wrapping the framework (most AI-notetaker customers ship Electron).
- **Reference app:** signed+notarized menu-bar app for end-to-end testing and as customer sample code.
- Real-time mode: PCM chunks stream over WS to the ingestion gateway → live Soniox → `transcript.data` webhooks, identical to bot flow.

## 3. Windows implementation (phase 2)

- **Per-process audio:** WASAPI `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Win10 2004+) → loopback capture of just the meeting process tree. Fallback: device-wide loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`).
- **Mic:** WASAPI capture + `IAudioProcessingObject` AEC or WebRTC-AEC3 (we can vendor libwebrtc's AEC).
- **Detection:** process enumeration + `IAudioSessionManager2` session activity per process + window titles via `EnumWindows`.
- **Metadata:** UI Automation (UIA) trees of Zoom/Teams native clients (Teams native is Electron → good UIA support).
- Core in Rust (`cpal`/`windows-rs`) or C++ with C ABI → same SDK surface as macOS.

## 4. Upload & data model
Chunks (Opus 32 kbps per channel + events JSONL) upload resumably (tus-style) tagged `source.type = desktop_sdk`; the server-side pipeline (Soniox async or realtime, transcript engine, webhooks) is **shared with bots** — zero divergence in output schema. `media_shortcuts.video_mixed` is optional (SCStream window capture of the meeting app, off by default).

## 5. Permissions UX (make-or-break for adoption)
First-run wizard requesting, in order, with previews: (1) Microphone — required; (2) System-audio capture / Screen Recording (13.x fallback) — required; (3) Accessibility — optional, unlocks speaker names; (4) Calendar (via our Calendar API OAuth, not macOS EventKit) — optional, unlocks titles/emails. Every capability degrades gracefully; the SDK reports `capability_state` so host apps can render setup checklists.

## 6. Testing strategy
1. **Channel-separation test:** play a known WAV through a dummy "meeting app" (afplay tagged process) while TTS (`say`) plays into a virtual mic (or a second process tap on the test runner); assert "them" channel contains only WAV, "me" only TTS (cross-correlation < threshold).
2. **AEC test:** same rig with speakers active — assert meeting audio leakage in mic channel < -35 dB.
3. **Detection matrix:** scripted launch of Zoom/Meet(Chrome)/Teams sessions → assert `meeting_detected` within 5 s, correct app + title.
4. **AX adapter tests:** recorded AX-tree snapshots per app version, replayed against the adapter (same pattern as bot selector canaries).
5. **End-to-end:** two real machines (or one machine + one bot!) in a live Meet; compare desktop-SDK transcript vs. meeting-bot transcript of the same call — word/speaker agreement is the platform's best self-check.
