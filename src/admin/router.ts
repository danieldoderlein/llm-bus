import type http from "node:http";

// Minimal routing helpers for the web admin, stdlib only. Routes are matched against the path
// AFTER the leading `/admin` is stripped, so "/admin/projects/7" matches against "/projects/7".

const MAX_FORM_BYTES = 64 * 1024;

/** Strip a single leading `prefix` (e.g. "/admin"); the bare prefix and prefix+"/"
 *  both become "/". A trailing slash on a deeper path is trimmed. */
export function stripPrefix(pathname: string, prefix: string): string {
  let p = pathname;
  if (p === prefix) return "/";
  if (p.startsWith(prefix + "/")) p = p.slice(prefix.length);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

/** Strip a single leading "/admin" prefix; "/admin" and "/admin/" both become "/". */
export function stripAdminPrefix(pathname: string): string {
  return stripPrefix(pathname, "/admin");
}

/**
 * Match a path against a pattern with a single `:id` segment, e.g. "/projects/:id".
 * Returns the captured id as a number (NaN if non-numeric — the caller's loadOwned* guard
 * then returns null and the handler 404s), or null if the path shape doesn't match.
 */
export function matchId(pattern: string, path: string): number | null {
  const pp = pattern.split("/");
  const ap = path.split("/");
  if (pp.length !== ap.length) return null;
  let id: number | null = null;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === ":id") {
      id = Number(ap[i]);
    } else if (pp[i] !== ap[i]) {
      return null;
    }
  }
  return id;
}

/** Read and parse a small urlencoded form body. Caps size to bound memory. */
export async function readForm(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_FORM_BYTES) throw new Error("form body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const out: Record<string, string> = {};
  const params = new URLSearchParams(raw);
  for (const [k, v] of params) out[k] = v;
  return out;
}
