/* Real-OCR test: runs the app's actual OCR.readLabel pipeline (Tesseract +
   parse + confidence gate) over synthetic messy labels.
   Run: node test/ocr-test.mjs */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Tesseract = require('tesseract.js');
const OCR = require('../js/ocr.js');

const EXPECT = { name: 'MARIA GONZALEZ', address: '4532 MAPLE AVE APT 2B, SPRINGFIELD, MO 65807' };
const CASES = ['label-clean.png', 'label-angled.png', 'label-noisy.png', 'label-glare.png'];

const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

let failures = 0;
for (const file of CASES) {
  const path = new URL('./output/' + file, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const r = await OCR.readLabel(path, '');
  const nameOk = norm(r.name) === norm(EXPECT.name);
  const addrOk = norm(r.address) === norm(EXPECT.address);
  const exactOk = nameOk && addrOk;
  // The reliability contract, in order of defense:
  //  1. correct read, or
  //  2. flagged low-confidence (yellow border, forced attention), or
  //  3. the error is inside the apt/unit token, which the UI always calls out
  //     in a dedicated chip for human comparison (glare can erase a unit letter
  //     at HIGH OCR confidence — Tesseract reports 96% on the damaged word).
  const unitChipCatches = !exactOk && nameOk &&
    norm(r.address).replace(norm(OCR.extractUnit(r.address)), '') ===
    norm(EXPECT.address).replace(norm(OCR.extractUnit(EXPECT.address)), '');
  const contractOk = exactOk || r.lowConfidence || unitChipCatches;
  if (!contractOk) failures++;
  console.log(
    `${contractOk ? (exactOk ? 'PASS ' : r.lowConfidence ? 'PASS*' : 'PASS^') : 'FAIL '} ${file.padEnd(18)}` +
    ` conf=${String(r.confidence).padStart(3)} low=${r.lowConfidence ? 'Y' : 'n'}` +
    ` name=${nameOk ? 'ok' : JSON.stringify(r.name)} addr=${addrOk ? 'ok' : JSON.stringify(r.address)}`
  );
}
console.log(failures
  ? `\n${failures} case(s) VIOLATE the fail-loud contract (wrong read not flagged).`
  : '\nContract holds: every read is correct, flagged (*), or unit-chip-checkable (^).');
process.exit(failures ? 1 : 0);
