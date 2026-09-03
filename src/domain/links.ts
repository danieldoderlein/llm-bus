/**
 * Shared artifact-link normalizer for the v2 model (decision 039): both tasks and posts may carry a
 * small set of external artifact links ([{label,url}]). The bus stores links + labels only, never the
 * artifact itself ("attach a link, not a blob"). This bounds the STORED shape (count/length, url
 * present); text-safety at RENDER is invariant 4's job (esc() + an http(s) guard on the web surface),
 * not this function's. Lives in a neutral module so domain/task.ts and domain/post.ts can both use it
 * without an import cycle (task.ts already imports post.ts).
 */
export interface LinkRow {
  label: string;
  url: string;
}

export function normalizeLinks(links: unknown): LinkRow[] | null {
  if (links == null) return null;
  if (!Array.isArray(links)) throw new Error("links must be an array of {label,url}");
  const out = links.slice(0, 10).map((l) => {
    const label = String((l as { label?: unknown }).label ?? "").slice(0, 120);
    const url = String((l as { url?: unknown }).url ?? "").slice(0, 2000);
    if (!url) throw new Error("each link needs a url");
    return { label, url };
  });
  return out.length ? out : null;
}
