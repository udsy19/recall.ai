import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsToIntervals, buildTranscript } from '../src/index.js';

const ROSTER = [
  { id: 'p1', name: 'Alice', isHost: true },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Carol' },
];

/** Helper: make word tokens spread evenly across [startMs, endMs]. */
function words(text, startMs, endMs, speaker) {
  const parts = text.split(' ');
  const step = (endMs - startMs) / parts.length;
  return parts.map((w, i) => ({
    text: (i === 0 ? '' : ' ') + w,
    startMs: Math.round(startMs + i * step),
    endMs: Math.round(startMs + (i + 1) * step),
    speaker,
  }));
}

test('eventsToIntervals pairs starts and stops, closes dangling starts', () => {
  const intervals = eventsToIntervals(
    [
      { tsMs: 1000, participantId: 'p1', type: 'speech_start' },
      { tsMs: 4000, participantId: 'p1', type: 'speech_stop' },
      { tsMs: 3500, participantId: 'p2', type: 'speech_start' },
      // p2 never stops — capture ends at 9000
      { tsMs: 500, participantId: 'p3', type: 'speech_stop' }, // stray stop dropped
    ],
    9000,
  );
  assert.deepEqual(intervals, [
    { participantId: 'p1', startMs: 1000, endMs: 4000 },
    { participantId: 'p2', startMs: 3500, endMs: 9000 },
  ]);
});

test('clean turn-taking attributes every word to the UI speaker', () => {
  const tokens = [
    ...words('hello everyone welcome to the call', 1000, 4000, '1'),
    ...words('thanks alice great to be here', 5000, 8000, '2'),
    ...words('let us get started', 9000, 11000, '1'),
  ];
  const events = [
    { tsMs: 900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 4100, participantId: 'p1', type: 'speech_stop' },
    { tsMs: 4900, participantId: 'p2', type: 'speech_start' },
    { tsMs: 8100, participantId: 'p2', type: 'speech_stop' },
    { tsMs: 8900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 11100, participantId: 'p1', type: 'speech_stop' },
  ];
  const { segments } = buildTranscript({ tokens, events, roster: ROSTER, captureEndMs: 12000 });
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => [s.speakerName, s.text]),
    [
      ['Alice', 'hello everyone welcome to the call'],
      ['Bob', 'thanks alice great to be here'],
      ['Alice', 'let us get started'],
    ],
  );
});

test('cross-talk resolves via diarization labels learned from clean regions', () => {
  // Alice (diar "1") and Bob (diar "2") overlap between 5000-8000.
  const tokens = [
    ...words('first alice speaks alone for a while', 1000, 4500, '1'),
    ...words('bob interrupts here loudly', 5000, 7000, '2'),
    ...words('alice keeps going anyway', 5500, 7500, '1'),
    ...words('then bob finishes alone', 9000, 11000, '2'),
  ];
  const events = [
    { tsMs: 900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 7600, participantId: 'p1', type: 'speech_stop' },
    { tsMs: 4900, participantId: 'p2', type: 'speech_start' },
    { tsMs: 11100, participantId: 'p2', type: 'speech_stop' },
  ];
  const { segments, attributionStats } = buildTranscript({
    tokens, events, roster: ROSTER, captureEndMs: 12000,
  });
  // During cross-talk, interleaved words split into alternating segments —
  // assert per-word attribution: every word must land on its true speaker.
  const wordSpeaker = new Map();
  for (const seg of segments) for (const w of seg.words) wordSpeaker.set(w.text.trim(), seg.speakerName);
  for (const w of ['bob', 'interrupts', 'here', 'loudly', 'finishes']) {
    assert.equal(wordSpeaker.get(w), 'Bob', `word "${w}"`);
  }
  for (const w of ['alice', 'keeps', 'going', 'anyway', 'first', 'speaks']) {
    assert.equal(wordSpeaker.get(w), 'Alice', `word "${w}"`);
  }
  assert.ok(attributionStats.diarization_map >= 1, 'expected diarization fallback to be exercised');
});

test('tokens outside any interval fall back to diarization map, else unattributed', () => {
  const tokens = [
    ...words('alice talks in a clean window', 1000, 3000, '1'),
    // UI missed this speech entirely (indicator glitch), but diar label matches Alice
    ...words('ui missed this bit', 20000, 21500, '1'),
    // Unknown diar label, no UI signal
    ...words('mystery voice', 30000, 30800, '9'),
  ];
  const events = [
    { tsMs: 900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 3100, participantId: 'p1', type: 'speech_stop' },
  ];
  const { segments } = buildTranscript({ tokens, events, roster: ROSTER, captureEndMs: 40000 });
  const map = Object.fromEntries(segments.map((s) => [s.text, s.speakerName]));
  assert.equal(map['ui missed this bit'], 'Alice');
  assert.equal(map['mystery voice'], 'Unknown speaker');
});

test('UI indicator lag within padding still attributes correctly', () => {
  // Speech actually starts at 1000; UI indicator fires at 1600 (600ms lag).
  const tokens = words('quick answer yes', 1000, 2200, undefined);
  const events = [
    { tsMs: 1600, participantId: 'p3', type: 'speech_start' },
    { tsMs: 2800, participantId: 'p3', type: 'speech_stop' },
  ];
  const { segments } = buildTranscript({ tokens, events, roster: ROSTER, captureEndMs: 5000 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].speakerName, 'Carol');
});

test('segments split on long silence gaps for the same speaker', () => {
  const tokens = [
    ...words('part one', 1000, 2000, '1'),
    ...words('part two after a pause', 10000, 12000, '1'),
  ];
  const events = [
    { tsMs: 900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 2100, participantId: 'p1', type: 'speech_stop' },
    { tsMs: 9900, participantId: 'p1', type: 'speech_start' },
    { tsMs: 12100, participantId: 'p1', type: 'speech_stop' },
  ];
  const { segments } = buildTranscript({ tokens, events, roster: ROSTER, captureEndMs: 13000 });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].speakerName, 'Alice');
  assert.equal(segments[1].speakerName, 'Alice');
});
