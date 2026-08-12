/* Unit tests for label-text parsing and near-duplicate detection.
   Run: node test/parse-test.mjs */
import { createRequire } from 'node:module';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
// ocr.js references the Tesseract global at readLabel time only; parsing is pure.
globalThis.Tesseract = {};
const OCR = require('../js/ocr.js');

async function run(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}

await run('clean label: name + street + city line extracted', () => {
  const { name, address } = OCR.parseAddress(
    'WALMART FULFILLMENT\nTRACKING 1Z999AA10123456784\nJANE DOE\n4532 MAPLE AVE APT 2B\nSPRINGFIELD, MO 65807\nZONE 4'
  );
  assert.strictEqual(name, 'JANE DOE');
  assert.strictEqual(address, '4532 MAPLE AVE APT 2B, SPRINGFIELD, MO 65807');
});

await run('unit on its own line is folded into the address', () => {
  const { address } = OCR.parseAddress('JOHN SMITH\n1201 W OAK ST\nUNIT 34\nDALLAS, TX 75201');
  assert.strictEqual(address, '1201 W OAK ST, UNIT 34, DALLAS, TX 75201');
});

await run('no zip anywhere: empty address, not a guess', () => {
  const { address } = OCR.parseAddress('SOME NOISE\nMORE NOISE');
  assert.strictEqual(address, '');
});

await run('shipper block above is not mistaken for recipient name', () => {
  const { name } = OCR.parseAddress('SHIP FROM WALMART DC 6006\nBOB LEE\n99 PINE RD\nTULSA, OK 74101');
  assert.strictEqual(name, 'BOB LEE');
});

await run('near-duplicates: same number different apt → one unit-level group', () => {
  const boxes = [
    { scanOrder: 1, address: '4532 Maple Ave Apt 2B, Springfield, MO 65807' },
    { scanOrder: 2, address: '4532 Maple Ave Apt 7C, Springfield, MO 65807' },
    { scanOrder: 3, address: '900 Elm St, Springfield, MO 65807' }
  ];
  const groups = OCR.findNearDuplicates(boxes);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].level, 'unit');
  assert.deepStrictEqual(groups[0].boxes.map((b) => b.scanOrder), [1, 2]);
});

await run('near-duplicates: st vs street abbreviation still matches', () => {
  const boxes = [
    { scanOrder: 1, address: '77 Birch St, Tulsa, OK 74101' },
    { scanOrder: 2, address: '77 Birch Street, Tulsa, OK 74101' }
  ];
  const groups = OCR.findNearDuplicates(boxes);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].level, 'unit');
});

await run('same street, different house numbers → street-level flag (per spec)', () => {
  const boxes = [
    { scanOrder: 1, address: '10 Cedar Ln, Tulsa, OK 74101' },
    { scanOrder: 2, address: '12 Cedar Ln, Tulsa, OK 74101' }
  ];
  const groups = OCR.findNearDuplicates(boxes);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].level, 'street');
});

await run('mixed: unit group and street group coexist, unit sorted first', () => {
  const boxes = [
    { scanOrder: 1, address: '10 Cedar Ln, Tulsa, OK 74101' },
    { scanOrder: 2, address: '10 Cedar Lane, Tulsa, OK 74101' },
    { scanOrder: 3, address: '55 Cedar Ln, Tulsa, OK 74101' }
  ];
  const groups = OCR.findNearDuplicates(boxes);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].level, 'unit');
  assert.deepStrictEqual(groups[0].boxes.map((b) => b.scanOrder), [1, 2]);
  assert.strictEqual(groups[1].level, 'street');
  assert.deepStrictEqual(groups[1].boxes.map((b) => b.scanOrder), [1, 2, 3]);
});

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nAll parse tests passed.');
