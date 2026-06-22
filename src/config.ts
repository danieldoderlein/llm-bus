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

    // --- Email (funding alerts). Optional; falls back to logging when SMTP_HOST/SMTP_FROM unset.
    // Sized for the Google Workspace SMTP relay (IP-allowlisted, no auth). ---
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_FROM: z.string().optional(), // e.g. "LLM Bus <support@llm-bus.com>"
  })
  .refine((c) => c.CLOUD_SQL_INSTANCE != null || (c.DATABASE_URL != null && c.DATABASE_URL.length > 0), {
    message: "DATABASE_URL is required unless CLOUD_SQL_INSTANCE is set",
    path: ["DATABASE_URL"],
  });

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
