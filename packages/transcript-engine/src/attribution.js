/**
 * Speaker attribution engine.
 *
 * Merges three time-aligned signals into a speaker-labeled transcript:
 *   1. STT tokens (from Soniox realtime/async) — words with start/end ms,
 *      optionally carrying a diarization speaker label ("1", "2", ...).
 *   2. Active-speaker events scraped from the meeting UI (or emitted by a
 *      platform SDK) — speech_start / speech_stop per participant.
 *   3. Participant roster — id, display name, join/leave times.
 *
 * All timestamps are milliseconds on the capture clock (t=0 when recording
 * started), so the three signals are directly comparable.
 *
 * Strategy: UI active-speaker intervals are ground truth when exactly one
 * person is speaking. Tokens that fall in ambiguous windows (overlap, UI lag)
 * are resolved via the diarization label using a cluster→participant mapping
 * learned from the unambiguous tokens.
 */

/** UI speech indicators lag / lead real audio; pad intervals by this much. */
const DEFAULT_PADDING_MS = 700;
/** Consecutive same-speaker tokens more than this far apart start a new segment. */
const DEFAULT_SEGMENT_GAP_MS = 2000;

/**
 * @typedef {Object} SttToken
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 * @property {string=} speaker    diarization label from the STT engine
 * @property {number=} confidence
 *
 * @typedef {Object} SpeakerEvent
 * @property {number} tsMs
 * @property {string} participantId
 * @property {'speech_start'|'speech_stop'} type
 *
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} name
 * @property {boolean=} isHost
 * @property {string=} email
 *
 * @typedef {Object} SpeechInterval
 * @property {string} participantId
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * Collapse raw speech_start/speech_stop events into closed intervals.
 * Unbalanced starts are closed at `captureEndMs`; stray stops are dropped.
 * @param {SpeakerEvent[]} events
 * @param {number} captureEndMs
 * @returns {SpeechInterval[]}
 */
export function eventsToIntervals(events, captureEndMs) {
  const open = new Map(); // participantId -> startMs
  const intervals = [];
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
  for (const ev of sorted) {
    if (ev.type === 'speech_start') {
      if (!open.has(ev.participantId)) open.set(ev.participantId, ev.tsMs);
    } else {
      const start = open.get(ev.participantId);
      if (start !== undefined) {
        open.delete(ev.participantId);
        if (ev.tsMs > start) {
          intervals.push({ participantId: ev.participantId, startMs: start, endMs: ev.tsMs });
        }
      }
    }
  }
  for (const [participantId, startMs] of open) {
    if (captureEndMs > startMs) intervals.push({ participantId, startMs, endMs: captureEndMs });
  }
  return intervals.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Overlap in ms between a token and a padded interval.
 */
function overlapMs(token, interval, paddingMs) {
  const s = Math.max(token.startMs, interval.startMs - paddingMs);
  const e = Math.min(token.endMs, interval.endMs + paddingMs);
  return Math.max(0, e - s);
}

/**
 * Attribute each token to a participant.
 *
 * Pass 1: for each token, collect candidate participants by padded interval
 * overlap. Exactly one candidate → confident attribution; also records a vote
 * mapping the token's diarization label → that participant.
 * Pass 2: ambiguous/orphan tokens resolve via the learned diarization mapping,
 * then via best overlap score, then remain unattributed (speaker null).
 *
 * @param {SttToken[]} tokens        final tokens only, sorted by startMs
 * @param {SpeechInterval[]} intervals
 * @param {{paddingMs?: number}} [opts]
 * @returns {{token: SttToken, participantId: string|null, method: string}[]}
 */
export function attributeTokens(tokens, intervals, opts = {}) {
  const paddingMs = opts.paddingMs ?? DEFAULT_PADDING_MS;

  // diarization label -> (participantId -> weighted votes)
  const labelVotes = new Map();
  const results = new Array(tokens.length);
  const pending = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const scores = new Map(); // participantId -> overlap ms
    for (const iv of intervals) {
      if (iv.startMs - paddingMs > token.endMs) break;
      const o = overlapMs(token, iv, paddingMs);
      if (o > 0) scores.set(iv.participantId, (scores.get(iv.participantId) ?? 0) + o);
    }
    if (scores.size === 1) {
      const participantId = scores.keys().next().value;
      results[i] = { token, participantId, method: 'ui_exclusive' };
      if (token.speaker != null) {
        let votes = labelVotes.get(token.speaker);
        if (!votes) labelVotes.set(token.speaker, (votes = new Map()));
        votes.set(participantId, (votes.get(participantId) ?? 0) + (token.endMs - token.startMs));
      }
    } else {
      pending.push({ i, token, scores });
    }
  }

  // Resolve diarization label -> participant by majority vote weight.
  const labelToParticipant = new Map();
  for (const [label, votes] of labelVotes) {
    let best = null, bestW = 0, total = 0;
    for (const [pid, w] of votes) {
      total += w;
      if (w > bestW) { bestW = w; best = pid; }
    }
    // Require a clear majority so cross-talk noise doesn't poison the map.
    if (best && bestW / total >= 0.6) labelToParticipant.set(label, best);
  }

  for (const { i, token, scores } of pending) {
    const mapped = token.speaker != null ? labelToParticipant.get(token.speaker) : undefined;
    if (mapped && (scores.size === 0 || scores.has(mapped))) {
      results[i] = { token, participantId: mapped, method: 'diarization_map' };
      continue;
    }
    if (scores.size > 0) {
      let best = null, bestO = 0;
      for (const [pid, o] of scores) if (o > bestO) { bestO = o; best = pid; }
      results[i] = { token, participantId: best, method: 'ui_best_overlap' };
      continue;
    }
    results[i] = { token, participantId: mapped ?? null, method: mapped ? 'diarization_map' : 'unattributed' };
  }
  return results;
}

