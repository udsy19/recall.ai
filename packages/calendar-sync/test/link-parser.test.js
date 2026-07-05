import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingLink, parseEventMeetingLink } from '../src/index.js';

const CASES = [
  // [input, platform, canonicalKey, passcode?]
  ['https://zoom.us/j/1234567890', 'zoom', 'zoom:1234567890'],
  ['https://us02web.zoom.us/j/1234567890?pwd=aBcD123', 'zoom', 'zoom:1234567890', 'aBcD123'],
  ['Join: https://company.zoom.us/w/98765432109 (passcode in invite)', 'zoom', 'zoom:98765432109'],
  ['https://us06web.zoom.us/wc/join/1234567890', 'zoom', 'zoom:1234567890'],
  ['https://zoom.us/my/john.doe', 'zoom', 'zoom:my:john.doe'],
  ['https://acmegov.zoomgov.com/j/1615551234567'.replace('1615551234567', '16155512345'), 'zoom', 'zoom:16155512345'],
  ['https://meet.google.com/abc-defg-hij', 'google_meet', 'meet:abc-defg-hij'],
  ['Meet link: https://meet.google.com/abc-defg-hij?authuser=0.', 'google_meet', 'meet:abc-defg-hij'],
  ['https://meet.google.com/lookup/bxyz2abc3d', 'google_meet', 'meet:bxyz2abc3d'],
  ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzE4%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d',
    'microsoft_teams', 'teams:19:meeting_nze4@thread.v2'],
  ['https://teams.live.com/meet/9312345678901', 'microsoft_teams', 'teams:9312345678901'],
  ['https://acme.webex.com/meet/jdoe', 'webex', 'webex:acme:jdoe'],
  ['https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef', 'webex', 'webex:acme:m0123456789abcdef'],
];

for (const [input, platform, key, passcode] of CASES) {
  test(`parses: ${input.slice(0, 70)}`, () => {
    const r = parseMeetingLink(input);
    assert.ok(r, 'link detected');
    assert.equal(r.platform, platform);
    assert.equal(r.canonicalKey, key);
    if (passcode) assert.equal(r.passcode, passcode);
  });
}

test('same meeting, different URL variants -> same canonical key (dedup)', () => {
  const a = parseMeetingLink('https://zoom.us/j/1234567890?pwd=xyz');
  const b = parseMeetingLink('https://us02web.zoom.us/j/1234567890');
  const c = parseMeetingLink('https://company.zoom.us/wc/join/1234567890');
  assert.equal(a.canonicalKey, b.canonicalKey);
  assert.equal(a.canonicalKey, c.canonicalKey);
});

test('links hidden in Outlook-style HTML bodies', () => {
  const html = `<div><p>Alice invites you.</p>
    <a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0">Click here to join</a>
    &nbsp;Meeting ID: 123</div>`;
  const r = parseMeetingLink(html);
  assert.equal(r?.platform, 'microsoft_teams');
});

test('no false positives on plain text and non-meeting URLs', () => {
  assert.equal(parseMeetingLink('Lunch at Zoom Cafe, 123 Main St'), null);
  assert.equal(parseMeetingLink('https://zoom.us/pricing and https://meet.google.com/'), null);
  assert.equal(parseMeetingLink(''), null);
  assert.equal(parseMeetingLink(null), null);
});

test('event fields scanned in priority order: conferenceUri > location > description', () => {
  const r = parseEventMeetingLink({
    conferenceUri: 'https://meet.google.com/abc-defg-hij',
    location: 'https://zoom.us/j/1234567890',
    description: 'also https://acme.webex.com/meet/jdoe',
  });
  assert.equal(r.platform, 'google_meet');
  const r2 = parseEventMeetingLink({ description: 'join https://zoom.us/j/1234567890' });
  assert.equal(r2.platform, 'zoom');
});

test('trailing punctuation stripped from extracted URL', () => {
  const r = parseMeetingLink('Join here: https://meet.google.com/abc-defg-hij.');
  assert.equal(r.url, 'https://meet.google.com/abc-defg-hij');
});
