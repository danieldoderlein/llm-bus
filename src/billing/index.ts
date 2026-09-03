// Billing is a commercial add-on; this open-source build ships an inert stub.
// See https://llm-bus.com for the hosted service.
import { billingEnabled } from "./stripe.js";

/** The minimal owner shape billing needs (a full Owner is assignable). */
type BillingOwner = { id: number; email: string };

export { billingEnabled };

/** Inert: no Stripe Checkout in the open-source build. */
export async function createSetupSession(_owner: BillingOwner): Promise<string | null> {
  return null;
}

/** Inert: no Stripe Customer Portal in the open-source build. */
export async function createPortalSession(_owner: BillingOwner): Promise<string | null> {
  return null;
}

/** Inert: no card charging in the open-source build. */
export async function chargeTopUp(
  _owner: BillingOwner,
  _amountNok: number,
): Promise<"credited" | "pending" | "no_card" | "disabled" | "bad_amount" | "declined"> {
  return "disabled";
}

/** Apply a payment-provider webhook. Inert here: the OSS build has no payment provider, and
 *  billingEnabled() is false, so this is never reached from the webhook route. */
export async function applyWebhook(_event: unknown): Promise<void> {
  return;
}
