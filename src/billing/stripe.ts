// Billing is a commercial add-on; this open-source build ships an inert stub.
// See https://llm-bus.com for the hosted service.
import { loadConfig, type Config } from "../config.js";

/** Master switch. Always false in the open-source build, so no billing path is ever taken. */
export function billingEnabled(_cfg: Config = loadConfig()): boolean {
  return false;
}
