/* Local persistence. Everything lives in localStorage so an app kill,
   backgrounding, or connectivity drop never loses logged boxes. */
'use strict';

const Store = (() => {
  const SESSION_KEY = 'loadseq.session.v1';
  const SETTINGS_KEY = 'loadseq.settings.v1';

  const defaultSession = () => ({
    startedAt: new Date().toISOString(),
    boxes: [],          // { id, scanOrder, ocrRawText, name, address, confirmed, ocrConfidence, flagged, flagReason }
    stops: [],          // { boxId, stopSequence, matchedAddress, matchConfidence }
    syncState: 'idle',  // idle | syncing | mismatch | done | error
    syncIssues: [],     // human-readable problem strings from last sync
    mismatchAcked: false,
    loaded: {},         // boxId -> true once physically loaded
    gridSort: 'box'     // 'box' | 'stop'
  });

  const defaultSettings = () => ({
    gridCols: 5,
    orKey: '',
    orUrl: 'https://api.optimoroute.com/v1',
    corsProxy: '',
    ocrSpaceKey: ''
  });

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback();
      return Object.assign(fallback(), JSON.parse(raw));
    } catch (e) {
      console.error('Store load failed for', key, e);
      return fallback();
    }
  }

  let session = load(SESSION_KEY, defaultSession);
  let settings = load(SETTINGS_KEY, defaultSettings);

  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function resetSession() {
    session = defaultSession();
    saveSession();
    return session;
  }

  function addBox({ ocrRawText, name, address, ocrConfidence }) {
    const box = {
      id: 'b' + Date.now() + Math.random().toString(36).slice(2, 7),
      scanOrder: session.boxes.length + 1,
      ocrRawText, name, address,
      confirmed: true,
      ocrConfidence,
      flagged: false,
      flagReason: ''
    };
    session.boxes.push(box);
    invalidateSync();
    saveSession();
    return box;
  }

  function updateBox(id, patch) {
    const box = session.boxes.find((b) => b.id === id);
    if (box) { Object.assign(box, patch); invalidateSync(); saveSession(); }
    return box;
  }

  function deleteBox(id) {
    session.boxes = session.boxes.filter((b) => b.id !== id);
    // Renumber so scanOrder always matches physical line position 1..N.
    session.boxes.forEach((b, i) => { b.scanOrder = i + 1; });
    delete session.loaded[id];
    invalidateSync();
    saveSession();
  }

  function moveBox(id, newOrder) {
    const idx = session.boxes.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const target = Math.max(0, Math.min(session.boxes.length - 1, newOrder - 1));
    const [box] = session.boxes.splice(idx, 1);
    session.boxes.splice(target, 0, box);
    session.boxes.forEach((b, i) => { b.scanOrder = i + 1; });
    invalidateSync();
    saveSession();
  }

  // Any edit to the box list makes a previous route sync stale — force a re-sync
  // rather than letting the grid quietly show numbers for an outdated list.
  function invalidateSync() {
    if (session.syncState === 'done' || session.syncState === 'mismatch') {
      session.syncState = 'idle';
      session.stops = [];
      session.syncIssues = ['Box list changed after last sync — re-send to the optimizer.'];
      session.mismatchAcked = false;
    }
  }

  function setSyncResult({ stops, issues }) {
    session.stops = stops;
    session.syncIssues = issues;
    session.syncState = issues.length ? 'mismatch' : 'done';
    session.mismatchAcked = false;
    saveSession();
  }

  return {
    get session() { return session; },
    get settings() { return settings; },
    saveSession, saveSettings, resetSession,
    addBox, updateBox, deleteBox, moveBox, setSyncResult
  };
})();
