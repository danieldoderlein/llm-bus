-- LLM Bus v2 schema. Idempotent. Owner-centric model (decision 006).
-- owner -> project ; owner -> participant ; (participant x project) -> participation -> token.
-- Coordination tables are project-scoped and attributed to a participation; the displayed
-- attribution name (actor_name column, kept by name to minimize churn) = participant.name.

-- ── Identity / billing spine ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owners (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  stripe_customer_id  TEXT UNIQUE,                    -- nullable; for later billing
  is_operator         BOOLEAN NOT NULL DEFAULT false, -- the bootstrap/superuser owner
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','human')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_participants_owner ON participants (owner_id);

CREATE TABLE IF NOT EXISTS projects (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id            BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  name                TEXT NOT NULL,
  liveness_window_sec INTEGER NOT NULL DEFAULT 900,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)                              -- slug unique per owner (routing is by token, not slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);

CREATE TABLE IF NOT EXISTS participations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  participant_id  BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lane            TEXT,
  is_admin        BOOLEAN NOT NULL DEFAULT false,      -- project-admin: gates the in-MCP admin_provision tool
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (participant_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_participations_project ON participations (project_id);
CREATE INDEX IF NOT EXISTS idx_participations_participant ON participations (participant_id);

CREATE TABLE IF NOT EXISTS tokens (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  participation_id  BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  label             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_participation ON tokens (participation_id);

-- ── Coordination tables (project-scoped, attributed to a participation) ────
-- RENAME MAP vs v1: workspace_id -> project_id ; actor_id -> participation_id.
-- actor_name column name kept (= participant.name) to keep domain SQL rename-light.

CREATE TABLE IF NOT EXISTS sequences (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  current     BIGINT NOT NULL DEFAULT 0,
  prefix      TEXT NOT NULL DEFAULT '',
  pad         INTEGER NOT NULL DEFAULT 0 CHECK (pad >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS presence (
  participation_id  BIGINT PRIMARY KEY REFERENCES participations(id) ON DELETE CASCADE,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lane              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT '',
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_presence_proj_seen ON presence (project_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  participation_id  BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  actor_name        TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN (
                      'claim','seed','register','post','ack','lease','release',
                      'task_create','task_assign','task_start','task_block','task_resolve','task_ship')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_events_proj_id    ON events (project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_proj_type  ON events (project_id, type);
CREATE INDEX IF NOT EXISTS idx_events_proj_actor ON events (project_id, actor_name);
CREATE INDEX IF NOT EXISTS idx_events_proj_seq   ON events (project_id, (payload->>'sequence'));
CREATE INDEX IF NOT EXISTS idx_events_proj_ts    ON events (project_id, ts);

CREATE TABLE IF NOT EXISTS posts (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id            BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id              BIGINT NOT NULL REFERENCES events(id),
  from_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  from_actor_name       TEXT NOT NULL,
  to_lane               TEXT,
  to_participation_id   BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  subject               TEXT,
  body                  TEXT NOT NULL,
  ref                   TEXT,
  tag                   TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_lane IS NOT NULL OR to_participation_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_posts_proj_lane  ON posts (project_id, to_lane);
CREATE INDEX IF NOT EXISTS idx_posts_proj_actor ON posts (project_id, to_participation_id);
CREATE INDEX IF NOT EXISTS idx_posts_proj_tag   ON posts (project_id, tag);
CREATE INDEX IF NOT EXISTS idx_posts_proj_id    ON posts (project_id, id DESC);

CREATE TABLE IF NOT EXISTS post_acks (
  post_id           BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  participation_id  BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  actor_name        TEXT NOT NULL,
  acked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, participation_id)
);

CREATE TABLE IF NOT EXISTS leases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface           TEXT NOT NULL,
  participation_id  BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  actor_name        TEXT NOT NULL,
  note              TEXT,
  acquired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_leases_proj_surface ON leases (project_id, surface) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leases_proj_expiry  ON leases (project_id, expires_at) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id             BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  detail                 TEXT,
  lane                   TEXT,
  owner_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL,   -- task assignee (NOT the Owner entity)
  owner_name             TEXT,
  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','assigned','in_progress','blocked','done')),
  created_by_id          BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status ON tasks (project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_owner  ON tasks (project_id, owner_participation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_lane   ON tasks (project_id, lane);

CREATE TABLE IF NOT EXISTS task_blockers (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id            BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_on_task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,   -- NULL = blocked with no specific task
  reason             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_blockers_open ON task_blockers (task_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS actor_cursors (
  participation_id  BIGINT PRIMARY KEY REFERENCES participations(id) ON DELETE CASCADE,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  last_event_id     BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project invite codes (pairing flow): an owner/lead mints a short-lived, project-scoped code;
-- the invitee redeems it at the public POST /join endpoint to self-mint a participation token.
CREATE TABLE IF NOT EXISTS join_codes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  project_id     BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intended_name  TEXT,                                          -- if set, the redeemer must use this name; else they choose
  kind           TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','human')),
  lane           TEXT,
  is_admin       BOOLEAN NOT NULL DEFAULT false,
  max_uses       INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses           INTEGER NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_join_codes_code    ON join_codes (code);
CREATE INDEX IF NOT EXISTS idx_join_codes_project ON join_codes (project_id);

-- ── Idempotent upgrades (safe to re-run every migrate) ─────────────────────
-- Allow deleting a participant/participation while PRESERVING the denormalized actor_name
-- history: the participation FKs become ON DELETE SET NULL and their columns nullable, so a
-- delete drops the link but the ledger still reads "<actor_name> did X". Re-running is a no-op.
ALTER TABLE events ALTER COLUMN participation_id DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_participation_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_participation_id_fkey
  FOREIGN KEY (participation_id) REFERENCES participations(id) ON DELETE SET NULL;

ALTER TABLE posts ALTER COLUMN from_participation_id DROP NOT NULL;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_from_participation_id_fkey;
ALTER TABLE posts ADD CONSTRAINT posts_from_participation_id_fkey
  FOREIGN KEY (from_participation_id) REFERENCES participations(id) ON DELETE SET NULL;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_to_participation_id_fkey;
ALTER TABLE posts ADD CONSTRAINT posts_to_participation_id_fkey
  FOREIGN KEY (to_participation_id) REFERENCES participations(id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_owner_participation_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_owner_participation_id_fkey
  FOREIGN KEY (owner_participation_id) REFERENCES participations(id) ON DELETE SET NULL;
ALTER TABLE tasks ALTER COLUMN created_by_id DROP NOT NULL;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_created_by_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_id_fkey
  FOREIGN KEY (created_by_id) REFERENCES participations(id) ON DELETE SET NULL;
-- The HUMAN author of a web-created task (decision 055 / task 541). created_by_id is a participation FK, but
-- a human authoring via /admin is not a participation, so it was left NULL and the board showed no "from".
-- This records the authoring human directly (the board COALESCEs it in when created_by_id is NULL). Additive,
-- nullable, ON DELETE SET NULL (invariant 6 - never cascade a task away with its author).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_owner_id BIGINT REFERENCES owners(id) ON DELETE SET NULL;

-- Request-to-join (decision 020): per-project request mode. 'off' (default) keeps existing projects
-- closed to inbound requests until an owner opts in to 'manual' (approve each) or 'auto' (grant on
-- request). Additive, reversible.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS request_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (request_mode IN ('off','manual','auto'));

-- ── Hosted service: in-app OAuth identities (decision 010) ─────────────────
-- Links a Google/GitHub login (provider + stable provider subject) to the email-keyed owner.
-- Used only when ADMIN_AUTH_SOURCE=oauth; the live header-mode service never touches it. Additive.
CREATE TABLE IF NOT EXISTS owner_identities (
  owner_id          BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  provider          TEXT   NOT NULL,                 -- 'google' | 'github'
  provider_subject  TEXT   NOT NULL,                 -- the provider's stable user id (sub / numeric id)
  email             TEXT   NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_owner_identities_owner ON owner_identities (owner_id);

-- ── Hosted service: frictionless invite exchange (decision 010, phase 1) ───
-- The OAuth-accept analogue of the public /join (join_codes) flow. Only token_hash is stored
-- (invariant 7); created_by/accepted_by are ON DELETE SET NULL (invariant 6). Additive.
CREATE TABLE IF NOT EXISTS invites (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  project_id     BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_is_admin  BOOLEAN NOT NULL DEFAULT false,
  intended_name  TEXT,                                          -- locks the joiner's participant name if set
  lane           TEXT,
  kind           TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','human')),
  target_email   TEXT,                                          -- targeted invite; NULL = open
  reusable       BOOLEAN NOT NULL DEFAULT false,                -- phase 1 always false; reserved for phase 2
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','revoked')),
  created_by     BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  accepted_by    BIGINT REFERENCES owners(id) ON DELETE SET NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_token   ON invites (token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_project ON invites (project_id);

-- ── Request-to-join (decision 020): requester-initiated, owner-approved pull path ──────────
-- The inverse of invites: a signed-in owner requests access to a project (addressed by the owner's
-- handle + project slug); the project owner approves/denies, or the project's request_mode='auto'
-- grants on request. Approval mints a participation+token under the PROJECT owner (invariant 3) via
-- the shared grantParticipation(). requester_owner_id/decided_by/granted_participation_id are
-- ON DELETE SET NULL and requester_handle is snapshotted, so the request ledger survives deletion
-- (invariant 6). Additive + idempotent.
CREATE TABLE IF NOT EXISTS join_requests (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id               BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requester_owner_id       BIGINT REFERENCES owners(id) ON DELETE SET NULL,
  requester_handle         TEXT NOT NULL,                          -- snapshot; survives owner deletion
  note                     TEXT,                                   -- bounded in app code
  state                    TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied')),
  granted_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  decided_by               BIGINT REFERENCES owners(id) ON DELETE SET NULL,
  decided_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_join_requests_project_state ON join_requests (project_id, state);
-- One open request per requester per project (also the approve-race guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_join_requests_pending
  ON join_requests (project_id, requester_owner_id) WHERE state = 'pending';
-- Phase 2 (decision 020, 2026-07-06): the DELETE-IMMUNE claimed-once marker. granted_participation_id
-- is ON DELETE SET NULL, so deleting the granted participant would reset it and re-open the self-serve
-- claim (re-minting a token the owner just removed). claimed_at is a plain timestamp with no FK, so it
-- survives participant deletion - it, not granted_participation_id, is the exactly-once claim guard.
-- Additive, idempotent, reversible.
ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- ── Operator console + billing mirror (decisions 011, 013) ─────────────────
-- Additive owner columns: plan (billing tier, named by 011) and suspended_at (operator flag, 013;
-- not auth-enforced this pass). ADD COLUMN IF NOT EXISTS - reversible, idempotent.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','team','comped'));
ALTER TABLE owners ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- ── Usage-based prepaid credits (decision 015) ────────────────────────────
-- owners.plan + owners.stripe_customer_id already exist above. 1 token = 1 NOK; a token is debited
-- per billable ledger event by an OFF-hot-path reconciler (never in the claim/event transaction -
-- invariant 2). The webhook is the source of truth for grants/top-ups. Additive/idempotent.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS token_balance        BIGINT  NOT NULL DEFAULT 0;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS auto_recharge_amount INTEGER;            -- chosen top-up (NOK); NULL = off
ALTER TABLE owners ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS last_metered_event_id BIGINT NOT NULL DEFAULT 0;  -- meter high-water mark
ALTER TABLE owners ADD COLUMN IF NOT EXISTS recharge_fail_count   INTEGER NOT NULL DEFAULT 0;
-- Billing enforcement (decision 016): delinquency clock - set when a metered, non-comped owner's
-- balance is at/below zero and uncovered; cleared by a top-up that brings the balance > 0.
-- SUSPEND_AFTER_HOURS hours later the meter flips owners.suspended_at, which is now auth-enforced.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS delinquent_since      TIMESTAMPTZ;

-- Audit trail of every balance change (grants, top-ups, metered debits). ref is the idempotency key.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('grant','topup','debit')),
  amount        BIGINT NOT NULL,            -- signed tokens (grant/topup > 0, debit < 0)
  balance_after BIGINT NOT NULL,
  ref           TEXT,                        -- idempotency: 'trial' | 'welcome' | <stripe PI id> | 'meter:<eventId>'
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_owner ON credit_ledger (owner_id, id DESC);
-- Once-only guard for grants/top-ups (ON CONFLICT keys on this).
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_ref ON credit_ledger (owner_id, ref) WHERE ref IS NOT NULL;

-- Webhook idempotency: same insert-or-skip discipline as claim (ON CONFLICT (id) DO NOTHING).
CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT PRIMARY KEY,                          -- Stripe event id (evt_...)
  type          TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Decision 018: global handle identity ──────────────────────────────────
-- Every owner gets a globally-unique public handle (their bus identity); a participant is a
-- sub-identity `handle/label`. Additive + reversible (backfilled by scripts/backfill-handles.ts).
-- Username stays nullable so the column add never fails on live rows; the partial unique index
-- enforces case-insensitive global uniqueness only once a handle is set.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS username              TEXT;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS username_confirmed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_owners_username ON owners (lower(username)) WHERE username IS NOT NULL;
-- The sub-identity label under the handle; mirrors participants.name (R1), reusing UNIQUE(owner_id,name).
ALTER TABLE participants ADD COLUMN IF NOT EXISTS label TEXT;

-- ── Daily owner digest email (decision 025) ────────────────────────────────
-- A daily "what happened on your bus" brief per owner. Default-ON (why §6's unsubscribe must work);
-- digest_last_sent_at is both the send window and the compare-and-set double-send guard. The settings /
-- unsubscribe link needs NO stored token: it is an HMAC signature over the owner id (NOTIFY_SECRET),
-- verified statelessly, so a link in any email (even an old one) always works and nothing sensitive is
-- stored at rest (see src/notify/token.ts + decision 025 for why this beats a hashed-random token here).
-- All additive/idempotent; metadata-only on `owners` (no table rewrite).
ALTER TABLE owners ADD COLUMN IF NOT EXISTS digest_opt_in       BOOLEAN     NOT NULL DEFAULT true;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS digest_last_sent_at TIMESTAMPTZ;

-- ── Welcome + activation-nudge lifecycle emails (decision 029) ──────────────
-- Two one-shot lifecycle emails per owner, stamped when sent so they never re-send: welcome_sent_at
-- (first-run greeting) and nudge_sent_at (a 24h "connect an agent" nudge to owners who signed up but
-- never produced a non-billing event). Metadata-only on `owners`; additive + reversible; NO backfill -
-- these are deliberately NULL so a re-migrate never re-blasts, and the send loop's created_at clamp plus
-- the LIFECYCLE_EMAILS_ENABLED master switch keep existing prod owners from being retro-emailed (029).
ALTER TABLE owners ADD COLUMN IF NOT EXISTS welcome_sent_at     TIMESTAMPTZ;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS nudge_sent_at       TIMESTAMPTZ;

-- ── Landing A/B first-party variant attribution (decision 027, gap-B) ───────
-- The landing variant ('everyone' | 'dev') that a signup arrived from, captured from the untrusted
-- `llmbus_variant` query param and enum-validated before it reaches here. WRITE-ONLY conversion
-- metadata: it is stamped ONLY on first owner creation and NEVER read into identity/authz/scoping
-- (invariant 1). Additive, nullable, NO backfill - existing owners stay NULL (pre-instrumentation).
ALTER TABLE owners ADD COLUMN IF NOT EXISTS landing_variant TEXT;

-- ── Per-channel acquisition attribution (decision 031, task #114) ───────────
-- The acquisition CHANNEL a signup arrived through (e.g. 'r-mcp', 'showhn', 'x', 'creator-alice'),
-- captured from the untrusted `via` query param and sanitized to [a-z0-9._-]{1,64} before it reaches
-- here. Same posture as landing_variant: WRITE-ONCE conversion metadata, stamped ONLY on first owner
-- creation and NEVER read into identity/authz/scoping (invariant 1). Read only by the operator-only
-- cross-tenant funnel (operator-queries.acquisitionFunnel), never on the public /api/stats. An opaque
-- slug with no FK: the spread/referral extension (slug -> creator/campaign) is a future lookup table,
-- deferred by decision 031. Additive, nullable, NO backfill - existing owners stay NULL.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS acquisition_channel TEXT;

-- ── Fix: task_blockers surrogate PK ────────────────────────────────────────
-- The original PK was (task_id, blocked_on_task_id, created_at), but blocked_on_task_id is nullable
-- (task_block with no `on` target - a task blocked on nothing in particular), and a PRIMARY KEY column
-- cannot be NULL - so that insert failed. Move to a surrogate id PK. On an existing table the identity
-- column backfills every row before it becomes the PK. Additive + reversible; re-running is a no-op.
ALTER TABLE task_blockers ADD COLUMN IF NOT EXISTS id BIGINT GENERATED ALWAYS AS IDENTITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'task_blockers'::regclass AND contype = 'p'
       AND array_length(conkey, 1) > 1
  ) THEN
    ALTER TABLE task_blockers DROP CONSTRAINT task_blockers_pkey;
    ALTER TABLE task_blockers ADD CONSTRAINT task_blockers_pkey PRIMARY KEY (id);
  END IF;
END $$;
-- Dropping the old composite PK does NOT clear the NOT NULL that PK membership imposed on
-- blocked_on_task_id, so drop it explicitly (idempotent - a no-op once already nullable).
ALTER TABLE task_blockers ALTER COLUMN blocked_on_task_id DROP NOT NULL;

-- ── MCP OAuth 2.1 authorization server (decision 024, amends 010) ───────────
-- One-click "Add to Claude" custom-connector: Claude speaks OAuth (not a pasted bearer). An issued
-- access token is a normal `tokens` row with expires_at set, so authenticate() resolves it to a Ctx
-- unchanged (invariant 1); refresh tokens live in their own table so they can never resolve as a bearer.
-- All hashed at rest (invariant 7). Additive + reversible.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;   -- NULL = a non-expiring agent token

-- Which human drives a participation, so the OAuth consent picker can enumerate a returning user's
-- memberships. Read ONLY by the AS authorize flow; /admin owner-scoping stays keyed on owner_id
-- (invariant 3). ON DELETE SET NULL keeps the ledger (invariant 6).
ALTER TABLE participations ADD COLUMN IF NOT EXISTS human_owner_id BIGINT REFERENCES owners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_participations_human_owner ON participations (human_owner_id);

-- Dynamically-registered public clients (RFC 7591). PKCE only; no client secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  redirect_uris  TEXT[] NOT NULL,
  client_name    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived, single-use authorization codes (hashed). Bound to the participation chosen at consent.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  participation_id      BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scope                 TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens (hashed), rotated on use. Separate table so authenticate() never resolves one as a bearer.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash        TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL,
  participation_id  BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Human-in-the-loop review surface (decision 033) ─────────────────────────
-- An agent issues a review() when it needs its human: a decision, a signoff, or guidance. The task
-- moves onto the human's plate (status 'review_requested'); the human answers on /admin/review; ANY
-- answer moves it back to the agent's court (status 'review_answered'), the agent resumes work
-- (review_answered -> in_progress) and can issue another review - one OPEN review per task at a time,
-- but MANY rounds over a task's life. task_reviews is the per-round log; "open" = answered_at IS NULL,
-- mirroring task_blockers.resolved_at IS NULL. The bus stores the question, an external LINK, and the
-- answer only - never a hosted artifact. All three items below are additive/idempotent/reversible.
CREATE TABLE IF NOT EXISTS task_reviews (
  id                            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id                       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id                    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  awaiting_owner_id             BIGINT REFERENCES owners(id) ON DELETE SET NULL,  -- the human it awaits
  kind                          TEXT NOT NULL CHECK (kind IN ('decision','signoff')),
  question                      TEXT NOT NULL,
  artifact_url                  TEXT,                                             -- external link only
  options                       JSONB,                                            -- decision chips; NULL for signoff
  requested_by_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  requested_by_name             TEXT NOT NULL,                                    -- preserved actor (invariant 6)
  answer                        TEXT,                                             -- chosen option | approve|request_changes|comment
  answer_note                   TEXT,
  answered_by_owner_id          BIGINT REFERENCES owners(id) ON DELETE SET NULL,
  answered_at                   TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- FK rationale (invariant 6, ledger-preserving): the human/participation links are ON DELETE SET NULL
-- and requested_by_name is a preserved snapshot (like tasks.owner_name), so deleting a participant/owner
-- drops the link but the review still reads its history. task_id/project_id cascade (like task_blockers).
CREATE INDEX IF NOT EXISTS idx_task_reviews_awaiting ON task_reviews (awaiting_owner_id) WHERE answered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_reviews_task     ON task_reviews (task_id);
-- At most ONE open review per task (answered_at IS NULL): makes the "one open review per task" invariant
-- true by construction, so a rare concurrent second review() rolls back cleanly on the unique violation.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_task_reviews_one_open ON task_reviews (task_id) WHERE answered_at IS NULL;

-- Widen the task-status CHECK with the TWO review states (decision 033; §0 override replaces the single
-- 'awaiting_owner' with the request/answer pair). Idempotent drop/re-add of a SUPERSET, so every existing
-- row still satisfies it (precedent: the task_blockers PK surgery above). 'review_requested' = the human's
-- turn (surfaces on /admin/review, NOT in the agent's _open_tasks nudge); 'review_answered' = the agent's
-- turn (counts toward the agent's nudge; task_start also accepts it as a source).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
-- Superset includes the v2 states (decision 039) so a re-migrate over a DB that already holds v2 rows
-- (todo/cancelled) does not fail at this intermediate widen; the final v2 block below re-adds the same set.
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('open','assigned','in_progress','blocked','done','review_requested','review_answered',
                    'todo','cancelled'));

-- Widen the event-type CHECK with the two review events for an honest ledger (decision 033). The re-added
-- CHECK is a superset, so every existing events row passes; the ADD triggers one O(n) validation scan (the
-- events table is small on this early product). Idempotent drop/re-add.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
-- Superset includes the v2 event types (decision 039) so a re-migrate over a DB holding v2 event rows does
-- not fail at this intermediate widen; the final v2 block below re-adds the same set.
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN (
  'claim','seed','register','post','ack','lease','release',
  'task_create','task_assign','task_start','task_stop','task_block','task_resolve','task_ship',
  'task_review_request','task_review_answer',
  'task_cancel','task_reopen','task_edit','task_depend','task_undepend','task_answer'));

-- ── Decision 034: generalize a review to await ANY party ────────────────────
-- 033 hardwired a review's awaited party to the task's human owner (awaiting_owner_id). 034 lets a caller
-- NAME the awaited party: EITHER awaiting_owner_id (a human owner; the 033 default) OR the new
-- awaiting_participation_id (a NAMED agent). Exactly ONE is set at write time - enforced in app code
-- (domain/task.review), NOT a CHECK. Existing rows keep awaiting_owner_id; NO backfill needed. Additive,
-- idempotent, reversible (drop the index + two columns; the 033 human path is untouched).
ALTER TABLE task_reviews ADD COLUMN IF NOT EXISTS awaiting_participation_id BIGINT
  REFERENCES participations(id) ON DELETE SET NULL;                 -- the named agent it awaits (else NULL)
-- The agent that answered (NULL when a human answered - that stays on answered_by_owner_id). Ledger-
-- preserving: ON DELETE SET NULL, and the answer attribution is preserved on the answer POST anyway.
ALTER TABLE task_reviews ADD COLUMN IF NOT EXISTS answered_by_participation_id BIGINT
  REFERENCES participations(id) ON DELETE SET NULL;
-- Why NOT a CHECK ((awaiting_owner_id IS NOT NULL) <> (awaiting_participation_id IS NOT NULL)): ON DELETE
-- SET NULL re-evaluates row CHECKs, so deleting the awaited owner (or participation) would NULL its column
-- and could leave BOTH null, which would make the delete FAIL - breaking invariant 6 (ledger-preserving
-- deletes must never be blocked). So "exactly one awaited party" is an app-code rule; a both-null row (the
-- awaited party was later deleted) is legitimate and simply means "awaited party gone" - it stays open and
-- surfaces to the project owner through the project-ownership read (decision 034).
-- Agent-discovery index: open reviews awaiting a given participation (mirrors idx_task_reviews_awaiting).
CREATE INDEX IF NOT EXISTS idx_task_reviews_awaiting_pa
  ON task_reviews (awaiting_participation_id) WHERE answered_at IS NULL;

-- ── Decision 035: one-time platform announcement channel ────────────────────
-- whats_new delivers server-authored announcements (src/announcements.ts) to each participation
-- exactly once. announced_through is the high-water mark: the greatest announcement id this
-- participation has already been shown. Existing rows default 0, so every already-connected agent
-- receives all current announcements once on its NEXT advancing whats_new - a launched capability
-- reaches every agent platform-wide with nobody told by hand. Advanced in the same tx as the event
-- cursor, and only on an advancing call (a peek with advance_cursor:false never burns delivery).
-- Additive, reversible (DROP COLUMN announced_through), NO backfill.
ALTER TABLE participations ADD COLUMN IF NOT EXISTS announced_through BIGINT NOT NULL DEFAULT 0;

-- ── Decision 037: multi-human project membership ────────────────────────────
-- 004 modeled ONE human per project (projects.owner_id). 037 makes humans first-class MEMBERS so a project
-- can have an owner + invited co-humans, a review can be addressed to a named human member, and a human sees
-- a cross-project board of reviews awaiting THEM. project_members is access-control state (NOT a ledger), so
-- CASCADE FKs are correct: removing a human drops their memberships and touches no actor_name history
-- (invariant 6 governs the ledger, not memberships). Additive, reversible (DROP TABLE project_members).
CREATE TABLE IF NOT EXISTS project_members (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id    BIGINT NOT NULL REFERENCES owners(id)   ON DELETE CASCADE,
  role        TEXT   NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_owner ON project_members (owner_id);

-- Idempotent backfill from current state (ON CONFLICT DO NOTHING so a re-migrate is a no-op):
--  (a) every project owner is a member with role 'owner';
INSERT INTO project_members (project_id, owner_id, role)
  SELECT id, owner_id, 'owner' FROM projects
  ON CONFLICT (project_id, owner_id) DO NOTHING;
--  (b) every human already driving an agent in a project they do NOT own becomes a 'member'.
INSERT INTO project_members (project_id, owner_id, role)
  SELECT DISTINCT pa.project_id, pa.human_owner_id, 'member'
    FROM participations pa JOIN projects pr ON pr.id = pa.project_id
   WHERE pa.human_owner_id IS NOT NULL AND pa.human_owner_id <> pr.owner_id
  ON CONFLICT (project_id, owner_id) DO NOTHING;

-- ── Decision 039: LLM Bus v2 - unified task/message model (Stage A: task core) ─
-- Collapses the task lifecycle to FIVE base states, makes assignee an editable polymorphic field, adds
-- first-class dependency edges, and folds decision/signoff review into task options + answer. All ADDITIVE
-- and REVERSIBLE; the four legacy statuses stay PERMITTED (superset) but UNWRITTEN by v2 code, so every
-- existing prod row still satisfies the CHECK. Narrowing to exactly the 5 is DEFERRED + owner-gated (only
-- safe after the ship-time flush deletes legacy-status rows). NO backfill; the review tables/columns are
-- retained DORMANT (precedent: 038 kept join_requests dormant).

-- Status CHECK widen (superset drop/re-add; last one wins on re-migrate). v2 base statuses = todo,
-- in_progress, done, cancelled. 'blocked' is DERIVED (from an unmet task_deps edge or an open task_blockers
-- row), NEVER written as a base status by v2 - but kept in the CHECK for the legacy rows until the flush.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'open','assigned','in_progress','blocked','done','review_requested','review_answered',  -- legacy (dormant)
  'todo','cancelled'));                                                                    -- v2

-- Assignee as an editable, polymorphic field: an agent assignee stays on owner_participation_id; a HUMAN
-- member assignee (an owners row, decision 037) goes here. Exactly one of the two is set (agent OR human),
-- or both null (unassigned) - an APP-CODE rule, NOT a CHECK (an XOR CHECK re-evaluated by ON DELETE SET NULL
-- would block a ledger-preserving delete, invariant 6; see the 034 note above). owner_name stays the display
-- snapshot for both. ON DELETE SET NULL so removing the human unassigns (v2 owner-leave flips status->todo).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_owner_id BIGINT REFERENCES owners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_proj_assignee_owner ON tasks (project_id, assignee_owner_id);

-- Task options + selected option + free-form answer (replaces the decision/signoff review kind). A task with
-- options set is a "decide X" task; completing it records the choice + note and delivers it to dependents.
-- Both answer FKs ON DELETE SET NULL (invariant 6; the answer is also preserved on the delivery message).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS options         JSONB;   -- proposed option chips; NULL = none
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS selected_option TEXT;    -- the chosen option, or 'other'
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answer_note     TEXT;    -- always-allowed free-form feedback
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answered_by_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answered_by_owner_id         BIGINT REFERENCES owners(id)         ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answered_at     TIMESTAMPTZ;

-- Multiple labeled links on a task ([{label,url}]); rendered ONLY through esc() + the isHttpUrl scheme guard
-- (invariant 4), never as a raw anchor. The bus stores links, never blobs.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS links JSONB;

-- Dependency edges (first-class). A task with >=1 edge whose target is not yet 'done' is DERIVED-blocked and
-- not grabbable; it auto-returns when the target ships. Resolution is DERIVED (target.status='done'), never a
-- stored resolved_at - that is what makes auto-return correct by construction. Both task FKs CASCADE (an edge
-- is coordination state scoped to its tasks, like task_blockers; not ledger). created_by_* preserved.
CREATE TABLE IF NOT EXISTS task_deps (
  task_id             BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by_id       BIGINT REFERENCES participations(id) ON DELETE SET NULL,
  created_by_owner_id BIGINT REFERENCES owners(id)         ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)                     -- a task cannot depend on itself
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task       ON task_deps (task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_deps (depends_on_task_id);

-- Event-type CHECK widen (superset) with the v2 task events for an honest ledger. Keeps the review events
-- (task_review_request/answer) for the dormant history. Idempotent drop/re-add; last one wins.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN (
  'claim','seed','register','post','ack','lease','release',
  'task_create','task_assign','task_start','task_stop','task_block','task_resolve','task_ship',
  'task_review_request','task_review_answer',                                          -- legacy (dormant)
  'task_cancel','task_reopen','task_edit','task_depend','task_undepend','task_answer'));-- v2

-- ── Decision 039 (Stage B): message read-state + multi-artifact links ────────
-- Messages become TWO-state (unread -> read); the ack/"handled" concept is retired (post_acks kept dormant,
-- precedent 038). Reading a post records a read receipt; that is what clears it from the inbox/nag. Additive,
-- reversible, no backfill.
CREATE TABLE IF NOT EXISTS post_reads (
  post_id          BIGINT NOT NULL REFERENCES posts(id)          ON DELETE CASCADE,
  participation_id BIGINT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, participation_id)
);
-- Human (web) read-state is per-OWNER, not per-participation (a human has no token/participation).
CREATE TABLE IF NOT EXISTS post_reads_owner (
  post_id  BIGINT NOT NULL REFERENCES posts(id)   ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES owners(id)  ON DELETE CASCADE,
  read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, owner_id)
);
-- Several labeled links on a message ([{label,url}]); rendered ONLY through esc() + the isHttpUrl guard.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS links JSONB;

-- ── Decision 042: human task response + lifecycle controls ───────────────────
-- Adds the `task_stop` event (in_progress -> todo "un-start" from the web Status control). Additive: widen
-- the events_type_check to the current v2 set + task_stop. Idempotent drop/re-add; last one wins. No new
-- table/column (created_by_id, options, answer_note already exist since 039).
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN (
  'claim','seed','register','post','ack','lease','release',
  'task_create','task_assign','task_start','task_stop','task_block','task_resolve','task_ship',
  'task_review_request','task_review_answer',                                          -- legacy (dormant)
  'task_cancel','task_reopen','task_edit','task_depend','task_undepend','task_answer'));-- v2 + 042

-- ── Decision 063: per-owner digest send time, in the owner's OWN timezone ────
-- The digest is the product's main returning surface, so WHEN it lands matters. Two additive columns on
-- `owners`, metadata-only (no table rewrite), reversible by dropping them.
--
-- digest_tz stores an IANA ZONE NAME ('Europe/Oslo'), never a UTC offset. An offset is wrong twice a year:
-- it cannot express DST, so a stored '+02:00' silently drifts an hour every spring and autumn. The zone
-- NAME lets Postgres resolve the offset per instant against the live tz database (AT TIME ZONE), which is
-- the only source that stays correct across a rule change. NULL = not chosen yet -> treated as UTC.
--
-- digest_hour is the LOCAL hour (0-23) the owner wants it. The scheduler matches "local hour >= this AND
-- the last send was on an earlier LOCAL DATE" rather than equality, which is what makes it DST-safe: on a
-- spring-forward the chosen hour may not exist at all (02:00 is skipped), and on a fall-back it happens
-- twice - equality would drop the send in the first case and duplicate it in the second.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS digest_hour SMALLINT NOT NULL DEFAULT 7;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS digest_tz   TEXT;
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_digest_hour_check;
ALTER TABLE owners ADD CONSTRAINT owners_digest_hour_check CHECK (digest_hour BETWEEN 0 AND 23);

-- ── A post keeps a readable ADDRESSEE after that agent is deleted (decision 069) ────────────────────────
-- `from_actor_name` has always survived a deleted sender; the `to_` side never got the same treatment, and
-- that asymmetry made agents undeletable. Deleting a participant cascades to its participations, which
-- SET NULL on posts.to_participation_id - and a DIRECTED post (the ordinary handoff: an actor, no lane)
-- then had BOTH addressing columns null and tripped the CHECK. The delete threw, the admin UI rendered a
-- bare 400, and any agent that had ever RECEIVED a directed post could not be removed at all.
--
-- Additive and reversible: a nullable display column, plus a RELAXED check (strictly weaker, so every
-- existing row already satisfies it - no rewrite, no lock beyond the validate).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS to_actor_name TEXT;
-- Backfill the addressee for rows that still have a live participation, so history reads correctly rather
-- than only new posts. Idempotent: only fills nulls.
UPDATE posts p
   SET to_actor_name = COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name)
  FROM participations pa
  JOIN participants pt ON pt.id = pa.participant_id
  JOIN owners o ON o.id = pt.owner_id
  LEFT JOIN owners ho ON ho.id = pa.human_owner_id
 WHERE p.to_participation_id = pa.id AND p.to_actor_name IS NULL;
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS for a CHECK, so this DROPS BOTH names first. Without the
-- second DROP the block succeeds exactly once and then fails every subsequent migrate with
-- 'constraint "posts_addressed_check" for relation "posts" already exists' - which is what 069 shipped, and
-- what blocked the very next deploy (070). Re-adding revalidates the table, which is trivial at this size.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_check;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_addressed_check;
ALTER TABLE posts ADD CONSTRAINT posts_addressed_check
  CHECK (to_lane IS NOT NULL OR to_participation_id IS NOT NULL OR to_actor_name IS NOT NULL);

-- ── A manual block says what would lift it, and who owns lifting it (decision 074) ──────────────────────
-- Decision 073 made a block's reason VISIBLE and, doing so, had to print the honest sentence that nothing
-- would ever lift it: a manual block recorded a reason and nothing else, so it pointed into the dark. Prod
-- carried 7 open manual blocks, the oldest 10 days old, every one legitimate and none with a mechanism
-- that would ever bring it back. The operator's ruling on task #980: a block needs a clear explanation of
-- what would lift it AND an owner, "even if the assigned party is not the right or final assignee, at
-- least it is assigned and someone needs to process it."
--
-- The owner is stored in the SAME three-column shape the tasks table already uses for an assignee
-- (participation for an agent, owner for a human, plus a display snapshot that survives either being
-- deleted), so one addressing vocabulary covers assignment and unblocking - decision 061's owner:/human:.
-- All additive and nullable: the 7 existing rows keep rendering, and their missing fields are shown AS
-- missing rather than back-filled with a guess nobody can make.
ALTER TABLE task_blockers ADD COLUMN IF NOT EXISTS unblock_condition       TEXT;
ALTER TABLE task_blockers ADD COLUMN IF NOT EXISTS unblock_participation_id BIGINT REFERENCES participations(id) ON DELETE SET NULL;
ALTER TABLE task_blockers ADD COLUMN IF NOT EXISTS unblock_owner_id        BIGINT REFERENCES owners(id) ON DELETE SET NULL;
ALTER TABLE task_blockers ADD COLUMN IF NOT EXISTS unblock_name            TEXT;
-- "What is waiting on me" is the whole point of naming an owner, so it gets an index rather than a scan.
-- Two partial indexes, not one composite: the columns are mutually exclusive (an agent OR a human), so a
-- composite would be half nulls on every row and answer neither question well.
CREATE INDEX IF NOT EXISTS idx_blockers_waiting_agent ON task_blockers (unblock_participation_id)
  WHERE resolved_at IS NULL AND unblock_participation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blockers_waiting_human ON task_blockers (unblock_owner_id)
  WHERE resolved_at IS NULL AND unblock_owner_id IS NOT NULL;

-- ── The wake channel (decision 079) ──────────────────────────────────────────────────────────────
-- An idle agent should cost nothing and start the instant work lands. Polling cannot do both: a long
-- interval stalls every handoff, and the short interval that makes handoffs feel immediate is exactly
-- the one that burns most on empty checks. So the bus pushes.
--
-- The notify is deliberately DUMB - it carries only the project id, never "who should wake". Every
-- action already appends to `events`, so one trigger here catches all of them, and each waiter then
-- re-evaluates ITS OWN queue with the same predicates whats_new uses. Teaching a trigger what counts
-- as work would fork that definition into SQL nobody maintains, and the two copies would drift; this
-- way there is exactly one answer to "do I have work" and the trigger cannot be wrong about it.
-- Cost of the bluntness: every waiter in a project wakes on any event there and runs one cheap count.
-- That is a SQL query, not a model turn - the process only exits, and only then costs tokens, if its
-- own queue is non-empty.
--
-- pg_notify's payload cap is 8000 bytes; a project id cannot approach it. NOTIFY is transactional -
-- it fires on COMMIT, never on a rolled-back write - which is exactly the semantics wanted: no waiter
-- is ever woken for work that did not happen.
CREATE OR REPLACE FUNCTION bus_wake_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('bus_wake', NEW.project_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bus_wake ON events;
CREATE TRIGGER trg_bus_wake AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION bus_wake_notify();
