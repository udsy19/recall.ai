# Calendar API — Design

Connects users' Google and Microsoft calendars to (1) **auto-schedule bots** onto meetings that match rules, and (2) **enrich recordings** with calendar metadata: meeting title, organizer, attendee emails, response status, recurrence. This is what upgrades "Speaker 2" into "bob@customer.com, external, declined-then-showed-up".

## 1. Objects & endpoints (Recall-compatible shape)

```jsonc
// Calendar — one connected account
{ "id": "uuid", "platform": "google_calendar" | "microsoft_outlook",
  "platform_email": "alice@acme.com", "status": "connected" | "disconnected",
  "oauth_client_id": "...",   // customer brings their own OAuth app (v2-style)
  "created_at": "..." }

// CalendarEvent — normalized from both providers
{ "id": "uuid", "calendar_id": "uuid",
  "platform_id": "google eventId / graph event id",
  "title": "Q3 Pipeline Review", "start_time": "ISO8601", "end_time": "ISO8601",
  "organizer": { "email": "...", "name": "..." },
  "attendees": [ { "email": "...", "name": "...", "response": "accepted|declined|tentative|needsAction", "is_external": true } ],
  "meeting_url": "https://meet.google.com/abc-defg-hij", "meeting_platform": "google_meet",
  "is_recurring": true, "recurring_series_id": "...",
  "raw": { /* provider payload for anything we didn't normalize */ },
  "bots": [ { "bot_id": "uuid", "deduplication_key": "..." } ] }
```

Endpoints: `POST /api/v1/calendars` (finish OAuth, store tokens), `GET /api/v1/calendars/{id}`, `GET /api/v1/calendar-events?start_time__gte=...`, `POST /api/v1/calendar-events/{id}/bot` (schedule), `DELETE .../bot`, plus **auto-record preferences** per calendar (§4). Webhooks: `calendar.update`, `calendar.sync_events` (tells customers "re-fetch this window changed").

## 2. Google Calendar sync

- **OAuth:** customer's own OAuth client; scope `https://www.googleapis.com/auth/calendar.events.readonly` (+ `calendar.readonly` for calendar list). Store refresh token, rotate access tokens server-side.
- **Initial sync:** `events.list` on `primary` with `singleEvents=true` (expands recurrences), window −1 day → +6 months, paging via `nextPageToken`, then persist `nextSyncToken`.
- **Incremental:** `events.list?syncToken=...` returns only deltas (including `status: "cancelled"`). On `410 GONE` → full resync (mandatory to handle).
- **Push:** `events.watch` → webhook channel (needs public HTTPS + domain verification); channels expire ≤7 days → renewal cron at 5 days. Push tells you *that* something changed; you still pull with syncToken. Fallback: 15-min polling when push isn't configured (fine for v0).
- **Meeting links:** first-class `conferenceData.entryPoints[type=video].uri` (Meet, and Zoom/Webex via conferencing add-ons), then regex sweep over `location` + `description` (§3).

## 3. Microsoft Graph sync

- **OAuth:** scope `Calendars.Read offline_access`; multi-tenant app; admin-consent flow for org-wide installs.
- **Incremental:** `GET /me/calendarView/delta?startDateTime=...&endDateTime=...` — delta link pattern like Google's syncToken (calendarView expands recurrences; use it, not `/events`).
- **Push:** `POST /subscriptions` (resource `me/events`) — **max expiry ~3 days** for calendar resources → renewal cron at 2 days; handle `lifecycleNotifications` (`reauthorizationRequired`, `subscriptionRemoved`). Validation handshake: echo `validationToken` within 10 s.
- **Meeting links:** `onlineMeeting.joinUrl` / `onlineMeetingUrl` (Teams), then regex sweep of `location.displayName` + `body.content` (HTML — strip tags first).

## 4. Meeting-link parsing (shared `packages/calendar-sync/link-parser`)

Ordered, most-specific-first; each pattern extracts platform + canonical id + credentials:

