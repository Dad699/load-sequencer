/* OptimoRoute client: create orders (box number as orderNo reference),
   start planning, poll until finished, fetch routes, map stops back to boxes.
   Every failure mode is surfaced to the caller — nothing is swallowed. */
'use strict';

const Route = (() => {
  const TIMEOUT_MS = 30000;
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_MS = 180000;

  function apiUrl(settings, path, params = {}) {
    const base = (settings.orUrl || 'https://api.optimoroute.com/v1').replace(/\/+$/, '');
    const url = new URL(base + path);
    url.searchParams.set('key', settings.orKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return (settings.corsProxy || '') + url.toString();
  }

  async function call(settings, path, body, params) {
    if (!settings.orKey) throw new Error('No OptimoRoute API key set. Add it in Setup.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(apiUrl(settings, path, params), {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Timed out after ${TIMEOUT_MS / 1000}s calling ${path}. Check connectivity and retry.`);
      throw new Error(`Network error calling ${path}: ${e.message}. If this persists on WiFi, the API may be blocking browser calls — set a CORS proxy in Setup.`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Auth failed (HTTP ' + res.status + '). Check the API key in Setup.');
    if (!res.ok) throw new Error(`OptimoRoute HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    if (json.success === false) {
      throw new Error(`OptimoRoute rejected ${path}: ${json.message || json.code || JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }

  const orderNoFor = (box) => 'BOX-' + box.scanOrder;

  /**
   * Full sync. Returns { stops, issues } — stops is the box→stop mapping,
   * issues is a list of human-readable problems (unmatched boxes, geocode
   * failures, duplicate assignments). Throws on hard API errors.
   */
  async function sync(settings, boxes, onProgress) {
    const date = new Date().toISOString().slice(0, 10);
    const issues = [];

    // 1) Create/replace today's orders, one per box.
    onProgress(`Sending ${boxes.length} addresses…`);
    const orders = boxes.map((b) => ({
      operation: 'MERGE',
      orderNo: orderNoFor(b),
      type: 'D',
      date,
      duration: 5,
      address: b.address,
      locationName: b.name || undefined,
      acceptPartialMatch: false,
      acceptMultipleResults: false
    }));
    const created = await call(settings, '/create_or_update_orders', { orders });
    const failedGeocode = new Set();
    (created.orders || []).forEach((o, i) => {
      if (o.success === false) {
        failedGeocode.add(orders[i].orderNo);
        issues.push(`Box ${boxes[i].scanOrder} (${boxes[i].address}): address rejected — ${o.message || o.code || 'geocoding failed'}`);
      }
    });

    // 2) Kick off planning.
    onProgress('Optimizing route…');
    const plan = await call(settings, '/start_planning', { date });
    const planningId = plan.planningId;

    // 3) Poll until finished.
    const deadline = Date.now() + POLL_MAX_MS;
    for (;;) {
      const status = await call(settings, '/get_planning_status', { planningId });
      const s = (status.planning && status.planning.status) || status.status;
      if (s === 'F' || s === 'finished') break;
      if (s === 'E' || s === 'error') throw new Error('Route planning failed on the OptimoRoute side: ' + JSON.stringify(status).slice(0, 300));
      if (Date.now() > deadline) throw new Error('Route planning did not finish within ' + POLL_MAX_MS / 1000 + 's. Retry, or check the OptimoRoute dashboard.');
      onProgress('Optimizing route… (' + (s || 'working') + ')');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // 4) Fetch the planned routes and map orderNo -> stop sequence.
    onProgress('Fetching stop numbers…');
    const routesRes = await call(settings, '/get_routes', null, { date });
    const stopByOrderNo = new Map();
    let seq = 0;
    for (const route of routesRes.routes || []) {
      for (const stop of route.stops || []) {
        seq += 1;
        if (!stop.orderNo) continue;
        if (stopByOrderNo.has(stop.orderNo)) {
          issues.push(`${stop.orderNo} appears at two stops (${stopByOrderNo.get(stop.orderNo).stopSequence} and ${seq}) — verify manually.`);
        }
        stopByOrderNo.set(stop.orderNo, {
          stopSequence: stop.stopNumber || seq,
          matchedAddress: stop.address || '',
          matchConfidence: 1
        });
      }
    }

    // 5) Build the box→stop mapping; flag every box without a stop.
    const stops = [];
    const seenSeq = new Map();
    for (const b of boxes) {
      const hit = stopByOrderNo.get(orderNoFor(b));
      if (!hit) {
        if (!failedGeocode.has(orderNoFor(b))) {
          issues.push(`Box ${b.scanOrder} (${b.address}): no stop returned by the optimizer — it may be unscheduled. Check the OptimoRoute dashboard.`);
        }
        stops.push({ boxId: b.id, stopSequence: null, matchedAddress: '', matchConfidence: 0 });
        continue;
      }
      if (seenSeq.has(hit.stopSequence)) {
        issues.push(`Boxes ${seenSeq.get(hit.stopSequence)} and ${b.scanOrder} both mapped to stop ${hit.stopSequence} — likely duplicate addresses. Verify manually.`);
      }
      seenSeq.set(hit.stopSequence, b.scanOrder);
      stops.push({ boxId: b.id, stopSequence: hit.stopSequence, matchedAddress: hit.matchedAddress, matchConfidence: hit.matchConfidence });
    }

    return { stops, issues };
  }

  return { sync };
})();
