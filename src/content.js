var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

const state = {
  busy: false,
  debounceUntil: {},
  inFlight: {},
  lastNudgeCheck: 0,
  nudgeErrorUntil: {},
};

async function tick() {
  if (state.busy) return;
  state.busy = true;
  try {
    const config = await autoSender.getConfig();
    if (!config.settings.enabled) {
      await autoSender.setRuntime({ status: 'disabled', currentConvId: autoSender.dom.currentConvId() });
      return;
    }
    await step(config);
  } catch (err) {
    autoSender.warn('tick failed', err);
    await autoSender.setRuntime({ status: 'error', lastError: String((err && err.message) || err) });
  } finally {
    state.busy = false;
  }
}

async function step(config) {
  await autoSender.setRuntime({ status: 'running', currentConvId: autoSender.dom.currentConvId(), lastError: null });

  const approved = config.conversations.find((c) => c.pending && c.pending.approved);
  if (approved) return handleApproved(config, approved);

  await syncOpenThread(config);

  const drafted = await maybeDraft(config);
  if (drafted) return;

  const cur = autoSender.dom.currentConvId();
  if (cur && (state.inFlight[cur] || Date.now() < (state.debounceUntil[cur] || 0))) return;

  const moved = await pickNext(config);
  if (moved) return;

  await maybeNudge(config);
}

async function syncOpenThread(config) {
  const convId = autoSender.dom.currentConvId();
  if (!convId) return;

  const conv = autoSender.getConversation(config, convId);
  if (!conv || !conv.enabled) return;

  await autoSender.dom.waitForThreadSettled();
  if (autoSender.dom.currentConvId() !== convId) return;

  const cached = await autoSender.getMessages(convId);

  if (!cached.length) {
    autoSender.log('seeding', conv.label || convId);
    const all = await autoSender.dom.backfill(config.settings.backfillRounds);
    if (autoSender.dom.currentConvId() !== convId) return;
    const seeded = await autoSender.replaceMessages(convId, all);
    await markBacklogHandled(convId, seeded);
    await noteSnippet(convId);
    await autoSender.pushLog({ convId, kind: 'seed', text: 'cached ' + all.length + ' messages' });
    return;
  }

  let visible = autoSender.dom.readVisibleMessages();
  let diff = autoSender.diffFromAnchor(cached, visible);

  if (!diff.matched) {
    for (let i = 0; i < config.settings.backfillRounds && !diff.matched; i++) {
      if (!(await autoSender.dom.scrollUpOnce())) break;
      if (autoSender.dom.currentConvId() !== convId) return;
      visible = autoSender.dom.readVisibleMessages();
      diff = autoSender.diffFromAnchor(cached, visible);
    }
  }

  if (!diff.matched) {
    autoSender.warn('lost anchor in', convId, '- reseeding');
    const reseeded = await autoSender.replaceMessages(convId, visible);
    await markBacklogHandled(convId, reseeded);
    await noteSnippet(convId);
    await autoSender.pushLog({ convId, kind: 'warn', text: 'lost position in thread, re-cached' });
    return;
  }

  if (diff.delta.length) {
    await autoSender.appendMessages(convId, diff.delta);
    await noteSnippet(convId);
    const last = diff.delta[diff.delta.length - 1];
    autoSender.log('delta', conv.label || convId, diff.delta.length, 'newest incoming:', last.incoming);

    if (last.incoming) {
      state.debounceUntil[convId] = Date.now() + config.settings.debounceMs;
    } else {
      await autoSender.updateConversation(convId, (c) => { c.pending = null; });
    }
  } else {
    await noteSnippet(convId);
  }
}

async function markBacklogHandled(convId, stored) {
  const last = stored[stored.length - 1];
  await autoSender.updateConversation(convId, (c) => {
    c.lastHandledSeq = last ? last.seq : null;
  });
}

