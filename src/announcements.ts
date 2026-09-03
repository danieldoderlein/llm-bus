// One-time server-authored announcements delivered by whats_new (decision 035).
//
// EMPTY in the open-source build, deliberately. The mechanism is engine - it is how an operator tells
// every connected agent about a capability exactly once, using the participations.announced_through
// high-water mark - but the CONTENT of the hosted service's notices is not yours.
//
// Adding your own: append entries with monotonic integer ids and NEVER renumber, reuse or reorder an
// existing one, or agents past that marker silently skip it. An announcement naming a new TOOL must
// tell the reader to reconnect, because MCP clients cache the tool list at connect; a new PARAMETER
// needs no such note.
export interface Announcement {
  id: number;
  body: string;
}

export const ANNOUNCEMENTS: readonly Announcement[] = [];
