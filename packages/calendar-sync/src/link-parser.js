/**
 * Meeting-link detection + canonicalization (docs/03 §4).
 *
 * parseMeetingLink(text) scans free text (event location, description,
 * conferenceData URIs) and returns the first recognized meeting link:
 *   { platform, url, canonicalKey, passcode? }
 * canonicalKey identifies the same meeting across URL variants — the dedup
 * key for "five attendees, one bot".
 */

const PATTERNS = [
  {
    platform: 'zoom',
    re: /https?:\/\/(?:[\w-]+\.)?(zoom\.us|zoomgov\.com)\/(?:j|w|wc(?:\/join)?|s)\/(\d{9,11})[^\s<>"']*/gi,
    key: (m) => `zoom:${m[2]}`,
    passcode: (m) => new URL(m[0].replace(/[),.;!\]]+$/, '')).searchParams.get('pwd') ?? undefined,
  },
  {
    platform: 'zoom',
    re: /https?:\/\/(?:[\w-]+\.)?zoom\.us\/my\/([\w.-]+)[^\s<>"']*/gi,
    key: (m) => `zoom:my:${m[1].toLowerCase()}`,
  },
  {
    platform: 'google_meet',
    re: /https?:\/\/meet\.google\.com\/(?:lookup\/)?([a-z]{3}-[a-z]{4}-[a-z]{3}|[a-z0-9]{10,})(?:\?[^\s<>"']*)?/gi,
    key: (m) => `meet:${m[1].toLowerCase()}`,
  },
  {
    platform: 'microsoft_teams',
    re: /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/([^\s<>"']+)/gi,
    key: (m) => `teams:${decodeURIComponent(m[1]).replace(/\/.*$/, '').toLowerCase()}`,
  },
  {
    platform: 'webex',
    re: /https?:\/\/([\w-]+)\.webex\.com\/(?:meet|join)\/([\w.-]+)[^\s<>"']*/gi,
    key: (m) => `webex:${m[1].toLowerCase()}:${m[2].toLowerCase()}`,
  },
  {
    platform: 'webex',
    re: /https?:\/\/([\w-]+)\.webex\.com\/[\w-]+\/j\.php\?MTID=(\w+)[^\s<>"']*/gi,
    key: (m) => `webex:${m[1].toLowerCase()}:${m[2]}`,
  },
];

/** Strip HTML tags & entities so links hiding in rich-text bodies surface. */
export function stripHtml(html) {
  return html
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#43;/g, '+').replace(/&nbsp;/g, ' ');
}

/**
 * @param {string|null|undefined} text plain text or HTML
 * @returns {{platform: string, url: string, canonicalKey: string, passcode?: string}|null}
 */
export function parseMeetingLink(text) {
  if (!text) return null;
  const haystack = /<\w+[\s>]/.test(text) ? stripHtml(text) : text;
  let best = null;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(haystack);
    if (!m) continue;
    if (best && m.index >= best.index) continue; // earliest link in the text wins
    best = {
      index: m.index,
      link: {
        platform: p.platform,
        url: m[0].replace(/[),.;!\]]+$/, ''),
        canonicalKey: p.key(m),
        ...(p.passcode ? (() => { try { const pw = p.passcode(m); return pw ? { passcode: pw } : {}; } catch { return {}; } })() : {}),
      },
    };
  }
  return best?.link ?? null;
}

/** Scan an event's fields in priority order (structured first). */
export function parseEventMeetingLink({ conferenceUri, location, description } = {}) {
  return parseMeetingLink(conferenceUri) ?? parseMeetingLink(location) ?? parseMeetingLink(description);
}
