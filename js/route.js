/* OptimoRoute client — request/response shapes verified against the live API
   on 2026-08-12 (see test/or-smoke.mjs and test/output/):
   - create_or_update_orders: address must be nested in `location`; this account
     does NOT geocode, so latitude/longitude are required → we geocode first.
   - get_planning_status: GET with ?planningId=, response { status:'R'|'F', percentageComplete }.
   - get_routes: GET with ?date=, response { routes:[{ stops:[...] }] }.
   Every failure mode is surfaced to the caller — nothing is swallowed. */
'use strict';

const Route = (() => {
  const TIMEOUT_MS = 30000;
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_MS = 180000;
  const GEOCODE_GAP_MS = 1100; // Nominatim usage policy: max 1 req/sec

  function apiUrl(settings, path, params = {}) {
    const base = (settings.orUrl || 'https://api.optimoroute.com/v1').replace(/\/+$/, '');
    const url = new URL(base + path);
    url.searchParams.set('key', settings.orKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return (settings.corsProxy || '') + url.toString();
  }

  async function fetchTimed(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(settings, path, body, params) {
    if (!settings.orKey) throw new Error('No OptimoRoute API key set. Add it in Setup.');
    let res;
    try {
      res = await fetchTimed(apiUrl(settings, path, params), {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Timed out after ${TIMEOUT_MS / 1000}s calling ${path}. Check connectivity and retry.`);
      throw new Error(`Network error calling ${path}: ${e.message}.`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Auth failed (HTTP ' + res.status + '). Check the API key in Setup.');
    if (!res.ok) throw new Error(`OptimoRoute HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    // Auth errors come back as HTTP 200 + {success:false, code:"AUTH_..."} on this API.
    if (json.success === false && String(json.code || '').startsWith('AUTH')) {
      throw new Error('Auth failed (' + json.code + '). Check the API key in Setup.');
    }
    return json;
  }

  const orderNoFor = (box) => 'BOX-' + box.scanOrder;

  /* ---- Geocoding (OpenStreetMap Nominatim, 1 req/s, cached per box) ---- */

  async function geocodeBoxes(boxes, onProgress) {
    const issues = [];
    let i = 0;
    for (const b of boxes) {
      i++;
      if (b.lat != null && b.lng != null && b.geoAddress === b.address) continue; // cached
      onProgress(`Locating address ${i} of ${boxes.length}…`);
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=2&countrycodes=us&q=' +
        encodeURIComponent(b.address);
      let results;
      try {
        const res = await fetchTimed(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        results = await res.json();
      } catch (e) {
        issues.push(`Box ${b.scanOrder} (${b.address}): address lookup failed (${e.message}). Fix the address or retry.`);
        b.lat = b.lng = null;
        continue;
      }
      if (!results.length) {
        issues.push(`Box ${b.scanOrder} (${b.address}): address not found by geocoder. Check spelling/ZIP and re-edit the box.`);
        b.lat = b.lng = null;
      } else {
        b.lat = parseFloat(results[0].lat);
        b.lng = parseFloat(results[0].lon);
        b.geoAddress = b.address;
        b.geoDisplay = results[0].display_name || '';
      }
      await new Promise((r) => setTimeout(r, GEOCODE_GAP_MS));
    }
    return issues;
  }

  /**
   * Full sync. Returns { stops, issues }. Throws on hard API errors.
   * `boxes` are mutated with cached geocode results — caller persists them.
   */
  async function sync(settings, boxes, onProgress) {
    const date = new Date().toISOString().slice(0, 10);
    const issues = [];

    // 0) Geocode (OptimoRoute on this plan requires lat/lng — verified live).
    issues.push(...await geocodeBoxes(boxes, onProgress));
    const located = boxes.filter((b) => b.lat != null && b.lng != null);
    if (!located.length) throw new Error('No addresses could be located — nothing to send. Fix the flagged addresses and retry.');

    // 1) Create/replace today's orders, one per located box.
    onProgress(`Sending ${located.length} addresses…`);
    const orders = located.map((b) => ({
      operation: 'MERGE',
      orderNo: orderNoFor(b),
      type: 'D',
      date,
      duration: 5,
      location: {
        address: b.address,
        locationName: b.name || undefined,
        latitude: b.lat,
        longitude: b.lng
      }
    }));
    const created = await call(settings, '/create_or_update_orders', { orders });
    const failedCreate = new Set();
    (created.orders || []).forEach((o, idx) => {
      if (o.success === false) {
        failedCreate.add(orders[idx].orderNo);
        issues.push(`Box ${located[idx].scanOrder} (${located[idx].address}): rejected by optimizer — ${o.message || o.code}`);
      }
    });
    if (created.success === false && !(created.orders || []).length) {
      throw new Error('Optimizer rejected the order upload: ' + (created.message || created.code || 'unknown error'));
    }

    // 2) Kick off planning.
    onProgress('Optimizing route…');
    const plan = await call(settings, '/start_planning', { date });
    if (plan.success === false) {
      if (plan.code === 'ERR_OPT_NO_REQUESTS') throw new Error('Optimizer has nothing to plan for today — the orders may not have been created. Retry.');
      throw new Error('Could not start route planning: ' + (plan.message || plan.code));
    }
    const planningId = plan.planningId;

    // 3) Poll until finished (GET; status 'R' running → 'F' finished — verified live).
    const deadline = Date.now() + POLL_MAX_MS;
    for (;;) {
      const status = await call(settings, '/get_planning_status', null, { planningId });
      const s = status.status;
      if (s === 'F') break;
      if (s === 'E' || status.success === false) throw new Error('Route planning failed on the OptimoRoute side: ' + JSON.stringify(status).slice(0, 300));
      if (Date.now() > deadline) throw new Error('Route planning did not finish within ' + POLL_MAX_MS / 1000 + 's. Retry, or check the OptimoRoute dashboard.');
      onProgress(`Optimizing route… ${status.percentageComplete != null ? status.percentageComplete + '%' : ''}`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // 4) Fetch the planned routes and map orderNo -> stop sequence.
    onProgress('Fetching stop numbers…');
    const routesRes = await call(settings, '/get_routes', null, { date });
    const routes = routesRes.routes || [];
    if (!routes.length) {
      throw new Error('Planning finished but the optimizer returned NO routes. This usually means no driver is scheduled for today in OptimoRoute (Administration → Drivers → working hours). Fix that in the OptimoRoute dashboard, then retry.');
    }

    const stopByOrderNo = new Map();
    let seq = 0;
    for (const route of routes) {
      for (const stop of route.stops || []) {
        seq += 1;
        if (!stop.orderNo) continue; // depot start/end entries have no orderNo
        if (stopByOrderNo.has(stop.orderNo)) {
          issues.push(`${stop.orderNo} appears at two stops — verify manually in the OptimoRoute dashboard.`);
        }
        stopByOrderNo.set(stop.orderNo, {
          stopSequence: stop.stopNumber != null ? stop.stopNumber : seq,
          matchedAddress: stop.address || (stop.location && stop.location.address) || '',
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
        if (!failedCreate.has(orderNoFor(b)) && b.lat != null) {
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

  return { sync, geocodeBoxes };
})();

// Allow the sync logic to be unit-tested in Node with a stubbed fetch.
if (typeof module !== 'undefined' && module.exports) module.exports = Route;
