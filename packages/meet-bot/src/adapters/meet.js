/**
 * Google Meet adapter: guest join flow + scraper selectors.
 *
 * NOTE: Meet's class names churn constantly; we anchor on stable attributes
 * (data-participant-id, aria labels, roles). The speaking indicator has no
 * stable hook — `speakingIndicator` below needs calibration against a live
 * meeting (doc 01 §2.3; the getStats() audio-level signal is the planned
 * primary source). Selector changes belong in this file only.
 */
export const meetAdapter = {
  name: 'google_meet',

  selectors: {
    rosterItem: '[data-participant-id]',
    tile: '[data-participant-id]',
    idAttr: 'data-participant-id',
    nameSel: null,
    hostMarker: null,
    speakingClass: null,
    speakingIndicator: null, // CALIBRATE on live Meet before relying on DOM speech events
    chatMessage: '[data-message-id]',
    chatAuthor: null,
    chatText: '[jsname]',
  },

  matches(url) {
    return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);
  },

  /** Join as guest. Page must already be at the meeting URL. Returns 'in_call' | 'waiting_room' | 'denied'. */
  async join(page, { botName, waitingRoomTimeoutMs = 20 * 60 * 1000 }) {
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.waitFor({ timeout: 30000 });
    await nameInput.fill(botName);

    const joinBtn = page.getByRole('button', { name: /ask to join|join now|join anyway/i }).first();
    await joinBtn.click();

    const admitted = page.getByRole('button', { name: /leave call/i });
    const waiting = page.getByText(/asking to be let in|waiting for someone to let you in/i);
    const denied = page.getByText(/you can't join|denied your request|meeting hasn't started/i);

    const outcome = await Promise.race([
      admitted.waitFor({ timeout: waitingRoomTimeoutMs }).then(() => 'in_call'),
      denied.waitFor({ timeout: waitingRoomTimeoutMs }).then(() => 'denied'),
      waiting.waitFor({ timeout: 15000 }).then(() => 'waiting_room').catch(() => new Promise(() => {})),
    ]).catch(() => 'denied');

    if (outcome === 'waiting_room') {
      const final = await Promise.race([
        admitted.waitFor({ timeout: waitingRoomTimeoutMs }).then(() => 'in_call'),
        denied.waitFor({ timeout: waitingRoomTimeoutMs }).then(() => 'denied'),
      ]).catch(() => 'denied');
      return final;
    }
    return outcome;
  },

  async prepareInCall(page) {
    // Mute mic / camera if the fake device left them on.
    for (const label of [/turn off microphone/i, /turn off camera/i]) {
      await page.getByRole('button', { name: label }).first().click({ timeout: 3000 }).catch(() => {});
    }
    // Open People panel once so the roster DOM mounts.
    await page.getByRole('button', { name: /people/i }).first().click({ timeout: 5000 }).catch(() => {});
  },

  async leave(page) {
    await page.getByRole('button', { name: /leave call/i }).first().click({ timeout: 5000 }).catch(() => {});
  },
};
