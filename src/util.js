var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

autoSender.log = (...args) => console.log('%c[pb]', 'color:#7c5cff;font-weight:bold', ...args);
autoSender.warn = (...args) => console.warn('[pb]', ...args);

autoSender.waitForStable = async function (fn, { quiet = 400, timeout = 6000, interval = 150 } = {}) {
  const started = Date.now();
  let last = null;
  let stableSince = 0;
  while (Date.now() - started < timeout) {
    const now = fn();
    if (now === last) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= quiet) return true;
    } else {
      last = now;
      stableSince = 0;
    }
    await autoSender.sleep(interval);
  }
  return false;
};

autoSender.stripTimestamps = function (s) {
  return String(s || '')
    .replace(/\b\d{1,2}:\d{2}\s?(AM|PM)?\b/gi, '')
    .replace(/\b\d+\s?(sec|secs|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/gi, '')
    .replace(/\b(Just now|Yesterday|Today|Now)\b/gi, '')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

autoSender.convIdFromUrl = function (url) {
  const m = String(url || '').match(/\/conversations\/([^/?#]+)/);
  return m ? m[1] : null;
};

autoSender.diffFromAnchor = function (cached, visible, anchorLen = 5) {
  if (!cached.length) return { delta: visible, matched: true, seeded: false };

  const k = Math.min(anchorLen, cached.length, visible.length);
  if (k === 0) return { delta: [], matched: false };

  const key = (m) => (m.incoming ? 'i' : 'o') + '\u0000' + m.text;
  const tail = cached.slice(-k).map(key).join('\u0001');

  for (let start = visible.length - k; start >= 0; start--) {
    const window = visible.slice(start, start + k).map(key).join('\u0001');
    if (window === tail) {
      return { delta: visible.slice(start + k), matched: true };
    }
  }
  return { delta: [], matched: false };
};
