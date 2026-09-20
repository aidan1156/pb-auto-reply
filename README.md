# pb-auto-reply

A Chrome extension that watches chosen conversations in Google Messages for web,
drafts replies with an LLM, and sends them once you approve — or on its own, if
you turn that on. It can also start a conversation that has gone quiet.

I made this when I realised my conversations with my brother checking in on him could 
be automated! This code isn't great quality, it was one shotted using Opus 5 (and all its
wonderful quirks) using a design doc to base it off.

This is a joke.

## Setup

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Copy `src/config.example.js` to `src/config.js` and put your OpenAI key in it.
   `config.js` is gitignored.
3. Open <https://messages.google.com/web> and sign in yourself.
4. Extension icon → **Settings** → **Add conversation**. Open the thread in
   Messages and paste its URL; the id is pulled out of it. Add a label and a
   system prompt describing how you want it to reply to that person.
5. Popup → **Monitoring on**. Leave "Send without asking me" off to start.

After editing a file: reload the extension on `chrome://extensions`, and refresh
the Messages tab as well if you changed anything under `src/` other than
`background.js`, `reply.js` or `config.js`. Content scripts are not re-injected
into pages that are already open, so skipping the refresh leaves the old code
running.

## How it works

A content script ticks about once a second. Everything funnels through one
`syncOpenThread()`, so "a message arrived in the thread we already had open" and
"we just switched threads" are the same code — the second just produces a bigger
delta.

```
tick:
  busy? -> return
  approved draft? -> open its conversation if needed, revalidate, send
  syncOpenThread()            verify URL, diff against cache, store
  maybeDraft()                newest message is theirs and unanswered -> draft
  unfinished business here? -> stay put
  pickNext()                  open whichever conversation has waited longest
  maybeNudge()                nothing else to do -> consider a quiet conversation
```

**Identity comes from the URL.** `/conversations/<id>` is the conversation id,
and sidebar rows link to the same id, so nothing depends on display names.
Renaming a contact breaks nothing.

**Diffing is content-anchored.** The DOM exposes no stable message ids, so the
last few cached messages are located inside the freshly-read list and everything
after them is the delta. Direction is part of the match, so "ok" from you and
"ok" from them never collide. If the anchor is off screen it scrolls up to find
it; if it still cannot line them up it re-caches and deliberately does **not**
draft.

**History is context, not a backlog to answer.** The first time a conversation is
seen, its messages are cached and marked as already handled. Replies only ever go
to messages that arrive afterwards.

**Outgoing messages are stored but never trigger a draft.** Your own replies —
including ones you send from your phone — land in the transcript so the draft
function sees them, and they cancel a draft that is waiting.

**Drafts are debounced and revalidated.** A draft waits ~4s in case they are
still typing, is discarded if they say something else while the model is
thinking, and is checked again at send time, so an approval sitting in the popup
for an hour cannot go out stale.

**Quiet conversations get an optional nudge.** After a week with no messages in
either direction, the draft function is called in nudge mode, whose prompt says
this is a small optional nudge to start a new conversation if the rest of the
prompt makes that relevant, and to return `NO_REPLY` otherwise. Drafting needs
only the cached transcript, so it works without opening the thread; approving one
sends it through the normal path, which opens the conversation, re-syncs, and
discards the nudge if anything arrived meanwhile. One attempt per quiet week,
whether it sends or declines. Nudges are lowest priority and run at most once a
minute.

Silence is measured from when the extension *saw* each message, not when it was
sent — bulk-loaded history is stamped with the moment it was cached. So a
conversation you start monitoring today will not be nudged until a week from
today, however old its last message really is.

**Only one tab ever runs.** At startup a tab announces itself on a
BroadcastChannel and listens for an already-running one. If one answers, the new
tab stays idle permanently — it does not take over when the other closes. Two
tabs would fight over the single visible thread and double-reply. Tabs opened at
the same instant break the tie on the lowest id, so exactly one wins. The console
says which tab is which.

**Sidebar detection uses the row preview, not the unread dot.** Reading a message
on your phone clears unread, but the preview still changes, so it is still
noticed.

## Sending

Google Messages ignores synthetic events — anything an extension dispatches
carries `isTrusted: false`, and the app does nothing with it. Clicks, full mouse
sequences and Enter keypresses were all tried and all ignored.

