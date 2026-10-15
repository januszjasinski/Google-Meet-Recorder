// Runs on meet.google.com. While a recording is active it reads Meet's live captions
// (speaker + text), reports the microphone mute state and notices when the call ends.
//
// Meet's markup is minified and changes over time, so every lookup tries stable hooks first
// (ARIA roles/labels, Material icon names) and falls back to structure, then to known class names.

(() => {
  const previous = globalThis.__meetRecorder;
  if (previous?.isAlive()) return;
  previous?.teardown();

  const ICONS = 'i.google-symbols, i.google-material-icons, .google-symbols, .material-icons-extended, .material-symbols-outlined';
  const CAPTION_REGION_LABEL = /caption|subtit|untertitel|sous-titr|legend|napis|ondertitel|字幕|자막/i;
  const TICK_MS = 400;
  const FLUSH_MS = 2000;
  const END_AFTER_TICKS = 8; // ~3 s without any in-call UI means the user left

  let session = null;
  let micObserver = null;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? clean(el.innerText || el.textContent) : '');

  function isAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!isAlive()) return teardown();
    try {
      chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
    } catch {
      teardown();
    }
  }

  function findIcon(name) {
    for (const el of document.querySelectorAll(ICONS)) if (el.textContent.trim() === name) return el;
    return null;
  }

  // ---- Meet UI state ----

  function isInCall() {
    return Boolean(findIcon('call_end') || document.querySelector('[aria-label*="leave call" i], [data-participant-id]'));
  }

  /** true/false, or null when the mic button can't be found. */
  function isMicMuted() {
    for (const btn of document.querySelectorAll('[data-is-muted]')) {
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-tooltip') || ''}`;
      const icon = btn.querySelector(ICONS)?.textContent.trim() || '';
      if (icon.startsWith('mic') || /mi[ck]ro|mikrofon/i.test(label)) return btn.getAttribute('data-is-muted') === 'true';
    }
    return null;
  }

  /** true/false, or null when the captions button isn't visible (e.g. tucked into the overflow menu). */
  function captionsOn() {
    if (findIcon('closed_caption_off')) return false;
    if (findIcon('closed_caption')) return true;
    const btn = document.querySelector('button[aria-label*="caption" i][aria-pressed]');
    return btn ? btn.getAttribute('aria-pressed') === 'true' : null;
  }

  function setCaptions(on) {
    const icon = findIcon(on ? 'closed_caption_off' : 'closed_caption');
    const btn =
      icon?.closest('button, [role="button"]') ||
      document.querySelector(`button[aria-label*="caption" i][aria-pressed="${on ? 'false' : 'true'}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }

  function meetingName() {
    return document.querySelector('[data-meeting-title]')?.getAttribute('data-meeting-title') || '';
  }

  // ---- Captions ----

  function findCaptionRegion() {
    for (const el of document.querySelectorAll('[role="region"][aria-label]')) {
      if (CAPTION_REGION_LABEL.test(el.getAttribute('aria-label'))) return el;
    }
    return document.querySelector('.a4cQT');
  }

  // Each caption block is one speaker turn: [avatar + name] [text].
  function captionBlocks(region) {
    const known = region.querySelectorAll('.nMcdL, .TBMuR');
    if (known.length) return [...known];
    let list = region;
    for (let depth = 0; depth < 8 && list.children.length === 1; depth++) {
      const only = list.firstElementChild;
      const kids = [...only.children];
      const withAvatar = kids.filter((k) => k.tagName === 'IMG' || k.querySelector('img')).length;
      // One avatar and several text parts: `only` is itself a single caption block.
      if (withAvatar < 2 && kids.filter((k) => clean(k.textContent)).length >= 2) break;
      list = only;
    }
    return [...list.children].filter((el) => clean(el.textContent));
  }

  function parseBlock(block) {
    const textEl = block.querySelector('.ygicle, .iTTPOb, .bh44bd');
    if (textEl) {
      const nameEl =
        block.querySelector('.NWpY1d, .zs7s8d, .KcIKyf') || [...block.children].find((c) => !c.contains(textEl));
      return { speaker: textOf(nameEl), text: textOf(textEl) };
    }
    const parts = [...block.children].filter((el) => clean(el.textContent));
    if (parts.length >= 2) return { speaker: textOf(parts[0]), text: clean(parts.slice(1).map(textOf).join(' ')) };
    return { speaker: '', text: textOf(block) };
  }

  // Meet grows a block's text as someone talks, revises recent words, and may drop the
  // oldest words of a long block from view. Combine the stored text with the latest view.
  function mergeText(prev, next) {
    if (!prev) return next;
    if (next.startsWith(prev.slice(0, 24))) return next; // same utterance, grown or revised
    const probe = next.slice(0, 24);
    const at = prev.lastIndexOf(probe);
    if (at > 0) return prev.slice(0, at) + next; // head was trimmed from view
    return next.length >= prev.length ? next : `${prev} ${next}`;
  }

  function entryFor(block, speaker, text, now) {
    const known = session.byNode.get(block);
    if (known) return known;
    // Meet sometimes re-renders a block; adopt the recent entry if it's clearly the same utterance.
    const head = text.slice(0, 16);
    let entry = session.order
      .slice(-4)
      .reverse()
      .find(
        (e) =>
          !e.node?.deref()?.isConnected &&
          e.speaker === speaker &&
          (e.text.startsWith(head) || text.startsWith(e.text.slice(0, 16))),
      );
    if (!entry) {
      entry = { id: `${session.prefix}-${session.nextId++}`, speaker, text: '', startMs: now, endMs: now, node: null };
      session.order.push(entry);
    }
    entry.node = new WeakRef(block);
    session.byNode.set(block, entry);
    return entry;
  }

  function scan() {
    const region = findCaptionRegion();
    if (!region) return;
    const now = Date.now() - session.startedAt;
    for (const block of captionBlocks(region)) {
      const { speaker, text } = parseBlock(block);
      if (!text) continue;
      const entry = entryFor(block, speaker, text, now);
      const merged = mergeText(entry.text, text);
      if (merged === entry.text && (!speaker || speaker === entry.speaker)) continue;
      entry.text = merged;
      if (speaker) entry.speaker = speaker;
      entry.endMs = now;
      session.dirty.add(entry);
    }
  }

  const toRecord = ({ id, speaker, text, startMs, endMs }) => ({ id, speaker, text, startMs, endMs });

  function flush() {
    if (!session?.dirty.size) return;
    const entries = [...session.dirty].map(toRecord);
    session.dirty.clear();
    send({ type: 'captions', recordingId: session.recordingId, entries });
  }

  // ---- Session ----

  function checkMic() {
    if (!session) return;
    const muted = isMicMuted();
    if (muted === null || muted === session.micMuted) return;
    session.micMuted = muted;
    send({ type: 'mic-state', recordingId: session.recordingId, muted });
  }

  function checkCall() {
    if (isInCall()) {
      session.joined = true;
      session.outOfCallTicks = 0;
    } else if (session.joined && ++session.outOfCallTicks === END_AFTER_TICKS) {
      send({ type: 'meeting-ended', recordingId: session.recordingId });
    }
  }

  function maybeEnableCaptions() {
    if (!session.autoEnableCaptions || session.captionsHandled) return;
    const on = captionsOn();
    if (on === true) session.captionsHandled = true;
    else if (on === false && setCaptions(true)) {
      session.captionsHandled = true;
      session.enabledCaptions = true;
    }
  }

  function tick() {
    if (!isAlive()) return teardown();
    if (!session) return;
    try {
      scan();
    } catch (err) {
      console.debug('[Meet Recorder] caption scan failed', err);
    }
    checkMic();
    checkCall();
    maybeEnableCaptions();
  }

  function startCapture({ recordingId, startedAt, autoEnableCaptions }) {
    stopCapture();
    session = {
      recordingId,
      startedAt,
      autoEnableCaptions,
      prefix: Date.now().toString(36),
      nextId: 1,
      order: [],
      byNode: new WeakMap(),
      dirty: new Set(),
      micMuted: undefined,
      joined: false,
      outOfCallTicks: 0,
      captionsHandled: false,
      enabledCaptions: false,
    };
    session.tickTimer = setInterval(tick, TICK_MS);
    session.flushTimer = setInterval(flush, FLUSH_MS);
    // React to mute clicks immediately rather than on the next tick.
    micObserver = new MutationObserver(checkMic);
    micObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-is-muted'] });
    tick();
  }

  function stopCapture() {
    if (!session) return [];
    clearInterval(session.tickTimer);
    clearInterval(session.flushTimer);
    micObserver?.disconnect();
    micObserver = null;
    try {
      scan();
    } catch {
      // Keep what we already have.
    }
    const entries = session.order.filter((e) => e.text).map(toRecord);
    if (session.enabledCaptions) setCaptions(false); // Leave captions as the user had them.
    session = null;
    return entries;
  }

  function status() {
    const lines = session ? session.order.filter((e) => e.text) : [];
    return {
      ok: true,
      inCall: isInCall(),
      micMuted: isMicMuted(),
      captionsOn: captionsOn(),
      title: meetingName(),
      recording: session ? { recordingId: session.recordingId, count: lines.length, recent: lines.slice(-20).map(toRecord) } : null,
    };
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.target !== 'content') return false;
    switch (msg.type) {
      case 'ping':
      case 'status':
        sendResponse(status());
        break;
      case 'captions-start':
        if (session?.recordingId !== msg.recordingId) startCapture(msg);
        sendResponse({ ok: true });
        break;
      case 'captions-stop': {
        const matches = !session || session.recordingId === msg.recordingId;
        const entries = stopCapture();
        sendResponse({ ok: true, entries: matches ? entries : [] });
        break;
      }
    }
    return false;
  }

  function teardown() {
    if (session) {
      clearInterval(session.tickTimer);
      clearInterval(session.flushTimer);
      session = null;
    }
    micObserver?.disconnect();
    micObserver = null;
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context already gone.
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__meetRecorder = { isAlive, teardown };
})();
