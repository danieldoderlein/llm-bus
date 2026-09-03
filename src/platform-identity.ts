// Who the SERVER itself speaks as, and the handles no owner may claim (decision 072).
//
// The bus writes rows of its own and they need an author. The actor name is `<handle>/<label>`, so the
// platform identity is only trustworthy while no owner can register the handle it speaks under: an
// owner holding `bus` could name an agent `support` and be byte-identical to the server in every
// surface that renders an actor. Reserving the handle is what makes the name mean something.
//
// Self-hosting: change these to your own handle. Keep the reservation - it is the whole mechanism.
export const SUPPORT_ACTOR = "bus/support";
export const PLATFORM_ACTORS: readonly string[] = [SUPPORT_ACTOR, "billing"];
export const PLATFORM_ACTORS_SQL = `(${PLATFORM_ACTORS.map((a) => `'${a}'`).join(",")})`;
export const RESERVED_HANDLES: readonly string[] = ["llm-bus", "bus", "support", "admin", "system", "billing"];

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.includes(handle.trim().toLowerCase());
}
