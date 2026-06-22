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
}

export interface Participant {
  id: number;
  name: string; // the raw label (owner-scoped); the qualified display name is Ctx.actor
  kind: "agent" | "human";
  ownerId: number;
  handle: string | null; // the owner's global handle; null until backfilled (decision 018)
}

export interface Participation {
  id: number; // the actor key in coordination tables
  isAdmin: boolean;
  lane: string | null;
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
  // label when the owner has no handle yet (dual-read during migration; decision 018). Composed once,
  // in auth.ts, from the token-resolved owner + participant - never from input (invariant 1).
  actor: string;
}
