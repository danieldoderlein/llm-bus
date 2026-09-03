import { z } from "zod";

const EnvSchema = z
  .object({
    // Required for the direct-pool (VM) path; optional when the Cloud SQL connector is used
    // (CLOUD_SQL_INSTANCE set). The .refine below enforces "one of the two".
    DATABASE_URL: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(8787),
    PUBLIC_URL: z.string().default("http://127.0.0.1:8787"),
    NODE_ENV: z.string().default("development"),
    // Header (lower-case; Node lower-cases header names) carrying the SSO-verified email for
    // /admin. Trusted only because Caddy strips any client-supplied copy (see ops/caddy/yolo.caddy).
    ADMIN_EMAIL_HEADER: z.string().default("x-auth-request-email"),

    // --- Hosted (Cloud Run + Cloud SQL) options. All optional; unset = current VM behavior. ---
    // Deploy topology. "vm" (default) binds 127.0.0.1 behind Caddy; "cloudrun" binds 0.0.0.0 and the
    // platform provides the network boundary + TLS (decision 009; relaxes invariant 7's bind clause).
    RUN_PLATFORM: z.enum(["vm", "cloudrun"]).default("vm"),
    // Address to bind. Defaults to the historical 127.0.0.1; Cloud Run sets 0.0.0.0.
    BIND_ADDRESS: z.string().default("127.0.0.1"),
    // When set, db.ts uses the Cloud SQL Node connector (IAM auth, no password) instead of
    // DATABASE_URL. Format: "project:region:instance".
    CLOUD_SQL_INSTANCE: z.string().optional(),
    // The IAM database user and database name for the connector path.
    CLOUD_SQL_IAM_USER: z.string().optional(),
    DB_NAME: z.string().optional(),
    // Cloud SQL IP type for the connector. PUBLIC by default; PRIVATE/PSC for VPC-egress deploys.
    CLOUD_SQL_IP_TYPE: z.enum(["PUBLIC", "PRIVATE", "PSC"]).default("PUBLIC"),
    // Admin identity source. "header" (default) trusts the Caddy-stripped SSO header (invariant 4);
    // "oauth" establishes the session from a verified in-app OAuth login (decision 010). Opt-in only.
    ADMIN_AUTH_SOURCE: z.enum(["header", "oauth"]).default("header"),
    // OAuth client credentials (only required when ADMIN_AUTH_SOURCE=oauth; supplied via the
    // platform secret store, never committed).
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    // Base URL the OAuth providers redirect back to (e.g. https://app.example.com). Defaults to
    // PUBLIC_URL when unset.
    OAUTH_REDIRECT_BASE: z.string().optional(),

    // --- Stripe billing (decision 011). All optional; billing is INERT when STRIPE_SECRET_KEY is
    // unset, so dev/self-host without Stripe works and the suite stays green. Live keys are supplied
    // via the platform secret store, never committed. ---
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PORTAL_RETURN_URL: z.string().optional(), // defaults to the dashboard host /admin
    // Credit dials (1 token = 1 NOK). All defaulted; billing is inert when STRIPE_SECRET_KEY is unset.
    TRIAL_GRANT_TOKENS: z.coerce.number().int().nonnegative().default(50), // no-card trial
    WELCOME_GRANT_TOKENS: z.coerce.number().int().nonnegative().default(100), // on card-on-file
    RECHARGE_THRESHOLD: z.coerce.number().int().nonnegative().default(10), // auto-recharge below this
    RECHARGE_MAX_FAILURES: z.coerce.number().int().positive().default(3), // suspend after N declines
    SUSPEND_AFTER_HOURS: z.coerce.number().int().positive().default(48), // delinquency -> suspension (016)
    // Free-beta master switch (decision 059, refines 015/016). ON => the meter treats EVERY owner like
    // `comped` (no debit; the cursor still fast-forwards so ending beta never retro-bills; no auto-recharge;
    // no delinquency/suspension) AND the auth suspension gate is bypassed. Default OFF = current live billing.
    // Explicit "1"/"true" allowlist - NOT z.coerce.boolean(), which maps "0"/"false" to TRUE (a money footgun).
    // Anything but "1"/"true" (unset, "0", "false", garbage) parses to false and never throws.
    BETA_FREE: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),

    // --- Email (funding alerts). Optional; falls back to logging when SMTP_HOST/SMTP_FROM unset.
    // Sized for the Google Workspace SMTP relay (IP-allowlisted, no auth). ---
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    // Must be an email or "Name <email>". Validated so a malformed value fails LOUD at boot instead of
    // silently at send time: a truncated `SMTP_FROM=LLM` (systemd split an unquoted "LLM Bus <...>" on
    // whitespace) sent `MAIL FROM:<LLM>` and every email died with 553 - unnoticed for weeks. The
    // extraction mirrors email/smtp.ts addressOf (kept inline; config stays a leaf module).
    SMTP_FROM: z
      .string()
      .refine(
        (s) => {
          const addr = s.match(/<([^>]+)>/)?.[1] ?? s.trim();
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
        },
        { message: 'SMTP_FROM must be an email or "Name <email>" (the address needs an @ and a domain)' },
      )
      .optional(), // e.g. "LLM Bus <bus@example.com>"
    // Optional authenticated send (support@ via a Gmail app password). When both are set the sender
    // does AUTH LOGIN over TLS; unset = the IP-allowlisted relay. SMTP_PASSWORD comes from Secret
    // Manager (YOLO_SMTP_PASSWORD), never committed; SMTP_USER from the unit. Operational, private.
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    // Secret keying the HMAC that signs the daily-digest settings/unsubscribe magic links (decision 025).
    // Required whenever SMTP is configured (the send path), so an emailed link always verifies; from
    // Secret Manager, never committed. Unset is only valid with no SMTP (dev/self-host/test: no emails).
    NOTIFY_SECRET: z.string().min(16).optional(),
    // Prod-safety master switch for the welcome + activation-nudge lifecycle emails (decision 029).
    // Default "false" so a deploy is INERT - the send loop emails ZERO real owners until an operator
    // explicitly flips this to "true" (ops/README enable step). Kept SEPARATE from the SMTP/NOTIFY_SECRET
    // gate on purpose: prod already has SMTP + NOTIFY_SECRET (the digest), so those alone can't be the
    // guard for a brand-new emailing feature on a live billing system. NOT boot-required.
    LIFECYCLE_EMAILS_ENABLED: z.enum(["true", "false"]).default("false"),

    // Landing-page KPIs (decision: dogfooding proof). When set, /api/stats is scoped to THIS owner's
    // projects (the operator's own usage) instead of cross-tenant, so the public numbers are
    // our real coordination. Unset = cross-tenant aggregate (self-host / open-engine default).
    STATS_OWNER_EMAIL: z.string().optional(),

    // --- Web analytics. Optional; unset = no analytics, no banner (self-host/dev default). When set
    // to a GA4 Measurement ID (G-XXXXXXX) the landing page loads gtag.js under Consent Mode v2
    // (analytics_storage denied by default) plus a cookie banner that grants consent on accept. The
    // id is public (it ships in client JS), so it is config, not a secret. ---
    GA_MEASUREMENT_ID: z
      .string()
      .regex(/^G-[A-Z0-9]+$/, "GA_MEASUREMENT_ID must look like G-XXXXXXX")
      .optional(),
  })
  .refine((c) => c.CLOUD_SQL_INSTANCE != null || (c.DATABASE_URL != null && c.DATABASE_URL.length > 0), {
    message: "DATABASE_URL is required unless CLOUD_SQL_INSTANCE is set",
    path: ["DATABASE_URL"],
  })
  // Email config must be internally complete, so a half-configured sender fails loud at boot rather
  // than silently degrading to logging / the unauthenticated relay at send time.
  .refine((c) => !c.SMTP_HOST || (c.SMTP_FROM != null && c.SMTP_FROM.length > 0), {
    message: "SMTP_FROM is required when SMTP_HOST is set (otherwise email silently logs instead of sending)",
    path: ["SMTP_FROM"],
  })
  .refine((c) => (c.SMTP_USER == null) === (c.SMTP_PASSWORD == null), {
    message: "SMTP_USER and SMTP_PASSWORD must be set together (one alone silently falls back to the relay)",
    path: ["SMTP_USER"],
  });
// NOTE: NOTIFY_SECRET is deliberately NOT boot-required even when SMTP is set. Prod already runs with
// SMTP configured (billing notices); making the secret a boot dependency would crash the whole app if it
// were missing. Instead the digest FEATURE (not app boot) gates on it: the send loop stays inert + warns
// when NOTIFY_SECRET is unset, so links are never signed with the forgeable dev fallback (decision 025).

export type Config = z.infer<typeof EnvSchema>;

/** Parse + validate process.env. Throws a clear error if anything required is missing. */
export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
