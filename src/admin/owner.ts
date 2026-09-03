import { query, withTx } from "../db.js";
import { loadConfig } from "../config.js";
import { billingEnabled } from "../billing/stripe.js";
import { applyCredit } from "../billing/credits.js";
import { ensureUsername } from "./username.js";

/** An owner as the admin UI needs it. `isOperator` is the bootstrap superuser flag. */
export interface Owner {
  id: number;
  email: string;
  username: string; // the globally-unique handle (decision 018); always set after resolveOwner
  usernameConfirmed: boolean; // false until the owner confirms/edits it on first run
  isOperator: boolean;
  plan: "free" | "team" | "comped";
  suspendedAt: string | null;
  tokenBalance: number;
  autoRechargeAmount: number | null;
  hasCard: boolean;
}

/**
 * Get-or-create the owner for an SSO-verified email. Idempotent: a repeated login
 * returns the same row. The no-op `DO UPDATE` exists so `RETURNING` fires on conflict
 * (ON CONFLICT DO NOTHING returns no row when the email already exists). On first creation a
 * no-card trial credit is granted (decision 015), gated by billingEnabled so dev/self-host and
 * the test suite see no balance changes.
 *
 * `opts.landingVariant` (decision 027, gap-B) is UNTRUSTED conversion metadata: it is written to the
 * `landing_variant` column ONLY on a fresh INSERT (the ON CONFLICT path does NOT touch it, so a repeat
 * login never overwrites it) and re-validated here to the closed enum as defense in depth. It NEVER
 * affects which owner resolves - identity derives solely from the email conflict key (invariant 1).
 */
export async function resolveOwner(
  email: string,
  opts?: { landingVariant?: "everyone" | "dev" | null; channel?: string | null },
): Promise<Owner> {
  const normalized = email.trim().toLowerCase(); // avoid duplicate owners from IdP case/space variance
  // Re-validate to the enum: only 'everyone'|'dev' ever reaches SQL (parameterized regardless), else NULL.
  const variant =
    opts?.landingVariant === "everyone" || opts?.landingVariant === "dev" ? opts.landingVariant : null;
  // Re-validate the channel to the same charset as the capture sanitizer (decision 031): belt-and-
  // suspenders before it reaches SQL, else NULL. Stamped once on create; never read into identity.
  const channel =
    typeof opts?.channel === "string" && /^[a-z0-9._-]{1,64}$/.test(opts.channel) ? opts.channel : null;
  const res = await query<{
    id: string;
    email: string;
    is_operator: boolean;
    plan: "free" | "team" | "comped";
    suspended_at: string | null;
    token_balance: string;
    auto_recharge_amount: number | null;
    stripe_payment_method_id: string | null;
    username: string | null;
    username_confirmed_at: string | null;
    created: boolean;
  }>(
    `INSERT INTO owners (email, landing_variant, acquisition_channel) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, is_operator, plan, suspended_at, token_balance,
               auto_recharge_amount, stripe_payment_method_id, username, username_confirmed_at,
               (xmax = 0) AS created`,
    [normalized, variant, channel],
  );
  const r = res.rows[0];
  let tokenBalance = Number(r.token_balance);

  if (r.created && billingEnabled()) {
    const cfg = loadConfig();
    const granted = await withTx((c) =>
      applyCredit(c, Number(r.id), "grant", cfg.TRIAL_GRANT_TOKENS, "trial", "No-card trial credit"),
    );
    if (granted) tokenBalance += cfg.TRIAL_GRANT_TOKENS;
  }

  // Decision 018: ensure a globally-unique handle. Idempotent - assigned once (on first creation, or
  // login-time incremental backfill for a pre-existing owner that has none yet), reused thereafter.
  const username = r.username ?? (await ensureUsername(Number(r.id), normalized));

  return {
    id: Number(r.id),
    email: r.email,
    username,
    usernameConfirmed: r.username_confirmed_at != null,
    isOperator: r.is_operator,
    plan: r.plan,
    suspendedAt: r.suspended_at ? new Date(r.suspended_at).toISOString() : null,
    tokenBalance,
    autoRechargeAmount: r.auto_recharge_amount,
    hasCard: r.stripe_payment_method_id != null,
  };
}

/**
 * Record (idempotently) that an OAuth provider identity belongs to this owner. Keyed by
 * (provider, provider_subject) so a re-login with the same provider account updates the email
 * mapping rather than duplicating. Used only by the in-app OAuth path (decision 010).
 */
export async function linkProviderIdentity(
  ownerId: number,
  provider: string,
  subject: string,
  email: string,
): Promise<void> {
  await query(
    `INSERT INTO owner_identities (owner_id, provider, provider_subject, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_subject)
       DO UPDATE SET owner_id = EXCLUDED.owner_id, email = EXCLUDED.email`,
    [ownerId, provider, subject, email.trim().toLowerCase()],
  );
}