/**
 * Group attributed tokens into utterance segments.
 * @param {{token: SttToken, participantId: string|null, method: string}[]} attributed
 * @param {Participant[]} roster
 * @param {{segmentGapMs?: number}} [opts]
 */
export function buildSegments(attributed, roster, opts = {}) {
  const gapMs = opts.segmentGapMs ?? DEFAULT_SEGMENT_GAP_MS;
  const byId = new Map(roster.map((p) => [p.id, p]));
  const segments = [];
  let cur = null;

  for (const { token, participantId } of attributed) {
    const startNew =
      !cur ||
      cur.participantId !== participantId ||
      token.startMs - cur.endMs > gapMs;
    if (startNew) {
      cur = {
        participantId,
        participant: participantId ? (byId.get(participantId) ?? null) : null,
        startMs: token.startMs,
        endMs: token.endMs,
        words: [],
      };
      segments.push(cur);
    }
    cur.endMs = Math.max(cur.endMs, token.endMs);
    cur.words.push({ text: token.text, startMs: token.startMs, endMs: token.endMs, confidence: token.confidence });
  }

  for (const seg of segments) {
    seg.text = seg.words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
    seg.speakerName = seg.participant?.name ?? 'Unknown speaker';
  }
  return segments;
}

/**
 * One-call pipeline: events + tokens + roster -> speaker-labeled transcript.
 * @param {{tokens: SttToken[], events: SpeakerEvent[], roster: Participant[], captureEndMs: number, paddingMs?: number, segmentGapMs?: number}} input
 */
export function buildTranscript(input) {
  const intervals = eventsToIntervals(input.events, input.captureEndMs);
  const tokens = [...input.tokens].sort((a, b) => a.startMs - b.startMs);
  const attributed = attributeTokens(tokens, intervals, { paddingMs: input.paddingMs });
  const segments = buildSegments(attributed, input.roster, { segmentGapMs: input.segmentGapMs });
  const attributionStats = {};
  for (const a of attributed) attributionStats[a.method] = (attributionStats[a.method] ?? 0) + 1;
  return { segments, attributionStats };
}
