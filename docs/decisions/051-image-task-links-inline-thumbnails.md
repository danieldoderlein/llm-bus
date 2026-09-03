# 051 - Image task-links render as inline thumbnails (link-not-blob, no picture host)

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, 2026-08-12). Refines
[041](041-task-board-list-and-detail.md) (the task detail page's link rendering). Number claimed on the bus
(`claim("decisions")` -> 051). Closes bus task 457.

## Context

The operator wanted to attach pictures (screenshots) to tasks without the bus becoming a picture-dump service.
The decision (chosen from options, 2026-08-12): keep the standing **"attach a link, not a blob"** rule - the
bus stores only `{label, url}`, never image bytes - and let the human paste an image URL from a capture tool
that already yields one (CleanShot X / Dropbox upload-on-capture). To make that useful, the task detail page
should **preview** an image link inline instead of showing a bare hyperlink. We preview; we never host.

## Decision

Presentation only, in `src/admin/html.ts` (no schema, no new tool, no query change):

1. **`isImageUrl(url)`** - true only when `isHttpUrl(url)` (http/https scheme; no `javascript:`/`data:`) AND the
   URL **path** ends in a raster image extension (`png|jpe?g|gif|webp|avif`), read from the path only (query
   string ignored). SVG is deliberately excluded (an `<img>`-embedded SVG can still pull external content;
   screenshots are raster regardless).

2. **`renderTaskLinks`** renders an image link as an inline thumbnail: an anchor to the URL wrapping
   `<img src loading="lazy" onerror="this.remove()">` plus the label as a caption. The `src` is `esc()`'d and
   scheme-gated by `isImageUrl`. If the image fails to load (not really an image, 404, host-blocked) the `img`
   removes itself, leaving the caption - which is the **same link target** - so nothing is lost and the link
   always works. Non-image links keep the existing text-anchor rendering (behind `isHttpUrl`).

## Non-goals / boundary

The bus stores no image bytes - only the `{label, url}` it already stored (invariant: "attach a link, not a
blob"). No upload endpoint, no bucket, no picture-dump service (the option the operator explicitly declined).
Invariant 4 holds: the URL is `esc()`'d and the scheme is gated (`isImageUrl` -> `isHttpUrl`), so no
`javascript:`/`data:` `src`. The browser (client-side) fetches the external image - no server fetch, so no
SSRF; the only cost is a request (referer + owner IP + timestamp) to the image host.

**Threat model - who chooses the URL (corrected after review).** Task-link URLs are **agent-supplied**: the MCP
`task_create`/`task_update` tools accept `url` with no scheme validation at ingest (validation is render-time
only). So the host is chosen by whichever agent authored the link - not necessarily the human viewing it, and in
a multi-member project potentially **another member's** agent. Auto-rendering that URL as an `<img>` is
therefore a tracking-pixel/web-bug vector: an agent can plant `https://host/beacon.png` and learn that the owner
opened the task (owner IP + timestamp + an origin-level `Referer`, since admin responses set no `referrer-policy`).
It is **client-side only** (no SSRF, no llm-bus credential leak - cross-origin), leaks no task content, and is the
standard behavior of inline images in every tool (Slack/email/GitHub proxy images to blunt it - which is exactly
the hosting the operator declined). Recorded **Accepted-no-fix**: inherent to previewing external images; the
only real mitigation is proxy/host (declined); residual leak (view-time + owner IP to an agent-chosen host) is
low-sensitivity in this deployment. Optional future hardening: `Referrer-Policy: no-referrer` on admin responses
(blunts the origin `Referer` leak, not the IP/timing beacon) and/or a click-to-load placeholder (defeats the
see-it-inline purpose). The `onerror` is a static inline handler consistent with the admin's existing inline
handlers; no CSP blocks it, and none is set that would block the external `img-src`.

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` extended: `isImageUrl`
accepts http(s) png/jpg (case-insensitive, query ignored) and rejects extension-in-query / svg / non-http /
no-extension; an image link renders `class="linkimg"` + `<img src>` + `onerror` + the caption; a non-image link
stays a plain text link. (Visual screenshot skipped: an external image URL does not reliably load in the
headless sandbox and would collapse to the caption via `onerror`; the branch logic and markup are unit-tested.)

## Reviews

Gatekeeper + a security-focused code-review. **Code CLEAN on every exploitable axis** (verified by both):
XSS/attribute-injection (both `"` and `'` are `esc()`'d, no attribute breakout), scheme bypass (`isImageUrl`
short-circuits on `isHttpUrl` first; Node's WHATWG parser matches the browser's, so no parse-differential -
`javascript:...//a.png` and `data:...#.png` both rejected), the `onerror` is a fixed literal (no user input
reaches an inline handler), no SSRF (no server fetch introduced), and the `isImageUrl` matrix is correct
(case-insensitive, query ignored, svg/non-http/no-ext rejected). All seven invariants intact; verify green with
the load-bearing tests unweakened.

**Fixed-before-merge:** the decision's threat-model wording said the image host was "the one the human chose" -
inaccurate. Corrected above: task-link URLs are agent-supplied, so the tracking-pixel vector is real (an agent,
incl. a cross-member one, can beacon the owner's task-view). **Accepted-no-fix** (recorded, per §11): the beacon
is inherent to previewing external images; the only real fix is proxy/host, which the operator declined; the
residual leak is low-sensitivity here. `Referrer-Policy: no-referrer` on admin responses is noted as optional
future hardening (it blunts only the origin `Referer`, not the IP/timing beacon), deliberately NOT bundled here
to keep this decision scoped to the preview feature rather than slip a cross-cutting admin security header in
without its own verification.

Refines 041.
