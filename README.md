# pb-auto-reply

A Chrome extension that watches chosen conversations in Google Messages for web,
drafts replies with an LLM, and sends them once you approve — or on its own, if
you turn that on. It can also start a conversation that has gone quiet.

I made this when I realised my conversations with my brother checking in on him could 
be automated! This code isn't great quality, it was one shotted using Opus 5 (and all its
wonderful quirks) using a design doc to base it off.

This is a joke.

## Structure

```
manifest.json
src/selectors.js    DOM selectors for the Messages page
src/util.js         diffing, timestamp stripping, url parsing
src/lock.js         ensures only one tab runs the loop
src/store.js        chrome.storage accessors
src/dom.js          reading threads, typing, clicking send
src/content.js      the main loop
src/background.js   draft requests, trusted clicks, badge
src/reply.js        the OpenAI call and prompts
src/config.js       API key (gitignored; copy config.example.js)
popup/              on/off toggle, approve/edit/discard drafts
options/            conversation list and per-person prompts
tests.js            devtools snippets for poking at the Messages DOM
```
