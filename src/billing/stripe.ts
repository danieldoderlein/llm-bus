// Billing is a commercial add-on; this open-source build ships an inert stub.
// See https://llm-bus.com for the hosted service.
import { loadConfig, type Config } from "../config.js";

/** Master switch. Always false in the open-source build, so no billing path is ever taken. */
export function billingEnabled(_cfg: Config = loadConfig()): boolean {
  return false;
}

/** Webhook verifier seam. The commercial build returns a real Stripe signature verifier; with no keys
 *  configured there is nothing to verify, so this is null and the webhook route is never armed. */
type WebhookVerifier = (raw: string | Buffer, sig: string, secret: string) => unknown;
export function defaultVerifier(_cfg: unknown): WebhookVerifier | null {
  return null;
}
