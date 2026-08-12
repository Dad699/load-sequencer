/* Live end-to-end test of the app's actual Route.sync against real Nominatim
   + real OptimoRoute. Creates BOX-n orders for TODAY only if today is empty
   (safety-checked), and deletes them afterward. Run: node test/e2e-live.mjs */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const Route = require('../js/route.js');

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const KEY = (env.match(/OPTIMOROUTE_KEY=(\S+)/) || [])[1];
const settings = { orKey: KEY, orUrl: 'https://api.optimoroute.com/v1', corsProxy: '' };
const redact = (s) => String(s).replaceAll(KEY, '<KEY>');

// Nominatim policy wants an identifying UA; browsers send Referer instead.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { 'User-Agent': 'LoadSequencerPWA-test/0.1', ...(opts.headers || {}) } });

const boxes = [
  { id: 'b1', scanOrder: 1, name: 'Test One',   address: '1600 Pennsylvania Avenue NW, Washington, DC 20500' },
  { id: 'b2', scanOrder: 2, name: 'Test Two',   address: '50 Massachusetts Ave NE, Washington, DC 20002' },
  { id: 'b3', scanOrder: 3, name: 'Test Three', address: '1000 Jefferson Dr SW, Washington, DC 20560' }
];

const today = new Date().toISOString().slice(0, 10);
async function or(path, body, params = {}) {
  const url = new URL('https://api.optimoroute.com/v1' + path);
  url.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await realFetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

// SAFETY: only run against today if today is empty of live data.
const routesToday = await or('/get_routes', null, { date: today });
const ordersToday = await or('/search_orders', { dateRange: { from: today, to: today }, includeOrderData: false });
if ((routesToday.routes || []).length || (ordersToday.orders || []).length) {
  console.error(`ABORT: ${today} already has live orders/routes — not running e2e against it.`);
  process.exit(3);
}

try {
  const { stops, issues } = await Route.sync(settings, boxes, (m) => console.log('  progress:', m));
  console.log('RESULT stops:', JSON.stringify(stops, null, 2));
  console.log('RESULT issues:', issues);
} catch (e) {
  console.log('SYNC THREW (expected if no driver is scheduled):');
  console.log('  ', redact(e.message));
} finally {
  console.log('Geocodes obtained:', boxes.map((b) => `#${b.scanOrder} ${b.lat},${b.lng}`).join('  '));
  console.log('Cleanup: deleting BOX-n test orders for', today);
  for (const b of boxes) {
    const del = await or('/delete_order', { orderNo: 'BOX-' + b.scanOrder });
    console.log('  BOX-' + b.scanOrder + ':', redact(JSON.stringify(del)));
  }
}