async function noteSnippet(convId) {
  const row = autoSender.dom.readSidebarRows().find((r) => r.id === convId);
  await autoSender.updateConversation(convId, (c) => {
    if (row) c.lastSeenSnippet = row.snippet;
    c.firstSeenDiffAt = null;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_CHECK_EVERY_MS = 60 * 1000;
const NUDGE_ERROR_BACKOFF_MS = 60 * 60 * 1000;

async function maybeDraft(config) {
  const convId = autoSender.dom.currentConvId();
  if (!convId) return false;

  const conv = autoSender.getConversation(config, convId);
  if (!conv || !conv.enabled || conv.pending || state.inFlight[convId]) return false;
  if (Date.now() < (state.debounceUntil[convId] || 0)) return false;

  const msgs = await autoSender.getMessages(convId);
  const tail = msgs[msgs.length - 1];
  if (!tail || !tail.incoming) return false;
  if (conv.lastHandledSeq === tail.seq) return false;

  const outcome = await requestDraft(config, conv, msgs, { mode: 'reply' });
  return outcome === 'pending';
}

async function maybeNudge(config) {
  const now = Date.now();
  if (now - state.lastNudgeCheck < NUDGE_CHECK_EVERY_MS) return false;
  state.lastNudgeCheck = now;

  const quietMs = (config.settings.nudgeAfterDays || 7) * DAY_MS;

  for (const conv of config.conversations) {
    if (!conv.enabled || conv.pending || state.inFlight[conv.id]) continue;
    if (now < (state.nudgeErrorUntil[conv.id] || 0)) continue;
    if (conv.lastNudgeAt && now - conv.lastNudgeAt < quietMs) continue;

    const msgs = await autoSender.getMessages(conv.id);
    const tail = msgs[msgs.length - 1];
    if (!tail || now - tail.at < quietMs) continue;

    const quietDays = Math.floor((now - tail.at) / DAY_MS);
    autoSender.log('nudge check', conv.label || conv.id, quietDays, 'days quiet');

    const outcome = await requestDraft(config, conv, msgs, { mode: 'nudge', quietDays });
    if (outcome === 'error') {
      state.nudgeErrorUntil[conv.id] = now + NUDGE_ERROR_BACKOFF_MS;
    } else {
      await autoSender.updateConversation(conv.id, (c) => { c.lastNudgeAt = now; });
    }
    return outcome === 'pending';
  }
  return false;
}

async function requestDraft(config, conv, msgs, { mode, quietDays = 0 }) {
  const convId = conv.id;
  const tail = msgs[msgs.length - 1];

  state.inFlight[convId] = true;
  await autoSender.setRuntime({ status: mode === 'nudge' ? 'nudging' : 'drafting' });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'draft',
      payload: {
        name: conv.label || convId,
        systemPrompt: conv.systemPrompt || '',
        messages: msgs.map((m) => ({ incoming: m.incoming, text: m.text })),
        mode,
        quietDays,
      },
    });

    if (res && res.error) {
      await autoSender.pushLog({ convId, kind: 'error', text: res.error });
      return 'error';
    }

    const nowMsgs = await autoSender.getMessages(convId);
    const nowTail = nowMsgs[nowMsgs.length - 1];
    if (!nowTail || nowTail.seq !== tail.seq) {
      autoSender.log('draft went stale, discarding');
      return 'stale';
    }

    if (!res || !res.text) {
      if (mode === 'reply') {
        await autoSender.updateConversation(convId, (c) => { c.lastHandledSeq = tail.seq; });
      }
      await autoSender.pushLog({
        convId,
        kind: 'quiet',
        text: mode === 'nudge' ? 'decided not to start a conversation' : 'chose not to reply',
      });
      return 'quiet';
    }

    const autoAccept = config.settings.autoAccept;
    await autoSender.updateConversation(convId, (c) => {
      c.pending = {
        id: convId + ':' + tail.seq + ':' + Date.now(),
        text: res.text,
        basedOnSeq: tail.seq,
        createdAt: Date.now(),
        approved: autoAccept,
        mode,
      };
    });
    await autoSender.pushLog({
      convId,
      kind: mode === 'nudge' ? 'nudge' : autoAccept ? 'auto' : 'draft',
      text: res.text,
    });
    return 'pending';
  } finally {
    state.inFlight[convId] = false;
  }
}

