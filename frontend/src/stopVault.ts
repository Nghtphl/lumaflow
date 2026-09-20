/**
 * Reading and addressing the V3 stop vault.
 *
 * Kept apart from the limit-order path rather than folded into it. The two
 * contracts share a settlement shape but not an instruction: a limit order asks
 * to be filled as soon as the market is good enough, a stop asks to be filled
 * only after the market has gone bad. Collapsing them into one code path is how
 * a stop ends up sold at today's price.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** `decimals()` on the feed this vault was deployed against. */
export const PRICE_SCALE = 10n ** 14n;

/** Mirrors `StopStatus` in the contract. */
export type StopStatus = "Armed" | "Triggered" | "Executed" | "Cancelled";

const STATUS_BY_DISCRIMINANT: ReadonlyArray<StopStatus> = [
  "Armed",
  "Triggered",
  "Executed",
  "Cancelled",
];

export interface StopOrderView {
  id: number;
  owner: string;
  tokenIn: string;
  tokenOut: string;
  /** Collateral in atoms. */
  amountIn: bigint;
  /** The floor on what reaches the owner, in output atoms. */
  minUserOut: bigint;
  feeBps: number;
  /** Ledger time after which only cancellation is open. */
  deadline: number;
  /** Quote-per-asset at `PRICE_SCALE`. */
  stopPrice: bigint;
  policyVersion: number;
  status: StopStatus;
  /** Zero while Armed. */
  triggeredAt: number;
  observedPrice: bigint;
  observedTimestamp: number;
}

const asBigInt = (value: unknown): bigint =>
  typeof value === "bigint" ? value : BigInt(Number(value) || 0);

/**
 * The stop price out of the contract's `TriggerSpec`.
 *
 * The enum is read rather than assumed: a later contract may carry a variant
 * this build does not understand, and a stop price invented for it would be a
 * number on screen that nothing on chain agrees with.
 */
const stopPriceOf = (trigger: unknown): bigint | null => {
  if (!Array.isArray(trigger) || trigger.length < 2) return null;
  if (trigger[0] !== "PublicStopBelow") return null;
  return asBigInt(trigger[1]);
};

/** One `StopOrder` as the contract returned it, or null if unreadable. */
export const toStopOrder = (raw: Record<string, unknown>): StopOrderView | null => {
  const stopPrice = stopPriceOf(raw.trigger);
  if (stopPrice === null) return null;
  const status = STATUS_BY_DISCRIMINANT[Number(raw.status)];
  if (!status) return null;
  return {
    id: Number(raw.id),
    owner: String(raw.owner),
    tokenIn: String(raw.token_in),
    tokenOut: String(raw.token_out),
    amountIn: asBigInt(raw.amount_in),
    minUserOut: asBigInt(raw.min_user_out),
    feeBps: Number(raw.fee_bps),
    deadline: Number(raw.deadline),
    stopPrice,
    policyVersion: Number(raw.policy_version),
    status,
    triggeredAt: Number(raw.triggered_at),
    observedPrice: asBigInt(raw.observed_price),
    observedTimestamp: Number(raw.observed_timestamp),
  };
};

/** A decimal price string as the integer the contract compares against. */
export const toPriceAtoms = (value: string): bigint => {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{0,14})?$/.test(normalized)) {
    throw new Error("Invalid price format");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const padded = `${fraction}00000000000000`.slice(0, 14);
  return BigInt(whole || "0") * PRICE_SCALE + BigInt(padded);
};

/** The integer price as a decimal string, for display only. */
export const fromPriceAtoms = (value: bigint, decimals = 7): string =>
  (Number(value) / Number(PRICE_SCALE)).toFixed(decimals);

export const createStopArgs = (params: {
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minUserOut: bigint;
  feeBps: number;
  deadline: number;
  stopPrice: bigint;
}): xdr.ScVal[] => [
  Address.fromString(params.owner).toScVal(),
  Address.fromString(params.tokenIn).toScVal(),
  Address.fromString(params.tokenOut).toScVal(),
  nativeToScVal(params.amountIn, { type: "i128" }),
  nativeToScVal(params.minUserOut, { type: "i128" }),
  xdr.ScVal.scvU32(params.feeBps),
  nativeToScVal(BigInt(params.deadline), { type: "u64" }),
  nativeToScVal(params.stopPrice, { type: "i128" }),
];

export const triggerStopArgs = (orderId: number, executor: string): xdr.ScVal[] => [
  xdr.ScVal.scvU32(orderId),
  Address.fromString(executor).toScVal(),
];

export const executeStopArgs = triggerStopArgs;

export const cancelStopArgs = (orderId: number): xdr.ScVal[] => [
  xdr.ScVal.scvU32(orderId),
];

/**
 * Why this order cannot be acted on right now, or null when it can.
 *
 * Used for the button state and for the sentence beside it. A disabled control
 * with no reason is the thing this exists to avoid.
 */
export const stopBlockedReason = (
  order: StopOrderView,
  nowSeconds: number,
): string | null => {
  if (order.status === "Executed") return "This order has already settled.";
  if (order.status === "Cancelled") return "This order was cancelled.";
  if (nowSeconds >= order.deadline) {
    return "This order has passed its deadline. Cancel it to reclaim the collateral.";
  }
  return null;
};

/** The part of the vault's `Config` the console has to respect. */
export interface StopConfigView {
  /** Largest single order, in collateral atoms. */
  maxAmountIn: bigint;
  collateralToken: string;
  payoutToken: string;
  /** `decimals()` the deployed policy was fixed against. */
  policyDecimals: number;
  policyVersion: number;
}

/**
 * The vault's own configuration, or null if it is not the shape this build
 * knows.
 *
 * Read rather than assumed. The size cap and the policy scale are fixed at
 * deployment and have no setter, so a console that hardcodes either one is a
 * console that will one day size an order against a number the contract does
 * not hold — and the user finds out from a failed signature.
 */
export const toStopConfig = (raw: Record<string, unknown>): StopConfigView | null => {
  const policy = raw.policy as Record<string, unknown> | undefined;
  if (!policy || raw.max_amount_in === undefined) return null;
  return {
    maxAmountIn: asBigInt(raw.max_amount_in),
    collateralToken: String(raw.collateral_token),
    payoutToken: String(raw.payout_token),
    policyDecimals: Number(policy.decimals),
    policyVersion: Number(policy.version),
  };
};
