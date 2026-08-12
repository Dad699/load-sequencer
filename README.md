# Load Sequencer

Phone PWA for a last-mile delivery load-out: scan box labels in physical stacking order, sync addresses to OptimoRoute, then match each box to its stop number on a floor grid before departure.

## Run it

It's a static site — no build step. Serve the folder over **HTTPS** (or `localhost`); the camera and service worker require a secure context:

```
npx http-server -S    # or any static host: GitHub Pages, Netlify, etc.
```

On the phone, open the URL and use "Add to Home Screen" to install it.

## First-time setup (⚙️ Setup tab)

1. **OptimoRoute API key** — from OptimoRoute admin → Settings → WS API. Stored in localStorage on-device only.
2. **Boxes per row** — how many boxes wide the floor line-up is (drives the grid layout).
3. **OCR.space key (optional)** — free tier at ocr.space; used as a cloud fallback when on-device OCR reads a label with low confidence.
4. **CORS proxy (optional)** — the OptimoRoute API may not allow direct browser calls (no CORS headers). If sync fails with a network error on good connectivity, deploy a trivial pass-through proxy (e.g. a Cloudflare Worker that forwards to `api.optimoroute.com` and adds `Access-Control-Allow-Origin`) and put its URL here. **This is the most likely thing to bite on night 1 — test one sync from the phone before scan day.**

## Daily flow

1. **Scan** — capture each label in the exact order boxes are lined up. Confirm (or fix) the name/address the OCR read. Low-confidence reads get a yellow border and demand attention before confirm. Edit/delete/reorder from the "Logged boxes" list; deletion renumbers automatically.
2. **Sync** — sends `BOX-n` references + addresses to OptimoRoute (create orders → plan → fetch routes). Any geocode failure, unmatched box, or two boxes on one stop is listed loudly and blocks the grid until explicitly acknowledged. Editing the box list after a sync invalidates it — re-sync.
3. **Grid** — big stop numbers laid out in floor order. Tap a box when it's physically loaded. Toggle to stop-order sort for a final sanity pass. Boxes with no stop show **NO STOP** in red.

Everything persists in localStorage — backgrounding, phone lock, or an app kill mid-scan resumes where you left off.

## Test checklist before trusting a real 40–100 box load

- [ ] OCR on a dented / glare-y / angled label, not just a clean flat one
- [ ] Mid-scan interruption (background the app, lock the phone) doesn't lose progress
- [ ] Delete/renumber a box mid-list; verify the rest of the sequence
- [ ] Kill WiFi mid-sync: verify a visible error + retry, no silent hang
- [ ] Two boxes, same street different apt: verify both get flagged
- [ ] Full loop on 10–15 boxes, checked against OptimoRoute's own dashboard
- [ ] One sync from the actual phone on warehouse WiFi (CORS proxy check)
