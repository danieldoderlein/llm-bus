// Billing is a commercial add-on; this open-source build ships an inert stub.
// See https://llm-bus.com for the hosted service.
import type { PoolClient } from "pg";

/** Inert: this open-source build never applies credits. Always returns false (no-op). */
export async function applyCredit(
  _c: PoolClient,
  _ownerId: number,
  _type: "grant" | "topup",
  _amount: number,
  _ref: string,
  _description: string,
): Promise<boolean> {
  return false;
}

/** The prepaid top-up ladder. Empty in the open-source build (no billing). */
export const BONUS_LADDER: ReadonlyArray<readonly [nok: number, bonus: number]> = [];

/** Inert: no ladder, so no amount is a valid top-up. */
export function bonusFor(_amountNok: number): number | null {
  return null;
}

/** Inert: no ladder, so no top-up resolves to tokens. */
export function tokensForTopUp(_amountNok: number): number | null {
  return null;
}
