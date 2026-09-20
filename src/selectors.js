// All DOM knowledge about Google Messages lives here. When Google reskins the
// app, this is the only file that should need changing.
//
// CONFIRMED entries came from tests.js (verified in devtools on a live page).
// UNKNOWN entries are null on purpose -- they have NOT been guessed. Fill them
// in from tools/inspect-console.js output. Anything that needs a null selector
// fails loudly instead of doing something unpredictable.

var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.S = {
  // ---- CONFIRMED -----------------------------------------------------------

  // Conversation name in a sidebar row. The row itself is found by walking up
  // to the nearest <a href=".../conversations/<id>">, so no row selector is
  // needed -- the href is the conversation id.
  sidebarName: 'mws-conversations-list h2 > span',

  // One message bubble. Carries class "incoming" when it is from them.
  messagePart: 'mws-message-part-content',
  messageIncomingClass: 'incoming',

  // Text inside a message bubble. Null for attachments/images.
  messageText: '.msg-content > div',

  // Scroll container for the open thread. scrollBy(0, -N) loads older messages.
  threadScroller: 'mws-bottom-anchored',

  // ---- UNKNOWN: fill these in ---------------------------------------------

  // The box you type a message into (textarea or contenteditable).
  // Sending is disabled until this is set.
  composer: 'mws-message-compose textarea',

  // The button that sends the typed message.
  // Sending is disabled until this is set.
  sendButton: 'mws-message-compose mw-message-send-button button',

  // Optional. The element inside a sidebar row holding the message preview.
  // If left null, the whole row's text is used with timestamps stripped, which
  // works but is more prone to spurious "this conversation changed" triggers.
  sidebarSnippet: null,
};

// Selectors that must be present before the extension will send anything.
autoSender.REQUIRED_TO_SEND = ['composer', 'sendButton'];

autoSender.missingSelectors = function () {
  return autoSender.REQUIRED_TO_SEND.filter((k) => !autoSender.S[k]);
};

// Paste autoSender.selfCheck() into the devtools console on an open conversation to see
// which selectors currently resolve.
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
