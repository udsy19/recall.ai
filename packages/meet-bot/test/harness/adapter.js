/** Adapter for the fake-meeting harness page (test/harness/meeting.html). */
export const harnessAdapter = {
  name: 'harness',
  selectors: {
    rosterItem: '#roster li',
    tile: '#roster li',
    idAttr: 'data-participant-id',
    nameSel: null,
    hostMarker: '(Host)',
    speakingClass: 'speaking',
    speakingIndicator: null,
    chatMessage: null,
  },
  matches: (url) => url.includes('meeting.html'),
  async join(page) {
    await page.click('#join');
    return 'in_call';
  },
  async prepareInCall() {},
  async leave() {},
};
