// The popup is destroyed the moment it closes, so it holds no state and sends
// nothing itself. It reads chrome.storage and writes intent back; the content
// script, which is long-lived, does the actual work.

const $ = (id) => document.getElementById(id);

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return config || { settings: {}, conversations: [], runtime: {}, log: [] };
}

async function patchConfig(fn) {
  const config = await getConfig();
  fn(config);
  await chrome.storage.local.set({ config });
}

async function render() {
  const config = await getConfig();
  const settings = config.settings || {};

  $('enabled').checked = !!settings.enabled;
  $('autoAccept').checked = !!settings.autoAccept;

  await renderStatus(config);
  renderPending(config);
  renderLog(config);
}

async function renderStatus(config) {
  const el = $('status');
  const tabs = await chrome.tabs.query({ url: 'https://messages.google.com/web/*' });

  if (!tabs.length) {
    el.className = 'status bad';
    el.textContent = 'No Google Messages tab open. Open messages.google.com/web to run.';
    return;
  }

  const runtime = config.runtime || {};
  const conv = (config.conversations || []).find((c) => c.id === runtime.currentConvId);
  const where = conv ? conv.label : runtime.currentConvId ? 'an unmonitored conversation' : 'no conversation';

  if (runtime.lastError) {
    el.className = 'status bad';
    el.textContent = 'Error: ' + runtime.lastError;
    return;
  }

  el.className = 'status';
  el.textContent = (runtime.status || 'idle') + ' · viewing ' + where;
}

function renderPending(config) {
  const host = $('pending');
  host.textContent = '';

  const waiting = (config.conversations || []).filter((c) => c.pending && !c.pending.approved);
  if (!waiting.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Nothing to approve.';
    host.appendChild(p);
    return;
  }

  for (const conv of waiting) {
    const card = document.createElement('div');
    card.className = 'card';

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = (conv.label || conv.id) + (conv.pending.mode === 'nudge' ? ' · conversation starter' : '');
    card.appendChild(who);

    // Editable: fixing a word beats rejecting and waiting for a regenerate.
    const box = document.createElement('textarea');
    box.value = conv.pending.text;
    card.appendChild(box);

    if (conv.pending.error) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = conv.pending.error;
      card.appendChild(err);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.className = 'primary';
    approve.textContent = 'Send';
    approve.onclick = async () => {
      const text = box.value.trim();
      if (!text) return;
      await patchConfig((c) => {
        const target = c.conversations.find((x) => x.id === conv.id);
        if (target && target.pending) {
          target.pending.text = text;
          target.pending.error = null;
          target.pending.approved = true;
        }
      });
    };

    const reject = document.createElement('button');
    reject.textContent = 'Discard';
    reject.onclick = async () => {
      await patchConfig((c) => {
        const target = c.conversations.find((x) => x.id === conv.id);
        if (target && target.pending) {
          // Remember we decided about this message, so it is not re-drafted.
          target.lastHandledSeq = target.pending.basedOnSeq;
          target.pending = null;
        }
      });
    };

    actions.appendChild(approve);
    actions.appendChild(reject);
    card.appendChild(actions);
    host.appendChild(card);
  }
}

function renderLog(config) {
  const host = $('log');
  host.textContent = '';

  const entries = (config.log || []).slice(0, 8);
  if (!entries.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Nothing yet.';
    host.appendChild(p);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = entry.kind;
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = entry.text;
    txt.title = entry.text;
    row.appendChild(kind);
    row.appendChild(txt);
    host.appendChild(row);
  }
}

$('enabled').onchange = (e) =>
  patchConfig((c) => { c.settings = Object.assign({}, c.settings, { enabled: e.target.checked }); });

$('autoAccept').onchange = (e) =>
  patchConfig((c) => { c.settings = Object.assign({}, c.settings, { autoAccept: e.target.checked }); });

$('options').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) render();
});

render();
