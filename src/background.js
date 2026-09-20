// The service worker exists for two reasons:
//
// 1. Network. A fetch from the content script runs in the page's context and
//    inherits messages.google.com's CSP, which blocks calls to other origins.
//    The worker has no page attached, so with host_permissions the request goes
//    out clean.
//
// 2. The toolbar badge, which content scripts cannot touch.

import { generateReply } from './reply.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'draft') {
    draft(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg && msg.type === 'trustedClick') {
    // Only ever click inside the Messages tab that asked.
    const tab = sender.tab;
    if (!tab || !tab.url || !tab.url.startsWith('https://messages.google.com/')) {
      sendResponse({ ok: false, error: 'trusted click refused: not a Messages tab' });
      return false;
    }
    trustedClick(tab.id, msg.x, msg.y).then(sendResponse);
    return true;
  }
  return false;
});

// Google Messages ignores synthetic events (isTrusted: false), so a click from
// the content script does nothing. chrome.debugger drives the tab through the
// DevTools protocol, which produces real input the page cannot tell apart from a
// mouse. Chrome shows a "started debugging this browser" bar while attached, so
// this attaches for the one click and detaches straight away.
async function trustedClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    return { ok: false, error: 'could not attach debugger: ' + ((err && err.message) || err) };
  }

  try {
    // Coordinates are CSS pixels relative to the viewport -- the same units
    // getBoundingClientRect() returns, so no zoom conversion is needed.
    const at = { x, y, button: 'left', clickCount: 1 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...at, type: 'mousePressed' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...at, type: 'mouseReleased' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'trusted click failed: ' + ((err && err.message) || err) };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_) {
      // Already detached (tab closed, or the user dismissed the debug bar).
    }
  }
}

async function draft(payload) {
  try {
    const text = await generateReply({
      name: payload.name || 'them',
      systemPrompt: payload.systemPrompt || '',
      messages: payload.messages || [],
      mode: payload.mode || 'reply',
      quietDays: payload.quietDays || 0,
    });
    // null means "say nothing" and is a normal outcome, not a failure.
    return { text: typeof text === 'string' && text.trim() ? text.trim() : null };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

// Badge reflects how many drafts are waiting on you.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  updateBadge(changes.config.newValue);
});

function updateBadge(config) {
  if (!config) return;
  const waiting = (config.conversations || []).filter((c) => c.pending && !c.pending.approved).length;
  chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#7c5cff' });
}

chrome.runtime.onStartup.addListener(async () => {
  const { config } = await chrome.storage.local.get('config');
  updateBadge(config);
});
