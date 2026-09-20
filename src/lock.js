var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

autoSender.CHANNEL = 'pb-auto-reply';
autoSender.CLAIM_MS = 600;

autoSender.lowestId = function (ids) {
  return [...ids].sort()[0];
};

autoSender.claimTab = function () {
  return new Promise((resolve) => {
    let channel;
    try {
      channel = new BroadcastChannel(autoSender.CHANNEL);
    } catch (err) {
      autoSender.warn('BroadcastChannel unavailable, running without a tab lock', err);
      resolve(true);
      return;
    }

    const myId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random());
    const claimants = new Set([myId]);
    let activeSeen = false;
    let isActive = false;

    const post = (type) => channel.postMessage({ tag: 'pb', type, id: myId });

    channel.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.tag !== 'pb' || msg.id === myId) return;

      if (msg.type === 'active') {
        activeSeen = true;
      } else if (msg.type === 'claiming') {
        claimants.add(msg.id);
      } else if (msg.type === 'ping' && isActive) {
        post('active');
      }
    };

    post('ping');
    post('claiming');

    setTimeout(() => {
      if (activeSeen) {
        autoSender.lock = { id: myId, active: false, channel };
        resolve(false);
        return;
      }
      isActive = autoSender.lowestId(claimants) === myId;
      if (isActive) post('active');
      autoSender.lock = { id: myId, active: isActive, channel };
      resolve(isActive);
    }, autoSender.CLAIM_MS);
  });
};
