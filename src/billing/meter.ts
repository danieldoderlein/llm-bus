// Billing is a commercial add-on; this open-source build ships an inert stub.
// See https://llm-bus.com for the hosted service.

/** Inert: no metering in the open-source build. */
export async function meterOwner(_ownerId: number): Promise<void> {
  return;
}

/** Inert: no metering in the open-source build. */
export async function meterAll(): Promise<void> {
  return;
}
