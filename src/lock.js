var autoSender = globalThis.autoSender || (globalThis.autoSender = {});

// Only one Messages tab may run the loop. Two tabs both opening conversations
// and sending would fight over the one visible thread and double-reply.
//
// BroadcastChannel is scoped to the origin, so this only ever hears other
// messages.google.com tabs -- which is exactly the set we care about. Note the
// page's own scripts share that origin and could in principle post on this
// channel; the worst they could do is make our tabs stand down, so the channel
// carries no instructions, only presence.

autoSender.CHANNEL = 'pb-auto-reply';
autoSender.CLAIM_MS = 600;

// Deterministic tie-break for tabs that open at the same instant and therefore
// never see each other as already-active.
autoSender.lowestId = function (ids) {
  return [...ids].sort()[0];
};

// Resolves true if this tab should run, false if another tab already is.
// A tab that stands down stays down for the life of the page -- it does not
// take over when the active tab closes.
autoSender.claimTab = function () {
  return new Promise((resolve) => {
    let channel;
    try {
      channel = new BroadcastChannel(autoSender.CHANNEL);
    } catch (err) {
      // No BroadcastChannel: assume we are alone rather than refusing to run.
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
        // A tab that starts later asks; only the running tab answers.
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
      // Nobody was already running. If several of us started together, the
      // lowest id takes it and the rest stand down.
      isActive = autoSender.lowestId(claimants) === myId;
      if (isActive) post('active');
      autoSender.lock = { id: myId, active: isActive, channel };
      resolve(isActive);
    }, autoSender.CLAIM_MS);
  });
};
