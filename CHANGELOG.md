# Changelog

## 2026-08-12 — v0.1 (night-1 MVP)

**What changed:** Initial build of the full app per spec.

- Scan & Confirm: live camera (getUserMedia) with file-input fallback, Tesseract.js on-device OCR, OCR.space cloud fallback on low confidence, address/name extraction heuristics, one-tap confirm with inline edit, low-confidence reads flagged (yellow border + LOW badge), skip/retake, edit/delete/reorder logged boxes with automatic renumbering, running counter.
- Persistence: full session (boxes, stop mapping, loaded-state, sort mode) in localStorage; app resumes on the right screen after a kill.
- Route Sync: OptimoRoute create_or_update_orders → start_planning → poll get_planning_status → get_routes; box↔stop matching via BOX-n orderNo references; explicit surfacing of geocode failures, unmatched boxes, duplicate stop assignments; hard errors (timeout 30s, auth, HTTP) shown with retry button; mismatches block the grid until acknowledged; box-list edits invalidate a completed sync.
- Near-duplicate address detection (same normalized street, unit stripped) flags all members of the group at scan time and again pre-sync.
- Load Grid: configurable columns, big stop numbers, name + truncated address, tap-to-mark-loaded (dim + checkmark, not color-only), loaded/total counter, box-order vs stop-order sort toggle, NO STOP red state for unmatched boxes.
- Settings: grid columns, OptimoRoute key/endpooint, optional CORS proxy, optional OCR.space key — all localStorage, nothing hardcoded.
- PWA: manifest, generated icons (192/512), service worker with app-shell precache + runtime caching of Tesseract CDN assets.

**Tested:** `node --check` on all JS (passes). NOT yet tested: real device camera/OCR, live OptimoRoute round-trip, CORS behavior from a browser.

**Known risks / open items:**
1. **CORS** — OptimoRoute's API likely lacks CORS headers for browser calls; the settings screen has a proxy field for this, but a proxy may need to be deployed before first live sync. Highest-risk unknown.
2. OptimoRoute response field names (`planning.status`, `stopNumber`) written from API docs knowledge, not verified against a live response — the first real sync may need small mapping fixes.
3. Address-parse heuristics untested on real Walmart labels; the manual-edit path is the safety net.
4. OCR.space returns no numeric confidence; a non-empty cloud result is treated as 80%.
