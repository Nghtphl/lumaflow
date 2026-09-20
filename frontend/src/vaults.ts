/**
 * Every vault this console still speaks to.
 *
 * Redeploying used to mean pointing one constant at a new address, which quietly
 * orphaned whatever the old one still held: when `CDVJV6SI…` replaced
 * `CDERIBD7…`, six orders holding 10 USDC and 110 XLM stopped being visible to
 * the people who owned them. The collateral was never lost — `cancel_order`
 * takes only the owner's signature — but nothing in the interface offered them
 * the call. A list, rather than a constant, is what stops that happening again.
 *
 * An entry is never removed while it holds an active order.
 */

/** The only network this build talks to. Part of every order's identity. */
export const NETWORK = "testnet";

/**
 * What an order's stored minimum promises.
 *
 * `gross` guards the swap output and lets the bounty come out afterwards, so
 * the owner receives less than the figure recorded. `net` guards the transfer
 * the owner actually receives. The distinction is the reason both are named
 * here rather than assumed.
 *
 * This says nothing about *when* an order may settle. A stop is not a third
 * payout semantics — it is a different trigger over the same payout promise —
 * so it lives in `capabilities`, not here.
 */
export type PayoutSemantics = "gross" | "net";

/** What kind of instruction an order carries. */
export type OrderType = "limit" | "stop";

export interface VaultVersion {
  id: string;
  /** Short name used in the UI and in order identifiers. */
  label: string;
  /** Monotonic across deployments. V0 is 0. */
  version: number;
  payoutSemantics: PayoutSemantics;
  /** Order types this deployment can hold at all — including ones it no
   *  longer accepts but still has to display and cancel. */
  capabilities: ReadonlyArray<OrderType>;
  /**
   * Order types this deployment still accepts. Empty means read-and-cancel:
   * its owners can always reclaim, but nothing new is written to it.
   *
   * Deliberately separate from `capabilities`: "the newest contract accepts
   * everything" is the assumption that orphaned V0's orders, and the limit
   * vault staying open is not the same decision as retiring an older one.
   */
  acceptingOrderTypes: ReadonlyArray<OrderType>;
  /** Why this version is still listed, in the user's words. */
  note: string;
}

/** The limit vault this build was cut against. */
const ACTIVE_LIMIT_VAULT_ID = "CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT";

/** Vaults that have been superseded. Listed below with their own semantics. */
const RETIRED_VAULT_IDS = [
  "CDVJV6SITYH2A4CNTG4YG5CDYDRM5ABTDIBA3UVBLXFQNE6FWK3BNTWD",
  "CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB",
];

/**
 * The environment may name the accepting vault, but it may also be stale — a
 * hosting environment updated on a different schedule from the repository. A
 * stale value that names a *retired* vault is worse than no value at all: it
 * would hand that vault this entry's semantics and tell its owners their
 * minimum is a net guarantee when it never was. Ignore it in that case; an
 * unrecognised id is still honoured, because that is how a new deployment is
 * pointed at before this file knows about it.
 */
const CONFIGURED_LIMIT_VAULT = ((): string | undefined => {
  const configured = (
    import.meta.env.VITE_VAULT_CONTRACT_ID as string | undefined
  )?.trim();
  if (!configured) return undefined;
  return RETIRED_VAULT_IDS.includes(configured) ? undefined : configured;
})();

/**
 * The stop vault, when one has been deployed.
 *
 * There is no fallback constant on purpose. A stop vault that does not exist
 * yet must leave the console showing limit orders only, rather than offering a
 * form whose transactions would be addressed to nothing. Phase 3 fills this in;
 * until then the absence is the honest state.
 */
const CONFIGURED_STOP_VAULT = ((): string | undefined => {
  const configured = (
    import.meta.env.VITE_STOP_VAULT_CONTRACT_ID as string | undefined
  )?.trim();
  if (!configured || RETIRED_VAULT_IDS.includes(configured)) return undefined;
  return configured;
})();

const STOP_VAULT: VaultVersion | null = CONFIGURED_STOP_VAULT
  ? {
      id: CONFIGURED_STOP_VAULT,
      label: "V3",
      version: 3,
      payoutSemantics: "net",
      capabilities: ["stop"],
      acceptingOrderTypes: ["stop"],
      note: "Stop-loss vault. Its minimum guards what reaches your wallet, and its trigger is read from a price feed rather than from the pool it settles against.",
    }
  : null;

/**
 * Newest first. The vaults that accept orders lead because they are the ones
 * being used; the rest are history that still has money in it.
 */
export const VAULTS: ReadonlyArray<VaultVersion> = [
  ...(STOP_VAULT ? [STOP_VAULT] : []),
  {
    id: CONFIGURED_LIMIT_VAULT || ACTIVE_LIMIT_VAULT_ID,
    label: "V2",
    version: 2,
    payoutSemantics: "net",
    capabilities: ["limit"],
    acceptingOrderTypes: ["limit"],
    note: "Current limit vault. Its minimum guards what reaches your wallet: the keeper bounty is taken before the figure you set, not out of it.",
  },
  {
    id: "CDVJV6SITYH2A4CNTG4YG5CDYDRM5ABTDIBA3UVBLXFQNE6FWK3BNTWD",
    label: "V1",
    version: 1,
    payoutSemantics: "gross",
    capabilities: ["limit"],
    acceptingOrderTypes: [],
    note: "Earlier vault, no longer used for new orders. Its minimum guarded the swap output, so the bounty came out of what you received. Orders here can still be cancelled by their owner.",
  },
  {
    id: "CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB",
    label: "V0",
    version: 0,
    payoutSemantics: "gross",
    capabilities: ["limit"],
    acceptingOrderTypes: [],
    note: "Earlier vault, no longer used for new orders. Orders here can still be cancelled by their owner.",
  },
];

/** The vault that takes new orders of this type, or null when none does. */
export const vaultAccepting = (type: OrderType): VaultVersion | null =>
  VAULTS.find((vault) => vault.acceptingOrderTypes.includes(type)) ?? null;

/** The limit vault. Never null: this build always ships one. */
export const ACTIVE_VAULT: VaultVersion =
  vaultAccepting("limit") ?? VAULTS[VAULTS.length - 1];

/** The stop vault, or null until one is deployed and configured. */
export const STOP_VAULT_VERSION: VaultVersion | null = vaultAccepting("stop");

export const vaultById = (id: string): VaultVersion | undefined =>
  VAULTS.find((vault) => vault.id === id);

/** Which order type a vault's orders are, for reading and display. */
export const orderTypeOf = (vault: VaultVersion): OrderType =>
  vault.capabilities.includes("stop") ? "stop" : "limit";

/**
 * Order ids restart at 1 in every deployment, so an id alone names several
 * different orders, and a contract id is only unique within one network.
 * Anything that stores, compares or keys an order uses this.
 */
export const orderKey = (
  vaultId: string,
  orderId: number,
  network: string = NETWORK,
): string => `${network}:${vaultId}:${orderId}`;
