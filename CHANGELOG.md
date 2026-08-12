# Changelog

## 2026-08-12 (overnight) — v0.2, live-API verified

**What changed:**
- Verified every OptimoRoute call against the live account (test orders on safe dates, auto-deleted; scripts refuse to run against dates holding live data). Fixed to real shapes: address nested in `location`, lat/lng required (account plan does not geocode), `get_planning_status` is GET with top-level `{status:'R'|'F', percentageComplete}`, auth errors arrive as HTTP 200 + `AUTH_*` codes.
- Added a geocoding step (OpenStreetMap Nominatim, 1 req/s, cached per box, per-box failure flags). CORS verified open on both APIs — no proxy needed from the phone.
- Loud, named error when planning finishes with zero routes (no driver scheduled).
- Two-tier near-duplicate flagging per spec: unit-level (same house number, differs by apt) and street-level (same street, different numbers).
- Real-OCR contract test on synthetic labels (clean/angled/noisy/glare). Finding: glare erased a unit letter ("APT 2B"→"APT 2") at 96% word confidence — undetectable by any confidence gate. Mitigation: confirm card always shows an explicit apt/unit callout chip ("read as APT 2 — compare with label" / "NO apt/unit detected — check label has none").
- Deployed to GitHub Pages: https://dad699.github.io/load-sequencer/

**Tested:** 8 sync tests, 9 parse tests, 4-label OCR contract test — all passing; live e2e ran geocode→create→plan→poll→fetch against the real API and surfaced the expected no-driver error; test orders cleaned up.

**Open items / risks:**
1. **No driver in the OptimoRoute account** — sync cannot produce routes until one is added in the dashboard (Administration → Drivers) with working hours and NO break window (expedite route runs straight through — leave break fields empty/disabled).
2. Real stop objects never observed (no driver) — stop parsing is defensive (stopNumber → positional fallback, depot entries skipped) but the first driver-backed sync is the true test.
3. Camera UI, iPhone install, and persistence untested on a real device.
4. Angled labels (~13°) fail on-device OCR outright — flagged low-confidence, manual path works; shoot labels square-on or set an OCR.space key for the cloud fallback.

## 2026-08-12 — v0.1 (night-1 MVP)

**What changed:** Initial build of the full app per spec.

- Scan & Confirm: live camera (getUserMedia) with file-input fallback, Tesseract.js on-device OCR, OCR.space cloud fallback on low confidence, address/name extraction heuristics, one-tap confirm with inline edit, low-confidence reads flagged (yellow border + LOW badge), skip/retake, edit/delete/reorder logged boxes with automatic renumbering, running counter.
- Persistence: full session (boxes, stop mapping, loaded-state, sort mode) in localStorage; app resumes on the right screen after a kill.
- Route Sync: OptimoRoute create_or_update_orders → start_planning → poll get_planning_status → get_routes; box↔stop matching via BOX-n orderNo references; explicit surfacing of geocode failures, unmatched boxes, duplicate stop assignments; hard errors (timeout 30s, auth, HTTP) shown with retry button; mismatches block the grid until acknowledged; box-list edits invalidate a completed sync.
- Near-duplicate address detection (same normalized street, unit stripped) flags all members of the group at scan time and again pre-sync.
- Load Grid: configurable columns, big stop numbers, name + truncated address, tap-to-mark-loaded (dim + checkmark, not color-only), loaded/total counter, box-order vs stop-order sort toggle, NO STOP red state for unmatched boxes.
- Settings: grid columns, OptimoRoute key/endpoint, optional CORS proxy, optional OCR.space key — all localStorage, nothing hardcoded.
- PWA: manifest, generated icons (192/512), service worker with app-shell precache + runtime caching of Tesseract CDN assets.

**Tested:** `node --check` on all JS (passes). NOT yet tested: real device camera/OCR, live OptimoRoute round-trip, CORS behavior from a browser.

**Known risks / open items:**
1. **CORS** — OptimoRoute's API likely lacks CORS headers for browser calls; the settings screen has a proxy field for this, but a proxy may need to be deployed before first live sync. Highest-risk unknown.
2. OptimoRoute response field names (`planning.status`, `stopNumber`) written from API docs knowledge, not verified against a live response — the first real sync may need small mapping fixes.
3. Address-parse heuristics untested on real Walmart labels; the manual-edit path is the safety net.
4. OCR.space returns no numeric confidence; a non-empty cloud result is treated as 80%.
