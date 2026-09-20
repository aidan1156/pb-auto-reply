var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.DEFAULT_CONFIG = {
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
  runtime: { currentConvId: null, status: 'idle', lastError: null, updatedAt: 0 },
  log: [],
};

autoSender.getConfig = async function () {
  const { config } = await chrome.storage.local.get('config');
  if (!config) return structuredClone(autoSender.DEFAULT_CONFIG);
  return {
    ...autoSender.DEFAULT_CONFIG,
    ...config,
    settings: { ...autoSender.DEFAULT_CONFIG.settings, ...(config.settings || {}) },
    runtime: { ...autoSender.DEFAULT_CONFIG.runtime, ...(config.runtime || {}) },
  };
};

autoSender.setConfig = async function (config) {
  await chrome.storage.local.set({ config });
};

autoSender.updateConfig = async function (fn) {
  const config = await autoSender.getConfig();
  const next = (await fn(config)) || config;
  await autoSender.setConfig(next);
  return next;
};

autoSender.getConversation = function (config, convId) {
  return config.conversations.find((c) => c.id === convId) || null;
};

autoSender.updateConversation = async function (convId, fn) {
  return autoSender.updateConfig(async (config) => {
    const conv = autoSender.getConversation(config, convId);
    if (conv) await fn(conv);
    return config;
  });
};

autoSender.getMessages = async function (convId) {
  const key = 'msgs:' + convId;
  const got = await chrome.storage.local.get(key);
  return got[key] || [];
};

autoSender.appendMessages = async function (convId, newOnes) {
  const key = 'msgs:' + convId;
  const existing = await autoSender.getMessages(convId);
  let seq = existing.length ? existing[existing.length - 1].seq + 1 : 0;
  const stamped = newOnes.map((m) => ({ ...m, seq: seq++, at: Date.now() }));
  await chrome.storage.local.set({ [key]: existing.concat(stamped) });
  return stamped;
};

autoSender.replaceMessages = async function (convId, all) {
  const key = 'msgs:' + convId;
  const stamped = all.map((m, i) => ({ ...m, seq: i, at: Date.now() }));
  await chrome.storage.local.set({ [key]: stamped });
  return stamped;
};

autoSender.pushLog = async function (entry) {
  return autoSender.updateConfig((config) => {
    config.log = [{ ts: Date.now(), ...entry }].concat(config.log).slice(0, 50);
    return config;
  });
};

autoSender.setRuntime = async function (patch) {
  return autoSender.updateConfig((config) => {
    config.runtime = { ...config.runtime, ...patch, updatedAt: Date.now() };
    return config;
  });
};
