var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

// One tick at a time. Everything funnels through syncOpenThread(), so "a message
// arrived in the thread we already had open" and "we just switched threads" are
// the same code path -- the second just produces a bigger delta.

const state = {
  busy: false,
  debounceUntil: {}, // convId -> timestamp; wait for them to finish typing
  inFlight: {},      // convId -> true while a draft request is out
  lastNudgeCheck: 0,
  nudgeErrorUntil: {}, // convId -> timestamp; back off after a failed nudge
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

  // 1. An approved draft is queued work -- it may belong to a conversation that
  //    is not open, so it takes priority and pulls us to that thread.
  const approved = config.conversations.find((c) => c.pending && c.pending.approved);
  if (approved) return handleApproved(config, approved);

  // 2. Reconcile whatever thread is on screen.
  await syncOpenThread(config);

  // 3. Draft if the latest message is theirs and we have not handled it.
  const drafted = await maybeDraft(config);
  if (drafted) return;

  // 4. Stay put while there is unfinished business here (seconds, not hours --
  //    a draft waiting on you does not pin the loop, it waits in the queue).
  const cur = autoSender.dom.currentConvId();
  if (cur && (state.inFlight[cur] || Date.now() < (state.debounceUntil[cur] || 0))) return;

  // 5. Otherwise move to whichever monitored conversation has waited longest.
  const moved = await pickNext(config);
  if (moved) return;

  // 6. Nothing live to do. Consider starting a conversation that has gone quiet.
  await maybeNudge(config);
}

// ---- syncing ----------------------------------------------------------------

async function syncOpenThread(config) {
  const convId = autoSender.dom.currentConvId();
  if (!convId) return;

  const conv = autoSender.getConversation(config, convId);
  if (!conv || !conv.enabled) return;

  await autoSender.dom.waitForThreadSettled();
  // Re-check after waiting: the user may have clicked elsewhere meanwhile, and
  // attributing these messages to the wrong conversation would corrupt the cache.
  if (autoSender.dom.currentConvId() !== convId) return;

  const cached = await autoSender.getMessages(convId);

  // First time we have ever looked at this conversation: load history and store
  // it without drafting. We reply to what arrives next, not to the backlog.
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

  // Anchor not on screen -- scroll back until we find where we left off.
  if (!diff.matched) {
    for (let i = 0; i < config.settings.backfillRounds && !diff.matched; i++) {
      if (!(await autoSender.dom.scrollUpOnce())) break;
      if (autoSender.dom.currentConvId() !== convId) return;
      visible = autoSender.dom.readVisibleMessages();
      diff = autoSender.diffFromAnchor(cached, visible);
    }
  }

  if (!diff.matched) {
    // We cannot line up old and new. Reseeding is safe; drafting off a history
    // we do not understand is not, so this path never produces a reply.
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
      // Wait for them to finish -- people send three messages in a row.
      state.debounceUntil[convId] = Date.now() + config.settings.debounceMs;
    } else {
      // We, or you from your phone, spoke last. Drop any draft in flight.
      await autoSender.updateConversation(convId, (c) => { c.pending = null; });
    }
  } else {
    await noteSnippet(convId);
  }
}

// History we loaded in bulk is context, not something to answer. Without this,
// the draft step on the same tick sees an unanswered message at the end of the
// backlog and replies to it.
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

// ---- drafting ---------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_CHECK_EVERY_MS = 60 * 1000;
const NUDGE_ERROR_BACKOFF_MS = 60 * 60 * 1000;

// Reply mode: the open conversation has an unanswered message from them.
async function maybeDraft(config) {
  const convId = autoSender.dom.currentConvId();
  if (!convId) return false;

  const conv = autoSender.getConversation(config, convId);
  if (!conv || !conv.enabled || conv.pending || state.inFlight[convId]) return false;
  if (Date.now() < (state.debounceUntil[convId] || 0)) return false;

  const msgs = await autoSender.getMessages(convId);
  const tail = msgs[msgs.length - 1];
  if (!tail || !tail.incoming) return false;
  if (conv.lastHandledSeq === tail.seq) return false; // already decided about this one

  const outcome = await requestDraft(config, conv, msgs, { mode: 'reply' });
  return outcome === 'pending';
}

// Nudge mode: a monitored conversation has gone quiet for a week or more, in
// either direction. Drafting only needs the cached transcript, so this works on
// conversations that are not open -- a quiet thread never changes in the sidebar,
// so the loop would otherwise never visit it. If a nudge is approved, the normal
// send path opens the conversation, re-syncs, and discards it if anything new
// arrived in the meantime.
//
// At most one attempt per quiet period: after a nudge (sent or declined) the
// next one is another full week away.
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
    return outcome === 'pending'; // one per check
  }
  return false;
}

// Shared by both modes. Returns 'pending' (a draft is waiting or approved),
// 'quiet' (the model chose not to send), 'stale' (the conversation moved on while
// we were drafting), or 'error'.
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

    // Did they say something else while we were thinking? If so this draft is
    // answering a question that has moved on -- bin it and start again.
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

// ---- sending ----------------------------------------------------------------

async function handleApproved(config, conv) {
  if (autoSender.dom.currentConvId() !== conv.id) {
    const opened = await autoSender.dom.openConversation(conv.id);
    if (!opened.ok) await autoSender.pushLog({ convId: conv.id, kind: 'error', text: opened.error });
    return; // next tick sends
  }

  await syncOpenThread(config);

  const fresh = await autoSender.getConfig();
  const pending = (autoSender.getConversation(fresh, conv.id) || {}).pending;
  if (!pending) return;

  const msgs = await autoSender.getMessages(conv.id);
  const tail = msgs[msgs.length - 1];

  // Checked again here, not just at draft time: an approval can sit for hours.
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

// ---- scheduling -------------------------------------------------------------

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
    // Compare the row preview against the one we last acted on. This beats the
    // unread dot, which clears when you read the message on your phone.
    if (row.snippet && row.snippet !== conv.lastSeenSnippet) candidates.push(conv);
  }

  // Stamp when we first noticed, so the queue is first-come-first-served rather
  // than letting a chatty conversation keep jumping ahead.
  for (const conv of candidates) {
    if (!conv.firstSeenDiffAt) {
      await autoSender.updateConversation(conv.id, (c) => { c.firstSeenDiffAt = now; });
      conv.firstSeenDiffAt = now;
    }
  }

  // Nothing waiting: make sure we are parked on a monitored conversation.
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

// ---- boot -------------------------------------------------------------------

(async function boot() {
  // Stand down entirely if another Messages tab is already running the loop.
  // Two tabs would fight over the single visible thread and double-reply.
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