| Platform | Patterns (abridged) | Extras |
|---|---|---|
| Zoom | `(*.)?zoom.us/j/{id}`, `/wc/{id}/join`, `/my/{vanity}` | `?pwd=` passcode; strip tracking params; `zoomgov.com` |
| Meet | `meet.google.com/[a-z]{3}-[a-z]{4}-[a-z]{3}` | lookup codes (`/lookup/...`) |
| Teams | `teams.microsoft.com/l/meetup-join/...`, `teams.live.com/meet/...` | URL-encoded thread id inside path — keep raw |
| Webex | `*.webex.com/meet/{user}`, `/join/{user}`, `/wbxmjs/joinservice` | site subdomain matters |
| Fallback | GoTo, Whereby, generic `https` in `location` | flagged `platform: "unknown"` — no bot |

Canonicalization matters for **dedup** (§5): `https://zoom.us/j/123?pwd=x` and `https://us02web.zoom.us/j/123` are the same meeting → canonical key `zoom:123`.

## 5. Auto-record rules & bot scheduling

Per-calendar preferences (mirrors Recall's `auto_record` semantics):
```jsonc
{ "record_external": true,            // any attendee domain ≠ owner domain
  "record_internal": false,
  "record_only_host": false,          // only meetings the user organizes
  "title_keyword_allow": ["interview", "demo"],
  "title_keyword_block": ["1:1", "standup"],
  "bot_config_template": { "bot_name": "Acme Notetaker", "recording_config": {...} } }
```

Scheduler loop (cron, 1 min):
1. Query events starting in the next N minutes with a parseable `meeting_url` and rule match.
2. **Dedup:** one bot per `(canonical_meeting_key, start_time ± 15 min)` across ALL connected calendars of the customer — when five attendees all connected calendars, exactly one bot joins. Deterministic winner (lowest calendar uuid) so retries are idempotent.
3. `POST /bot` with `join_at = start_time − 1 min`; store `bot_id` on the event.
4. On event **update** (time/URL change): diff → move/cancel bot. On **cancellation**: cancel bot. Recurring series: rule evaluated per instance.

## 6. Enrichment — joining calendar attendees to in-meeting participants

At recording finalization (and live, for realtime consumers):
1. Candidate set = event attendees (email + display name from provider profile).
2. Match in-meeting display names → attendee names: normalized exact match → token-set match ("Chen, Alice" ↔ "Alice Chen") → first-name + initial. Confidence recorded per match; ambiguous matches stay unmatched rather than guessed.
3. Sets `participant.email`, `participant.is_external` (attendee domain vs. organizer domain), and `meeting_metadata` {title, organizer, calendar_event_id, series id}.
4. Unmatched in-meeting names (dial-ins, "ask to join" guests) and no-show attendees are both preserved — the diff itself is valuable metadata (`attendance`: joined/no_show/unknown).

## 7. Failure modes to design for
Token revocation (mark calendar `disconnected`, webhook the customer, never silently stop recording), sync-token expiry (transparent full resync), webhook outages (poll fallback), timezone/DST (store UTC + original tz), all-day events (never record), duplicate provider webhooks (idempotency by `platform_id` + `updated` stamp).

## 8. Testing strategy
1. **Link parser:** table-driven tests, 100+ real-world URLs (incl. tracking-wrapped, HTML-entity-encoded, localized Outlook bodies).
2. **Sync engine:** provider-mock fixtures for create/update/cancel/move/recurrence-exception; assert normalized event diffs and emitted webhooks. Replay a recorded `410 GONE` → full resync path.
3. **Dedup:** property test — N calendars × same meeting, random arrival order → exactly one bot.
4. **Live:** real Google + Outlook sandbox accounts, scripted event creation via provider APIs, assert bot scheduled/moved/cancelled within one scheduler tick.
5. **Enrichment accuracy:** labeled fixture set of (attendee list, roster) pairs → precision target ≥98% (wrong email on a transcript is worse than none), recall tracked.