async function handleApproved(config, conv) {
  if (autoSender.dom.currentConvId() !== conv.id) {
    const opened = await autoSender.dom.openConversation(conv.id);
    if (!opened.ok) await autoSender.pushLog({ convId: conv.id, kind: 'error', text: opened.error });
    return;
  }

  await syncOpenThread(config);

  const fresh = await autoSender.getConfig();
  const pending = (autoSender.getConversation(fresh, conv.id) || {}).pending;
  if (!pending) return;

  const msgs = await autoSender.getMessages(conv.id);
  const tail = msgs[msgs.length - 1];

  if (!tail || tail.seq !== pending.basedOnSeq) {
    autoSender.log('approved draft is stale, discarding');
    await autoSender.updateConversation(conv.id, (c) => { c.pending = null; });
    await autoSender.pushLog({ convId: conv.id, kind: 'stale', text: 'draft discarded, conversation moved on' });
    return;
  }

  await autoSender.setRuntime({ status: 'sending' });
  const res = await autoSender.dom.send(conv.id, pending.text);
  if (res.ok) {
    await autoSender.updateConversation(conv.id, (c) => {
      c.pending = null;
      c.lastHandledSeq = pending.basedOnSeq;
    });
    await autoSender.pushLog({ convId: conv.id, kind: 'sent', text: '[via ' + res.via + '] ' + pending.text });
  } else {
    await autoSender.updateConversation(conv.id, (c) => {
      c.pending = Object.assign({}, c.pending, { approved: false, error: res.error });
    });
    await autoSender.pushLog({ convId: conv.id, kind: 'error', text: res.error });
  }
}

async function pickNext(config) {
  const rows = autoSender.dom.readSidebarRows();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cur = autoSender.dom.currentConvId();
  const now = Date.now();

  const candidates = [];
  for (const conv of config.conversations) {
    if (!conv.enabled || conv.id === cur) continue;
    const row = byId.get(conv.id);
    if (!row) continue;
    if (row.snippet && row.snippet !== conv.lastSeenSnippet) candidates.push(conv);
  }

  for (const conv of candidates) {
    if (!conv.firstSeenDiffAt) {
      await autoSender.updateConversation(conv.id, (c) => { c.firstSeenDiffAt = now; });
      conv.firstSeenDiffAt = now;
    }
  }

  if (!candidates.length) {
    if (!cur || !autoSender.getConversation(config, cur)) {
      const first = config.conversations.find((c) => c.enabled && byId.has(c.id));
      if (first) {
        await autoSender.dom.openConversation(first.id);
        return true;
      }
    }
    return false;
  }

  candidates.sort((a, b) => (a.firstSeenDiffAt || 0) - (b.firstSeenDiffAt || 0));
  const next = candidates[0];
  autoSender.log('switching to', next.label || next.id);
  const opened = await autoSender.dom.openConversation(next.id);
  if (!opened.ok) await autoSender.pushLog({ convId: next.id, kind: 'error', text: opened.error });
  return true;
}

(async function boot() {
  const mine = await autoSender.claimTab();
  if (!mine) {
    autoSender.warn('another Google Messages tab is already running pb-auto-reply. This tab will stay idle.');
    return;
  }

  const config = await autoSender.getConfig();
  const missing = autoSender.missingSelectors();
  autoSender.log('this tab is running the loop. Missing selectors:', missing.length ? missing : 'none');
  if (missing.length) {
    autoSender.warn('sending is disabled until src/selectors.js is filled in. Run autoSender.selfCheck() to inspect.');
  }
  setInterval(tick, config.settings.tickMs);
})();
