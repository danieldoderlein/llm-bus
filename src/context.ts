// The frozen v2 contract every domain module compiles against (decision 006).
// Identity + scoping are derived from the bearer token (token -> participation ->
// project + participant + owner) and passed to every domain function as `Ctx`.
// The domain needs: `project` (scoping), `participation.id` (the actor key for
// presence/cursors/leases/acks/task ownership), `participant.name` (attribution).

export interface Project {
  id: number;
  slug: string;
  name: string;
  livenessWindowSec: number;
  ownerId: number;
  // The project OWNER's globally-unique handle (null until backfilled). With `slug` it forms the project's
  // canonical bus address `<ownerHandle>/<slug>`, used to auto-qualify claimed ids across projects (044).
  ownerHandle: string | null;
}

export interface Participant {
  id: number;
  name: string; // the raw label (owner-scoped); the qualified display name is Ctx.actor
  kind: "agent" | "human";
  ownerId: number;
  handle: string | null; // the qualified DISPLAY handle: the participation's BOUND human (participations.human_owner_id, decisions 018/056), falling back to the project owner, then null until backfilled
}

export interface Participation {
  id: number; // the actor key in coordination tables
  isAdmin: boolean;
  lane: string | null;
  // The verified SSO human who DRIVES this membership (participations.human_owner_id), or null for a
  // provisioned agent nobody has bound yet. Decision 070 makes this half of the reach key: a connection
  // is the DRIVER guard on reach (decision 077): a seat of this same agent driven by a DIFFERENT human is
  // refused, so a re-homed membership can never bridge two people. Before 077 this field also GRANTED reach
  // to every seat that human drove, whichever agent held it - which is how a non-admin token acted as an
  // admin agent in another project.
  humanOwnerId: number | null;
}

export interface OwnerRef {
  id: number;
  email: string;
}

export interface Ctx {
  project: Project;
  participant: Participant;
  participation: Participation;
  owner?: OwnerRef;
  // The qualified bus actor written to the ledger and shown everywhere: `handle/label`, or the bare
  // label when there is no handle yet (dual-read during migration; decisions 018/056). The handle prefers
  // the token-resolved BOUND human (participations.human_owner_id) over the project owner. Composed once,
  // in auth.ts, from the token-resolved row - never from input (invariant 1).
  actor: string;
}
