/* UI wiring for the three screens + settings. */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ---------- Navigation ---------- */

  const SCREEN_TITLES = { scan: 'Scan', sync: 'Route Sync', grid: 'Load Grid', settings: 'Setup' };

  function showScreen(name) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
    $('#topbar-title').textContent = SCREEN_TITLES[name];
    if (name === 'sync') renderSync();
    if (name === 'grid') renderGrid();
    if (name === 'settings') renderSettings();
    if (name === 'scan') renderBoxList();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));

  /* ---------- Modal (confirm dialogs without window.confirm) ---------- */

  function modal(text, { cancel = true } = {}) {
    return new Promise((resolve) => {
      $('#modal-text').textContent = text;
      $('#modal-cancel').hidden = !cancel;
      $('#modal-backdrop').hidden = false;
      const done = (val) => {
        $('#modal-backdrop').hidden = true;
        $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
        resolve(val);
      };
      $('#modal-ok').onclick = () => done(true);
      $('#modal-cancel').onclick = () => done(false);
    });
  }

  /* ---------- Counter ---------- */

  function renderCounter() {
    const n = Store.session.boxes.length;
    $('#box-counter').textContent = `${n} box${n === 1 ? '' : 'es'} logged`;
  }

  /* ---------- Screen 1: Scan & Confirm ---------- */

  let cameraStream = null;
  let pendingRead = null; // OCR result awaiting confirm

  async function startCamera() {
    if (cameraStream) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      const video = $('#camera');
      video.srcObject = cameraStream;
      video.hidden = false;
      $('#camera-fallback').hidden = true;
    } catch (e) {
      $('#camera-fallback').hidden = false;
      $('#btn-capture').disabled = true;
      console.warn('Camera unavailable, falling back to file capture:', e);
    }
  }

  function captureFrame() {
    const video = $('#camera');
    const canvas = $('#capture-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  }

  async function processImage(blob) {
    setScanStatus('Reading label…');
    setScanBusy(true);
    try {
      const read = await OCR.readLabel(blob, Store.settings.ocrSpaceKey);
      pendingRead = read;
      showConfirm(read);
      setScanStatus(read.cloudError ? `Cloud OCR fallback failed (${read.cloudError}) — showing on-device read.` : '');
    } catch (e) {
      setScanStatus('OCR failed: ' + e.message + ' — retake or type the address by hand.');
      pendingRead = { raw: '', confidence: 0, lowConfidence: true, name: '', address: '' };
      showConfirm(pendingRead);
    } finally {
      setScanBusy(false);
    }
  }

  function showConfirm(read) {
    const card = $('#confirm-card');
    card.classList.toggle('low-confidence', !!read.lowConfidence);
    $('#confirm-boxno').textContent = 'Box ' + (Store.session.boxes.length + 1);
    const badge = $('#confirm-conf');
    badge.textContent = read.lowConfidence ? `⚠ LOW ${read.confidence}% — verify!` : `OCR ${read.confidence}%`;
    badge.classList.toggle('low', !!read.lowConfidence);
    $('#confirm-name').value = read.name || '';
    $('#confirm-address').value = read.address || '';
    $('#confirm-raw').textContent = read.raw || '(no text read)';
    $('#confirm-panel').hidden = false;
    $('#scan-controls').hidden = true;
    if (read.lowConfidence) $('#confirm-address').focus();
  }

  function hideConfirm() {
    pendingRead = null;
    $('#confirm-panel').hidden = true;
    $('#scan-controls').hidden = false;
  }

  function setScanStatus(msg) { $('#scan-status').textContent = msg; }
  function setScanBusy(busy) {
    $('#btn-capture').disabled = busy || $('#camera').hidden;
    $('#file-capture').disabled = busy;
  }

  $('#btn-capture').addEventListener('click', async () => {
    const blob = await captureFrame();
    processImage(blob);
  });

  $('#file-capture').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) processImage(file);
  });

  $('#btn-retake').addEventListener('click', hideConfirm);
  $('#btn-skip').addEventListener('click', () => setScanStatus('Box skipped — capture it again when ready.'));

  $('#btn-confirm').addEventListener('click', async () => {
    const name = $('#confirm-name').value.trim();
    const address = $('#confirm-address').value.trim();
    if (!address) {
      await modal('Address is empty. Type it in before confirming — the optimizer needs a real address.', { cancel: false });
      return;
    }
    Store.addBox({
      ocrRawText: pendingRead ? pendingRead.raw : '',
      name, address,
      ocrConfidence: pendingRead ? pendingRead.confidence : 0
    });
    refreshDuplicateFlags();
    hideConfirm();
    renderCounter();
    renderBoxList();
    setScanStatus(`Box ${Store.session.boxes.length} locked in. Line up the next box.`);
  });

  /* Near-duplicate flags recomputed after every list change. */
  function refreshDuplicateFlags() {
    const boxes = Store.session.boxes;
    boxes.forEach((b) => {
      if (b.flagReason && b.flagReason.startsWith('Similar address')) { b.flagged = false; b.flagReason = ''; }
    });
    for (const group of OCR.findNearDuplicates(boxes)) {
      const nums = group.map((b) => b.scanOrder).join(', ');
      for (const b of group) {
        b.flagged = true;
        b.flagReason = `Similar address to box(es) ${nums} — confirm apt/unit is right.`;
      }
    }
    Store.saveSession();
  }

  /* ---------- Logged-box list (edit / delete / renumber) ---------- */

  let listVisible = false;
  $('#btn-toggle-list').addEventListener('click', () => {
    listVisible = !listVisible;
    $('#box-list').hidden = !listVisible;
    $('#btn-toggle-list').textContent = listVisible ? 'hide' : 'show';
    renderBoxList();
  });

  function renderBoxList() {
    renderCounter();
    if (!listVisible) return;
    const ol = $('#box-list');
    ol.innerHTML = '';
    for (const b of [...Store.session.boxes].reverse()) {
      const li = document.createElement('li');
      if (b.flagged) li.classList.add('flagged');
      li.innerHTML = `
        <span class="li-num">#${b.scanOrder}</span>
        <span class="li-body">
          <span class="li-name">${esc(b.name || '(no name)')}</span><br>
          <span class="li-addr">${esc(b.address)}</span>
          ${b.flagged ? `<br><span class="li-addr">⚠ ${esc(b.flagReason)}</span>` : ''}
        </span>
        <button class="btn btn-secondary" data-act="edit">✎</button>
        <button class="btn btn-secondary" data-act="move">⇅</button>
        <button class="btn btn-danger" data-act="del">✕</button>`;
      li.querySelector('[data-act=del]').addEventListener('click', async () => {
        if (await modal(`Delete box ${b.scanOrder} (${b.address})? Later boxes will be renumbered.`)) {
          Store.deleteBox(b.id);
          refreshDuplicateFlags();
          renderBoxList();
        }
      });
      li.querySelector('[data-act=edit]').addEventListener('click', async () => {
        const addr = prompt('Address for box ' + b.scanOrder + ':', b.address);
        if (addr === null) return;
        const name = prompt('Name for box ' + b.scanOrder + ':', b.name);
        Store.updateBox(b.id, { address: addr.trim(), name: (name || '').trim() });
        refreshDuplicateFlags();
        renderBoxList();
      });
      li.querySelector('[data-act=move]').addEventListener('click', () => {
        const pos = prompt(`Box ${b.scanOrder} — move to what position (1-${Store.session.boxes.length})?`, String(b.scanOrder));
        const n = parseInt(pos, 10);
        if (!isNaN(n)) { Store.moveBox(b.id, n); refreshDuplicateFlags(); renderBoxList(); }
      });
      ol.appendChild(li);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- Screen 2: Route Sync ---------- */

  function renderSync() {
    const s = Store.session;
    const flagged = s.boxes.filter((b) => b.flagged);
    $('#sync-summary').innerHTML =
      `<h2>${s.boxes.length} boxes ready</h2>` +
      (s.boxes.length ? '' : '<p class="hint">Scan boxes first.</p>');
    const dupPanel = $('#dup-warnings');
    if (flagged.length) {
      dupPanel.hidden = false;
      dupPanel.innerHTML = '<h2>⚠ Similar addresses — verify before sending</h2><ul>' +
        flagged.map((b) => `<li>Box ${b.scanOrder}: ${esc(b.address)}<br><small>${esc(b.flagReason)}</small></li>`).join('') + '</ul>';
    } else dupPanel.hidden = true;

    $('#btn-sync').disabled = s.boxes.length === 0 || s.syncState === 'syncing';
    $('#sync-errors').hidden = true;
    $('#btn-retry-sync').hidden = true;
    renderSyncResult();
  }

  function renderSyncResult() {
    const s = Store.session;
    const report = $('#match-report');
    const ack = $('#btn-ack-mismatch');
    const goGrid = $('#btn-goto-grid');
    report.hidden = ack.hidden = goGrid.hidden = true;

    if (s.syncState === 'done') {
      report.hidden = false;
      report.className = 'panel';
      report.innerHTML = `<h2>✓ All ${s.boxes.length} boxes matched to stops</h2>`;
      goGrid.hidden = false;
    } else if (s.syncState === 'mismatch') {
      report.hidden = false;
      report.className = 'panel warn';
      report.innerHTML = '<h2>⚠ Problems found — do not load yet</h2><ul>' +
        s.syncIssues.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
      if (s.mismatchAcked) goGrid.hidden = false;
      else ack.hidden = false;
    } else if (s.syncIssues.length) {
      // e.g. "box list changed, re-sync"
      report.hidden = false;
      report.className = 'panel warn';
      report.innerHTML = '<ul>' + s.syncIssues.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
    }
  }

  async function runSync() {
    const s = Store.session;
    s.syncState = 'syncing';
    Store.saveSession();
    $('#btn-sync').disabled = true;
    $('#sync-errors').hidden = true;
    $('#btn-retry-sync').hidden = true;
    try {
      const { stops, issues } = await Route.sync(Store.settings, s.boxes,
        (msg) => { $('#sync-progress').textContent = msg; });
      Store.setSyncResult({ stops, issues });
      $('#sync-progress').textContent = issues.length ? '' : 'Done.';
    } catch (e) {
      s.syncState = 'error';
      Store.saveSession();
      $('#sync-progress').textContent = '';
      const errPanel = $('#sync-errors');
      errPanel.hidden = false;
      errPanel.textContent = '✕ Sync failed: ' + e.message;
      $('#btn-retry-sync').hidden = false;
    }
    $('#btn-sync').disabled = false;
    renderSyncResult();
  }

  $('#btn-sync').addEventListener('click', runSync);
  $('#btn-retry-sync').addEventListener('click', runSync);
  $('#btn-ack-mismatch').addEventListener('click', () => {
    Store.session.mismatchAcked = true;
    Store.saveSession();
    renderSyncResult();
  });
  $('#btn-goto-grid').addEventListener('click', () => showScreen('grid'));

  /* ---------- Screen 3: Load Grid ---------- */

  function renderGrid() {
    const s = Store.session;
    const grid = $('#load-grid');
    grid.innerHTML = '';
    const hasRoute = s.stops.length > 0 && (s.syncState === 'done' || (s.syncState === 'mismatch' && s.mismatchAcked));
    $('#grid-empty').hidden = hasRoute;
    if (!hasRoute) { $('#loaded-counter').textContent = '0 / 0 loaded'; return; }

    grid.style.gridTemplateColumns = `repeat(${Store.settings.gridCols}, 1fr)`;

    const stopByBox = new Map(s.stops.map((st) => [st.boxId, st]));
    let items = s.boxes.map((b) => ({ box: b, stop: stopByBox.get(b.id) }));
    if (s.gridSort === 'stop') {
      items = [...items].sort((a, b) =>
        (a.stop && a.stop.stopSequence || 1e9) - (b.stop && b.stop.stopSequence || 1e9));
    }
    $('#btn-sort-toggle').textContent = s.gridSort === 'stop' ? 'Sort: stop order' : 'Sort: box order';

    let loadedCount = 0;
    for (const { box, stop } of items) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      const hasStop = stop && stop.stopSequence != null;
      if (!hasStop) cell.classList.add('problem');
      if (s.loaded[box.id]) { cell.classList.add('loaded'); loadedCount++; }
      cell.innerHTML = `
        <div class="stop-num">${hasStop ? stop.stopSequence : 'NO STOP'}</div>
        <div class="cell-box">BOX ${box.scanOrder}</div>
        <div class="cell-name">${esc(box.name || '')}</div>
        <div class="cell-addr">${esc(box.address)}</div>`;
      cell.addEventListener('click', () => {
        if (s.loaded[box.id]) delete s.loaded[box.id];
        else s.loaded[box.id] = true;
        Store.saveSession();
        renderGrid();
      });
      grid.appendChild(cell);
    }
    $('#loaded-counter').textContent = `${loadedCount} / ${items.length} loaded`;
  }

  $('#btn-sort-toggle').addEventListener('click', () => {
    Store.session.gridSort = Store.session.gridSort === 'stop' ? 'box' : 'stop';
    Store.saveSession();
    renderGrid();
  });

  /* ---------- Settings ---------- */

  function renderSettings() {
    const st = Store.settings;
    $('#set-cols').value = st.gridCols;
    $('#set-or-key').value = st.orKey;
    $('#set-or-url').value = st.orUrl;
    $('#set-proxy').value = st.corsProxy;
    $('#set-ocr-key').value = st.ocrSpaceKey;
  }

  $('#btn-save-settings').addEventListener('click', () => {
    const st = Store.settings;
    st.gridCols = Math.max(2, Math.min(12, parseInt($('#set-cols').value, 10) || 5));
    st.orKey = $('#set-or-key').value.trim();
    st.orUrl = $('#set-or-url').value.trim() || 'https://api.optimoroute.com/v1';
    st.corsProxy = $('#set-proxy').value.trim();
    st.ocrSpaceKey = $('#set-ocr-key').value.trim();
    Store.saveSettings();
    $('#settings-saved').textContent = '✓ Saved';
    setTimeout(() => { $('#settings-saved').textContent = ''; }, 2000);
  });

  $('#btn-new-session').addEventListener('click', async () => {
    const n = Store.session.boxes.length;
    if (await modal(`Start a new day? This deletes all ${n} logged boxes and the route mapping. This cannot be undone.`)) {
      Store.resetSession();
      renderCounter();
      renderBoxList();
      renderSync();
      renderGrid();
      showScreen('scan');
    }
  });

  /* ---------- Boot ---------- */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed:', e));
  }

  renderCounter();
  startCamera();

  // Resume where the session left off if the app was killed mid-day.
  if (Store.session.stops.length) showScreen('grid');
  else if (Store.session.boxes.length && Store.session.syncState !== 'idle') showScreen('sync');
  else showScreen('scan');

  // Re-acquire the camera when the app returns from background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cameraStream) {
      const tracks = cameraStream.getVideoTracks();
      if (!tracks.length || tracks[0].readyState === 'ended') {
        cameraStream = null;
        startCamera();
      }
    }
  });
})();
