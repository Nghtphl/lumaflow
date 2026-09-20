/**
 * Reading what Freighter says about the connected account.
 *
 * Kept out of `App.tsx` so the answer can be tested on its own — and because the
 * console once trusted a remembered address over the wallet's own reply, which
 * is the kind of decision that deserves to be a named function rather than a
 * fallback in the middle of an effect.
 */

/**
 * The address Freighter returned, or `""` when it returned none.
 *
 * `getAddress()` answers `{address: "", error}` when the wallet is locked or the
 * origin was never granted access. Every refusal has to read as empty here,
 * because callers treat anything falsy as "no session" and go back to offering
 * Connect.
 */
export const parseFreighterAddress = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";
  const value = result as { address?: unknown; publicKey?: unknown };
  if (typeof value.address === "string") return value.address;
  if (typeof value.publicKey === "string") return value.publicKey;
  return "";
};

/** Whether `isAllowed()` said this origin may talk to the wallet. */
export const isWalletPermitted = (allowance: unknown): boolean =>
  typeof allowance === "boolean"
    ? allowance
    : Boolean((allowance as { isAllowed?: unknown } | null)?.isAllowed);
