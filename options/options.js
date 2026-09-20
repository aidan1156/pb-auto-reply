const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  settings: {
    enabled: false,
    autoAccept: false,
    tickMs: 1000,
    debounceMs: 4000,
    backfillRounds: 8,
    stickyQuietMs: 120000,
    nudgeAfterDays: 7,
  },
  conversations: [],
  runtime: {},
  log: [],
};

let working = null;

async function load() {
  const { config } = await chrome.storage.local.get('config');
  working = Object.assign({}, DEFAULTS, config || {});
  working.settings = Object.assign({}, DEFAULTS.settings, working.settings || {});
  working.conversations = (working.conversations || []).map((c) => Object.assign({}, c));
  render();
}

function render() {
  const host = $('list');
  host.textContent = '';

  if (!working.conversations.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No conversations yet.';
    host.appendChild(p);
    return;
  }

  working.conversations.forEach((conv, i) => {
    const card = document.createElement('div');
    card.className = 'card';

    card.appendChild(field('Label (yours, for display only)', textInput(conv.label || '', (v) => (conv.label = v))));
    card.appendChild(field('Conversation id or URL', textInput(conv.id || '', (v) => (conv.id = normaliseId(v)))));

    const prompt = document.createElement('textarea');
    prompt.className = 'prompt';
    prompt.value = conv.systemPrompt || '';
    prompt.oninput = () => (conv.systemPrompt = prompt.value);
    card.appendChild(field('System prompt for this person', prompt));

    const row = document.createElement('div');
    row.className = 'actions';

    const toggle = document.createElement('label');
    toggle.className = 'switch';
    toggle.style.flex = '1';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = conv.enabled !== false;
    cb.onchange = () => (conv.enabled = cb.checked);
    const span = document.createElement('span');
    span.textContent = 'Monitor this one';
    toggle.appendChild(cb);
    toggle.appendChild(span);

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = () => {
      working.conversations.splice(i, 1);
      render();
    };

    row.appendChild(toggle);
    row.appendChild(remove);
    card.appendChild(row);
    host.appendChild(card);
  });
}

function field(labelText, control) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

function textInput(value, onInput) {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value;
  el.oninput = () => onInput(el.value.trim());
  return el;
}

function normaliseId(value) {
  const m = String(value).match(/\/conversations\/([^/?#]+)/);
  return m ? m[1] : value;
}

$('add').onclick = () => {
  working.conversations.push({
    id: '',
    label: '',
    enabled: true,
    systemPrompt: '',
    lastSeenSnippet: null,
    firstSeenDiffAt: null,
    lastHandledSeq: null,
    pending: null,
  });
  render();
};

$('save').onclick = async () => {
  const bad = working.conversations.filter((c) => !c.id);
  if (bad.length) {
    $('saved').textContent = 'Every conversation needs an id.';
    return;
  }

  const { config } = await chrome.storage.local.get('config');
  const live = config || {};
  const merged = Object.assign({}, live, {
    settings: Object.assign({}, live.settings, working.settings),
    conversations: working.conversations.map((c) => {
      const existing = (live.conversations || []).find((x) => x.id === c.id) || {};
      return Object.assign({}, existing, c);
    }),
  });

  await chrome.storage.local.set({ config: merged });
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 2000);
};

load();
