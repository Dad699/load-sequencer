/* OCR: Tesseract.js on-device first; OCR.space cloud fallback when confidence
   is low and a key is configured. Also: address extraction heuristics and
   near-duplicate address detection. */
'use strict';

const OCR = (() => {
  const LOW_CONFIDENCE = 62; // below this the read is flagged, and cloud fallback kicks in if available
  let worker = null;

  async function getWorker() {
    if (!worker) {
      worker = await Tesseract.createWorker('eng');
    }
    return worker;
  }

  const WORD_LOW_CONFIDENCE = 70; // one shaky word in the address (e.g. a glare-hit apt number) must flag the read

  async function recognizeLocal(imageBlob) {
    const w = await getWorker();
    const { data } = await w.recognize(imageBlob);
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            words.push({ text: word.text, confidence: word.confidence });
          }
        }
      }
    }
    if (!words.length && data.words) {
      for (const word of data.words) words.push({ text: word.text, confidence: word.confidence });
    }
    return { text: data.text || '', confidence: data.confidence || 0, words, source: 'device' };
  }

  async function recognizeCloud(imageBlob, apiKey) {
    const form = new FormData();
    form.append('file', imageBlob, 'label.jpg');
    form.append('OCREngine', '2');
    form.append('scale', 'true');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { apikey: apiKey },
        body: form,
        signal: controller.signal
      });
      if (!res.ok) throw new Error('OCR.space HTTP ' + res.status);
      const json = await res.json();
      if (json.IsErroredOnProcessing) {
        throw new Error('OCR.space: ' + [].concat(json.ErrorMessage || 'processing error').join('; '));
      }
      const text = (json.ParsedResults || []).map((r) => r.ParsedText).join('\n');
      // OCR.space doesn't return a numeric confidence; treat a non-empty result as decent.
      return { text, confidence: text.trim() ? 80 : 0, source: 'cloud' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Full pipeline: local OCR, cloud fallback on low confidence, address parse. */
  async function readLabel(imageBlob, ocrSpaceKey) {
    let result;
    let cloudError = null;
    result = await recognizeLocal(imageBlob);
    if (result.confidence < LOW_CONFIDENCE && ocrSpaceKey) {
      try {
        const cloud = await recognizeCloud(imageBlob, ocrSpaceKey);
        if (cloud.confidence > result.confidence) result = cloud;
      } catch (e) {
        cloudError = e.message; // keep the local read, surface that fallback failed
      }
    }
    const parsed = parseAddress(result.text);
    // Overall confidence can hide one damaged word (glare over an apt number),
    // so any weak word inside the extracted name/address also flags the read.
    let minRelevantWordConf = 100;
    if (parsed.address && result.words && result.words.length) {
      const relevant = norm(parsed.name + ' ' + parsed.address);
      for (const w of result.words) {
        const t = norm(w.text);
        if (t && relevant.includes(t) && w.confidence < minRelevantWordConf) {
          minRelevantWordConf = w.confidence;
        }
      }
    }
    return {
      raw: result.text,
      confidence: Math.round(result.confidence),
      lowConfidence: result.confidence < LOW_CONFIDENCE || !parsed.address ||
        minRelevantWordConf < WORD_LOW_CONFIDENCE,
      source: result.source,
      cloudError,
      name: parsed.name,
      address: parsed.address
    };
  }

  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

  /* ---- Address extraction from raw label text ---- */

  const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
  const STATE_RE = /\b[A-Z]{2}\b/;
  const STREET_RE = /^\d{1,6}\s+\S+/;

  function parseAddress(rawText) {
    const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 1);
    let cityIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (ZIP_RE.test(lines[i]) && STATE_RE.test(lines[i].replace(ZIP_RE, ''))) { cityIdx = i; break; }
    }
    if (cityIdx < 0) return { name: guessName(lines), address: '' };

    let streetIdx = -1;
    for (let i = cityIdx - 1; i >= 0; i--) {
      if (STREET_RE.test(lines[i])) { streetIdx = i; break; }
    }
    if (streetIdx < 0) return { name: guessName(lines.slice(0, cityIdx)), address: lines[cityIdx] };

    // Street line(s) through the city/state/zip line, e.g. street + "APT 4B" line.
    const address = lines.slice(streetIdx, cityIdx + 1).join(', ');
    const name = guessName(lines.slice(0, streetIdx));
    return { name, address };
  }

  function guessName(lines) {
    // Last mostly-alphabetic line before the street — usually the recipient.
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      if (letters >= 3 && letters / l.length > 0.6 && !/ship|track|deliver|walmart|order/i.test(l)) {
        return l;
      }
    }
    return '';
  }

  /* ---- Near-duplicate detection ---- */

  const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|#|bldg|fl|floor|rm|room)\.?\s*[\w-]*\b/gi;

  /** Extract the apt/unit portion of an address, '' if none. Glare can erase a
      unit letter at HIGH OCR confidence (verified in test/ocr-test.mjs), so the
      UI surfaces this token explicitly for the human to compare against the label. */
  function extractUnit(address) {
    const m = String(address).match(new RegExp(UNIT_RE.source, 'i'));
    return m ? m[0].trim() : '';
  }

  function normalizeStreet(address) {
    return address
      .toLowerCase()
      .replace(UNIT_RE, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|cir|circle|way|pl|place|ter|terrace)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Returns groups of near-duplicate boxes, worst first:
      { boxes, level: 'unit' }   — same house number + street, differ only by apt/unit
      { boxes, level: 'street' } — same street, different house numbers */
  function findNearDuplicates(boxes) {
    const byStreetName = new Map();
    for (const b of boxes) {
      if (!b.address) continue;
      const full = normalizeStreet(b.address);          // "4532 maple" (unit + suffix stripped)
      if (!full) continue;
      const nameOnly = full.replace(/^\d+\s*/, '');     // "maple"
      if (!nameOnly) continue;
      if (!byStreetName.has(nameOnly)) byStreetName.set(nameOnly, []);
      byStreetName.get(nameOnly).push({ box: b, full });
    }
    const groups = [];
    for (const entries of byStreetName.values()) {
      if (entries.length < 2) continue;
      // Split into exact house-number matches (unit-level dupes)…
      const byFull = new Map();
      for (const e of entries) {
        if (!byFull.has(e.full)) byFull.set(e.full, []);
        byFull.get(e.full).push(e.box);
      }
      let hadUnitGroup = false;
      for (const same of byFull.values()) {
        if (same.length > 1) { groups.push({ boxes: same, level: 'unit' }); hadUnitGroup = true; }
      }
      // …and if house numbers differ, flag the whole street group once.
      if (byFull.size > 1) {
        groups.push({ boxes: entries.map((e) => e.box), level: 'street' });
      } else if (!hadUnitGroup) {
        continue;
      }
    }
    return groups.sort((a, b) => (a.level === 'unit' ? -1 : 1) - (b.level === 'unit' ? -1 : 1));
  }

  return { readLabel, findNearDuplicates, parseAddress, normalizeStreet, extractUnit, LOW_CONFIDENCE };
})();

// Allow parsing/duplicate logic to be unit-tested in Node.
if (typeof module !== 'undefined' && module.exports) module.exports = OCR;
