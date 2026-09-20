import { generateReply } from './reply.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'draft') {
    draft(msg.payload).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'trustedClick') {
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

async function trustedClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    return { ok: false, error: 'could not attach debugger: ' + ((err && err.message) || err) };
  }

  try {
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
    return { text: typeof text === 'string' && text.trim() ? text.trim() : null };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

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
