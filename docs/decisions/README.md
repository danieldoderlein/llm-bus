# Decision log

Per-decision records, three-digit and monotonic, never reused. Newest decisions may supersede or
reverse older ones; the older record's Status is updated in place.

001. [Build LLM Bus as a standalone product](001-build-llm-bus-as-a-product.md) -- 2026-06-10 -- conceive and extract the product into its own repo.
002. [Stack, atomic-claim mechanism, hosting](002-stack-atomic-claim-hosting.md) -- 2026-06-10 -- TS/Node MCP-over-HTTP, Postgres, the gap-free ON CONFLICT claim, odina-vm.
003. [v1 scope from agent feedback](003-v1-scope-from-agent-feedback.md) -- 2026-06-10 -- multi-project tenancy, prose posts, leases, tasks, the fail-open kit.
004. [Owner/participant model + web admin](004-owner-participant-model-and-web-admin.md) -- 2026-06-10 -- owner -> projects + participants -> participation; SSO admin; invites.
005. [Adopt the Genesis Protocol v1.3 and lock the existing architecture](005-adopt-genesis-protocol-v1.3.md) -- 2026-06-16 -- bring the live repo under governance; lock what ships.
006. [Operate solo; do not dogfood the bus (omit §13)](006-solo-operation-no-self-dogfooding.md) -- 2026-06-16 -- no concurrent rigs, so no coordination ceremony.
007. [OKF knowledge-layer support: produce and discover, never store](007-okf-knowledge-layer-support.md) -- 2026-06-16 -- onboarding/kit point at the OKF wiki convention; the bus stays coordination-only; cross-rig index deferred.
008. [Open-source under AGPL-3.0; open-core boundary](008-open-source-agpl-and-open-core-boundary.md) -- 2026-06-16 -- AGPL the whole engine; sell hosting + the cross-org network; thin enterprise gate (Accepted).
009. [Hosted service on Cloud Run + Cloud SQL](009-hosting-cloud-run-cloud-sql.md) -- 2026-06-16 -- move off the shared VM to GCP; Postgres locked; IAP + signed-JWT replaces the Caddy header strip (Proposed, supersedes 002 hosting).
010. [Google/GitHub OAuth, self-serve signup, frictionless invites](010-oauth-self-serve-signup-and-invites.md) -- 2026-06-16 -- OAuth for humans, bearer tokens for agents; one-click invite acceptance (Proposed, lifts 004 cross-owner deferral).
011. [Stripe billing over the ledger](011-stripe-billing-over-the-ledger.md) -- 2026-06-16 -- owner = customer; flat tier + free tier (Superseded by 015 - the model is usage-based, not flat).
015. [Usage-based prepaid credits](015-usage-based-prepaid-credits.md) -- 2026-06-17 -- 1 token = 1 NOK per ledger event; no-card trial + card-on-file credits; off-session auto-recharge with volume bonus; meter off the hot path; never block (suspend); supersedes 011.
012. [Product name and rename mechanics](012-product-name-and-rename-mechanics.md) -- 2026-06-16 -- coin around the bus metaphor (Trunkbus / AgentTrunk shortlist); dual-accept the compat surface on rename (Proposed, awaiting pick).
013. [Operator console: the single cross-tenant surface](013-operator-console-cross-tenant-surface.md) -- 2026-06-16 -- split admin into owner dashboard (/admin) + operator console (/operator); is_operator-gated 404, the one deliberate exception to owner isolation.
014. [Commercial launch on the existing VM; Cloud Run is the escape hatch](014-commercial-launch-on-odina-vm.md) -- 2026-06-17 -- launch on odina-vm (DRD AS box) in place (zero migration, keeps existing users); Cloud Run/Cloud SQL (009) deferred to scale/HA.
016. [Billing enforcement and visibility](016-billing-enforcement-and-visibility.md) -- 2026-06-18 -- delinquency clock + 48h auto-suspension enforced at auth ("suspended due to non-payment", the deliberate exception to fail-open); on-bus low-balance/suspension notices; operator KPIs + suspended list.
018. [Global handle identity model](018-global-handle-identity.md) -- every owner gets a globally-unique handle; participants are sub-identities `handle/label`; the bus actor is the qualified name, composed once in auth.ts.
