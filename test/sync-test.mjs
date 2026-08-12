/* Unit tests for Route.sync matching logic with a stubbed fetch.
   Run: node test/sync-test.mjs */
import { createRequire } from 'node:module';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
const Route = require('../js/route.js');

const settings = { orKey: 'test-key', orUrl: 'https://api.example.com/v1', corsProxy: '' };
const noop = () => {};

// Boxes come pre-geocoded (geoAddress === address) so tests skip the Nominatim path.
function makeBoxes(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'b' + (i + 1), scanOrder: i + 1,
    name: 'Person ' + (i + 1), address: (100 + i) + ' Main St, Town, ST 12345',
    lat: 38.9 + i * 0.01, lng: -77.03, geoAddress: (100 + i) + ' Main St, Town, ST 12345'
  }));
}

/** Install a fetch stub keyed by URL substring. */
function stubFetch(handlers) {
  globalThis.fetch = async (url) => {
    for (const [frag, resp] of Object.entries(handlers)) {
      if (String(url).includes(frag)) {
        const body = typeof resp === 'function' ? resp() : resp;
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error('unstubbed fetch: ' + url);
  };
}

const okCreate = (n) => ({ success: true, orders: Array.from({ length: n }, (_, i) => ({ success: true, orderNo: 'BOX-' + (i + 1) })) });

async function run(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}

await run('happy path: 3 boxes map to 3 stops, no issues', async () => {
  const boxes = makeBoxes(3);
  stubFetch({
    create_or_update_orders: okCreate(3),
    start_planning: { success: true, planningId: 42 },
    get_planning_status: { success: true, status: 'F', percentageComplete: 100 },
    get_routes: { success: true, routes: [{ stops: [
      { stopNumber: 1, orderNo: 'BOX-2', address: 'a2' },
      { stopNumber: 2, orderNo: 'BOX-3', address: 'a3' },
      { stopNumber: 3, orderNo: 'BOX-1', address: 'a1' }
    ] }] }
  });
  const { stops, issues } = await Route.sync(settings, boxes, noop);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(stops.find((s) => s.boxId === 'b1').stopSequence, 3);
  assert.strictEqual(stops.find((s) => s.boxId === 'b2').stopSequence, 1);
  assert.strictEqual(stops.find((s) => s.boxId === 'b3').stopSequence, 2);
});

await run('missing stop: box with no returned stop is flagged, sequence null', async () => {
  const boxes = makeBoxes(2);
  stubFetch({
    create_or_update_orders: okCreate(2),
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'F' },
    get_routes: { success: true, routes: [{ stops: [{ stopNumber: 1, orderNo: 'BOX-1', address: 'a' }] }] }
  });
  const { stops, issues } = await Route.sync(settings, boxes, noop);
  assert.strictEqual(stops.find((s) => s.boxId === 'b2').stopSequence, null);
  assert.ok(issues.some((i) => i.includes('Box 2') && i.includes('no stop')), 'expected a loud issue: ' + issues);
});

await run('duplicate stop: two boxes on one stopNumber both flagged', async () => {
  const boxes = makeBoxes(2);
  stubFetch({
    create_or_update_orders: okCreate(2),
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'F' },
    get_routes: { success: true, routes: [{ stops: [
      { stopNumber: 1, orderNo: 'BOX-1', address: 'a' },
      { stopNumber: 1, orderNo: 'BOX-2', address: 'a' }
    ] }] }
  });
  const { issues } = await Route.sync(settings, boxes, noop);
  assert.ok(issues.some((i) => i.includes('both mapped to stop 1')), 'expected duplicate-stop issue: ' + issues);
});

await run('geocode rejection: order create failure flagged with reason', async () => {
  const boxes = makeBoxes(2);
  stubFetch({
    create_or_update_orders: { success: false, orders: [
      { success: true, orderNo: 'BOX-1' },
      { success: false, orderNo: 'BOX-2', code: 'ERR_LOC_NOT_VALID', message: "Invalid 'latitude' in 'location'" }
    ] },
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'F' },
    get_routes: { success: true, routes: [{ stops: [{ stopNumber: 1, orderNo: 'BOX-1', address: 'a' }] }] }
  });
  const { stops, issues } = await Route.sync(settings, boxes, noop);
  assert.ok(issues.some((i) => i.includes('Box 2') && i.includes('rejected')), 'expected rejection issue: ' + issues);
  assert.strictEqual(stops.find((s) => s.boxId === 'b2').stopSequence, null);
});

await run('empty routes: loud error naming the driver-schedule cause', async () => {
  const boxes = makeBoxes(1);
  stubFetch({
    create_or_update_orders: okCreate(1),
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'F' },
    get_routes: { success: true, routes: [] }
  });
  await assert.rejects(() => Route.sync(settings, boxes, noop), /no driver is scheduled/i);
});

await run('auth error surfaces even under HTTP 200', async () => {
  const boxes = makeBoxes(1);
  stubFetch({
    create_or_update_orders: { success: false, code: 'AUTH_KEY_UNKNOWN', message: 'Unknown authorization key.' }
  });
  await assert.rejects(() => Route.sync(settings, boxes, noop), /Auth failed/);
});

await run('planning never finishes: times out with a clear message', async () => {
  const boxes = makeBoxes(1);
  stubFetch({
    create_or_update_orders: okCreate(1),
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'R', percentageComplete: 10 }
  });
  // Shrink the poll window via fake timers? Simpler: monkey-patch Date.now to jump past the deadline.
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => realNow() + (calls++ > 0 ? 10 * 60 * 1000 : 0);
  try {
    await assert.rejects(() => Route.sync(settings, boxes, noop), /did not finish/);
  } finally { Date.now = realNow; }
});

await run('depot entries (no orderNo) are skipped, sequence fallback works without stopNumber', async () => {
  const boxes = makeBoxes(2);
  stubFetch({
    create_or_update_orders: okCreate(2),
    start_planning: { success: true, planningId: 1 },
    get_planning_status: { success: true, status: 'F' },
    get_routes: { success: true, routes: [{ stops: [
      { address: 'DEPOT' },                    // no orderNo → skipped, but consumes seq 1
      { orderNo: 'BOX-2', address: 'a2' },     // no stopNumber → falls back to seq 2
      { orderNo: 'BOX-1', address: 'a1' }
    ] }] }
  });
  const { stops, issues } = await Route.sync(settings, boxes, noop);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(stops.find((s) => s.boxId === 'b2').stopSequence, 2);
  assert.strictEqual(stops.find((s) => s.boxId === 'b1').stopSequence, 3);
});

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nAll sync tests passed.');
