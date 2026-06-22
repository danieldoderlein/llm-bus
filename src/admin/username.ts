import { query } from "../db.js";

// Decision 018: every owner gets a globally-unique public handle (their bus identity). Seeded from the
// email local-part (always present; the first-run confirm step lets the owner change it), sanitized to
// a safe handle charset. The handle is the prefix of every qualified actor `handle/label`.

const MAX_LEN = 32;

/** Derive a candidate handle from an email: local-part, lowercased, `[a-z0-9-]` only, collapsed/trimmed
 *  dashes, length-capped. Falls back to "user" if nothing survives (then allocate disambiguates). */
export function deriveUsername(email: string): string {
  const local = email.split("@")[0] ?? "";
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_LEN)
    .replace(/-+$/g, "");
  return base || "user";
}

/**
 * Assign `ownerId` a globally-unique handle, idempotently. If it already has one, return it. Otherwise
 * try `base`, then `base-2`, `base-3`, ... until the partial unique index (`uq_owners_username`,
 * case-insensitive) accepts one. Mirrors the ON CONFLICT retry style used for participant names.
 */
export async function allocateUsername(ownerId: number, base: string): Promise<string> {
  const existing = await query<{ username: string | null }>(`SELECT username FROM owners WHERE id = $1`, [
    ownerId,
  ]);
  const current = existing.rows[0]?.username;
  if (current) return current;

  for (let n = 1; n <= 9999; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    try {
      const r = await query<{ username: string }>(
        `UPDATE owners SET username = $2 WHERE id = $1 RETURNING username`,
        [ownerId, candidate],
      );
      return r.rows[0].username;
    } catch (e) {
      // 23505 = unique_violation on uq_owners_username (handle taken by another owner); try the next.
      if ((e as { code?: string })?.code === "23505") continue;
      throw e;
    }
  }
  throw new Error(`could not allocate a unique username for owner ${ownerId}`);
}

/** Get-or-assign the handle for an owner with a known email. The single entry point used by
 *  resolveOwner (login-time incremental backfill) and the one-off backfill script. */
export async function ensureUsername(ownerId: number, email: string): Promise<string> {
  return allocateUsername(ownerId, deriveUsername(email));
}

// A valid handle: 2-32 chars, lowercase letters/numbers/dashes, no leading/trailing dash, no slash
// (slash is the `handle/label` separator).
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;

/** Owner-chosen handle change (the first-run confirm / settings edit). Validates the format, enforces
 *  global uniqueness via the index, and marks the handle confirmed. Idempotent when set to itself. */
export async function changeUsername(
  ownerId: number,
  desired: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const h = desired.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) {
    return { ok: false, error: "Handle must be 2-32 chars: lowercase letters, numbers, dashes (no leading/trailing dash)." };
  }
  try {
    const r = await query<{ username: string }>(
      `UPDATE owners SET username = $2, username_confirmed_at = now() WHERE id = $1 RETURNING username`,
      [ownerId, h],
    );
    return { ok: true, username: r.rows[0].username };
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") return { ok: false, error: "That handle is taken - try another." };
    throw e;
  }
}
