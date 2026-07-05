/**
 * Participant-event scraper. Polls the meeting DOM (200 ms) using a
 * per-platform selector config and reports diffs to Node via __botEvent:
 *   {type: 'join'|'leave'|'speech_on'|'speech_off'|'chat_message'|'title',
 *    participantId, name, isHost?, text?}
 * Node stamps arrival time onto the capture clock — see bot.js.
 *
 * Selector configs live in src/adapters/; polling + diffing is shared here.
 */
export function makeScraperScript(selectors) {
  return `(() => {
    const S = ${JSON.stringify(selectors)};
    const roster = new Map();   // pid -> {name, isHost}
    const speaking = new Map(); // pid -> bool
    const seenChats = new WeakSet();
    const emit = (e) => window.__botEvent && window.__botEvent(JSON.stringify(e));

    function pidOf(el) { return el.getAttribute(S.idAttr) || null; }

    function scan() {
      // --- roster ---
      const present = new Map();
      for (const el of document.querySelectorAll(S.rosterItem)) {
        const pid = pidOf(el);
        if (!pid) continue;
        const nameEl = S.nameSel ? el.querySelector(S.nameSel) : el;
        let name = (nameEl?.textContent || '').trim();
        let isHost = false;
        if (S.hostMarker && name.includes(S.hostMarker)) { isHost = true; name = name.replace(S.hostMarker, '').trim(); }
        if (name) present.set(pid, { name, isHost });
      }
      for (const [pid, info] of present) {
        const prev = roster.get(pid);
        if (!prev) { roster.set(pid, info); emit({ type: 'join', participantId: pid, ...info }); }
        else if (prev.name !== info.name || prev.isHost !== info.isHost) {
          roster.set(pid, info); emit({ type: 'update', participantId: pid, ...info });
        }
      }
      for (const pid of [...roster.keys()]) {
        if (!present.has(pid)) {
          const info = roster.get(pid); roster.delete(pid);
          if (speaking.get(pid)) { speaking.set(pid, false); emit({ type: 'speech_off', participantId: pid, name: info.name }); }
          emit({ type: 'leave', participantId: pid, ...info });
        }
      }
      // --- active speakers ---
      for (const el of document.querySelectorAll(S.tile)) {
        const pid = pidOf(el);
        if (!pid) continue;
        const now = S.speakingClass
          ? el.classList.contains(S.speakingClass)
          : (S.speakingIndicator ? !!el.querySelector(S.speakingIndicator) : false);
        const prev = speaking.get(pid) || false;
        if (now !== prev) {
          speaking.set(pid, now);
          const name = roster.get(pid)?.name;
          emit({ type: now ? 'speech_on' : 'speech_off', participantId: pid, name });
        }
      }
      // --- chat ---
      if (S.chatMessage) {
        for (const el of document.querySelectorAll(S.chatMessage)) {
          if (seenChats.has(el)) continue;
          seenChats.add(el);
          const author = S.chatAuthor ? el.querySelector(S.chatAuthor)?.textContent?.trim() : null;
          const text = (S.chatText ? el.querySelector(S.chatText)?.textContent : el.textContent)?.trim();
          if (text) emit({ type: 'chat_message', name: author, text });
        }
      }
    }
    scan();
    window.__botScraperTimer = setInterval(scan, 200);
    emit({ type: 'title', text: document.title });
  })();`;
}