So the send button is clicked through **`chrome.debugger`**: the content script
measures where the button is, the service worker attaches to the tab, dispatches
a real mouse press and release at that point through the DevTools protocol, and
detaches. That is the only way an extension can produce trusted input, and it is
why the extension requests the `debugger` permission. Chrome shows a *"started
debugging this browser"* bar while attached, so it flashes briefly on each send.

Typing is separate and does not need this: `execCommand('insertText')` goes
through the browser's own editing path, falling back to the native value setter
plus a bubbling `input` event. Assigning `.value` alone does not notify the app
and would send an empty message.

The click happens once and is then verified — the composer emptying, or the
message appearing as a bubble. It is never retried automatically, because a
click that landed unseen would otherwise send the message twice. Failures surface
in the popup instead.

## Selectors

`src/selectors.js` holds everything the extension knows about the page. When
Google reskins the app, that is the only file that should need changing. Run
`autoSender.selfCheck()` in the Messages tab console to see which selectors
currently resolve.

`sidebarSnippet` is still null and optional. Left that way, the whole row's text
is used with timestamps stripped, which works but triggers more re-checks than it
needs to.

## The reply function

`generateReply` in `src/reply.js` takes
`{ name, systemPrompt, messages, mode, quietDays }` and returns the message to
send, or `null` to stay quiet. Keep the null path — without it the bot answers
"k" with a paragraph.

`mode` is `reply` or `nudge`, and picks a line from `MODE_PROMPTS`, which is
appended to that conversation's own system prompt. Both are yours to tune:

- **reply** — only reply if a reply is actually needed; do not reply
  unnecessarily.
- **nudge** — the conversation has been quiet for `{days}` days; optionally start
  a new one if that seems natural.

It calls OpenAI's chat completions API from the service worker, the only place in
an extension where a network call works — a fetch from the content script
inherits messages.google.com's CSP and is blocked. The model is a constant at the
top of the file. A refusal or a content-filtered completion counts as "stay
quiet" rather than an error.

Every draft sends the whole cached transcript, which only grows. On a long-lived
conversation that becomes the dominant cost, well ahead of the choice of model.

## Layout

```
manifest.json
src/selectors.js     all DOM knowledge — the file to edit when Google reskins
src/util.js          diff/anchor logic, timestamp stripping, url parsing
src/lock.js          BroadcastChannel tab lock — only one tab runs the loop
src/store.js         chrome.storage layout and accessors
src/dom.js           reading the thread and sidebar, typing, clicking send
src/content.js       the loop
src/background.js    draft requests, trusted clicks, toolbar badge
src/reply.js         your generateReply — the OpenAI call and both prompts
src/config.js        your API key (gitignored; copy config.example.js)
popup/               on/off, auto-accept, approve or edit or discard drafts
options/             conversation list, per-person system prompts
tools/inspect-console.js   paste into devtools to identify page selectors
tools/test-diff.mjs        node tools/test-diff.mjs
```

The content-script files share one global, `autoSender`, and are listed in
`manifest.json` in dependency order. They are not ES modules — MV3 content
scripts cannot be. `background.js` and `reply.js` are modules and use real
imports.

## Settings

Stored under `config.settings` in `chrome.storage.local`. The two toggles are in
the popup; the rest are edited in code or from the service worker console.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch. Off means the loop does nothing at all. |
| `autoAccept` | `false` | Send drafts without asking. Applies to nudges too. |
| `tickMs` | `1000` | Loop interval. |
| `debounceMs` | `4000` | Quiet period before drafting, in case they are still typing. |
| `backfillRounds` | `8` | How many times to scroll up when caching history. |
| `nudgeAfterDays` | `7` | Silence needed before a conversation may be nudged. |

To try a nudge without waiting a week, run this in the service worker console
(the *service worker* link on the extension card), then set it back to `7`:

```js
chrome.storage.local.get('config').then(({ config }) => { config.settings.nudgeAfterDays = 0.001; chrome.storage.local.set({ config }); })
```

## Notes

- Opening a thread marks it read. With approval mode on, they see a read receipt
  before your reply arrives.
- Chrome throttles timers in background tabs. Once the Messages tab has been
  hidden for about five minutes, the loop can drop from once a second to roughly
  once a minute.
- `node tools/test-diff.mjs` covers the diff/anchor logic, timestamp stripping,
  url parsing and the tab-lock tie-break. The rest needs a browser.
