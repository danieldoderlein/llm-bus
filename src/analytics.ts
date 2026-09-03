// Analytics seam - INERT in the open-source build.
//
// Decision 021 routes every server-rendered page through this chokepoint rather than hand-rolling a
// tag per page, so the hosted build can have analytics and this one can have none WITHOUT the two
// diverging structurally. Keeping the seam (instead of deleting the calls) is what makes that true:
// a page added here still goes through gaHead()/cookieBanner() and still renders correctly.
//
// Self-hosting and want analytics? Return your own tag from gaHead() and your own consent UI from
// cookieBanner(). Nothing else in the codebase needs to change.

/** No tag in the OSS build. Returns markup for <head>. */
export function gaHead(_params?: Record<string, string>): string {
  return "";
}

/** No consent banner, because nothing is being collected. */
export function cookieBanner(): string {
  return "";
}

export function analyticsEnabled(): boolean {
  return false;
}
