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
  task_id            BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_on_task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  PRIMARY KEY (task_id, blocked_on_task_id, created_at)
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
