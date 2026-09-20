var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.S = {

  sidebarName: 'mws-conversations-list h2 > span',

  messagePart: 'mws-message-part-content',
  messageIncomingClass: 'incoming',

  messageText: '.msg-content > div',

  threadScroller: 'mws-bottom-anchored',

  composer: 'mws-message-compose textarea',

  sendButton: 'mws-message-compose mw-message-send-button button',

  sidebarSnippet: null,
};

autoSender.REQUIRED_TO_SEND = ['composer', 'sendButton'];

autoSender.missingSelectors = function () {
  return autoSender.REQUIRED_TO_SEND.filter((k) => !autoSender.S[k]);
};

autoSender.selfCheck = function () {
  const out = {};
  for (const [name, sel] of Object.entries(autoSender.S)) {
    if (typeof sel !== 'string' || name === 'messageIncomingClass') continue;
    out[name] = { selector: sel, matches: document.querySelectorAll(sel).length };
  }
  for (const k of autoSender.REQUIRED_TO_SEND) {
    if (!autoSender.S[k]) out[k] = { selector: null, matches: 'NOT SET -- sending disabled' };
  }
  console.table(out);
  return out;
};
