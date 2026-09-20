var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.dom = {};

autoSender.dom.currentConvId = function () {
  return autoSender.convIdFromUrl(location.href);
};

autoSender.dom.readVisibleMessages = function () {
  const S = autoSender.S;
  return [...document.querySelectorAll(S.messagePart)].map((el) => {
    const textEl = el.querySelector(S.messageText);
    const text = textEl ? textEl.innerText.trim() : '';
    return {
      incoming: el.classList.contains(S.messageIncomingClass),
      text: text || '[attachment]',
    };
  });
};

autoSender.dom.threadFingerprint = function () {
  const msgs = autoSender.dom.readVisibleMessages();
  const last = msgs[msgs.length - 1];
  return `${autoSender.dom.currentConvId()}|${msgs.length}|${last ? last.text : ''}`;
};

autoSender.dom.waitForThreadSettled = function () {
  return autoSender.waitForStable(autoSender.dom.threadFingerprint);
};

autoSender.dom.scrollUpOnce = async function () {
  const scroller = document.querySelector(autoSender.S.threadScroller);
  if (!scroller) return false;
  const before = document.querySelectorAll(autoSender.S.messagePart).length;
  scroller.scrollBy(0, -800);
  await autoSender.dom.waitForThreadSettled();
  return document.querySelectorAll(autoSender.S.messagePart).length > before;
};

autoSender.dom.backfill = async function (rounds) {
  for (let i = 0; i < rounds; i++) {
    const grew = await autoSender.dom.scrollUpOnce();
    if (!grew) break;
  }
  return autoSender.dom.readVisibleMessages();
};

autoSender.dom.readSidebarRows = function () {
  const rows = [];
  for (const nameEl of document.querySelectorAll(autoSender.S.sidebarName)) {
    const link = nameEl.closest('a[href*="/conversations/"]');
    if (!link) continue;
    const id = autoSender.convIdFromUrl(link.getAttribute('href'));
    if (!id) continue;

    let snippet;
    if (autoSender.S.sidebarSnippet) {
      const el = link.querySelector(autoSender.S.sidebarSnippet);
      snippet = el ? el.innerText : '';
    } else {
      snippet = autoSender.stripTimestamps(link.innerText.replace(nameEl.innerText, ''));
    }

    rows.push({ id, name: nameEl.innerText.trim(), snippet: (snippet || '').trim() });
  }
  return rows;
};

autoSender.dom.openConversation = async function (convId) {
  const link = document.querySelector(`a[href*="/conversations/${convId}"]`);
  if (!link) return { ok: false, error: 'conversation not in sidebar' };
  link.click();
  await autoSender.dom.waitForThreadSettled();
  if (autoSender.dom.currentConvId() !== convId) {
    return { ok: false, error: 'opened a different conversation' };
  }
  return { ok: true };
};

autoSender.dom.setComposerText = function (el, text) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;

  if (proto) {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  } else {
    el.focus();
    el.textContent = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

autoSender.dom.visible = function (selector) {
  return [...document.querySelectorAll(selector)].find((el) => el.offsetParent !== null) || null;
};

autoSender.dom.typeInto = function (el, text) {
  el.focus();
  if (el.select) el.select();
  let typed = false;
  try {
    typed = document.execCommand('insertText', false, text);
  } catch (_) {
    typed = false;
  }
  const value = 'value' in el ? el.value : el.textContent;
  if (!typed || value !== text) {
    autoSender.dom.setComposerText(el, text);
    return 'native-setter';
  }
  return 'insertText';
};

autoSender.dom.sendAccepted = function (composer, text, beforeCount) {
  const value = ('value' in composer ? composer.value : composer.textContent) || '';
  if (!value.trim()) return true;
  const msgs = autoSender.dom.readVisibleMessages();
  return msgs.slice(beforeCount).some((m) => !m.incoming && m.text === text);
};

autoSender.dom.waitForAccepted = async function (composer, text, beforeCount, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (autoSender.dom.sendAccepted(composer, text, beforeCount)) return true;
    await autoSender.sleep(100);
  }
  return false;
};

autoSender.dom.send = async function (convId, text) {
  const missing = autoSender.missingSelectors();
  if (missing.length) {
    return { ok: false, error: `selectors not set: ${missing.join(', ')}` };
  }
  if (autoSender.dom.currentConvId() !== convId) {
    return { ok: false, error: 'wrong conversation open' };
  }

  const composer = autoSender.dom.visible(autoSender.S.composer);
  if (!composer) return { ok: false, error: 'composer not found (no visible match)' };

  const before = autoSender.dom.readVisibleMessages().length;
  autoSender.dom.typeInto(composer, text);
  await autoSender.sleep(200);

  const button = autoSender.dom.visible(autoSender.S.sendButton);
  if (!button) return { ok: false, error: 'send button not found (no visible match)' };

  button.scrollIntoView({ block: 'nearest' });
  const r = button.getBoundingClientRect();
  const res = await chrome.runtime.sendMessage({
    type: 'trustedClick',
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  });
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || 'trusted click failed' };
  }

  if (await autoSender.dom.waitForAccepted(composer, text, before, 5000)) {
    autoSender.log('sent via trusted click');
    return { ok: true, via: 'debugger' };
  }
  return {
    ok: false,
    error: 'clicked send but the message did not go out (composer still has the text)',
  };
};
