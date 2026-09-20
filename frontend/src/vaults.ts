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

/**
 * What an order's stored minimum promises.
 *
 * `gross` guards the swap output and lets the bounty come out afterwards, so
 * the owner receives less than the figure recorded. `net` guards the transfer
 * the owner actually receives. The distinction is the reason both are named
 * here rather than assumed.
 */
export type MinimumSemantics = "gross" | "net";

export interface VaultVersion {
  id: string;
  /** Short name used in the UI and in order identifiers. */
  label: string;
  semantics: MinimumSemantics;
  /**
   * Only one vault accepts new orders. The others are read-and-cancel: their
   * owners can always reclaim, but nothing new is written to them.
   */
  accepting: boolean;
  /** Why this version is still listed, in the user's words. */
  note: string;
}

const CONFIGURED_ACTIVE = (
  import.meta.env.VITE_VAULT_CONTRACT_ID as string | undefined
)?.trim();

/**
 * Newest first. The accepting vault leads because it is the one being used;
 * the rest are history that still has money in it.
 */
export const VAULTS: ReadonlyArray<VaultVersion> = [
  {
    id: CONFIGURED_ACTIVE || "CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT",
    label: "V2",
    semantics: "net",
    accepting: true,
    note: "Current vault. Its minimum guards what reaches your wallet: the keeper bounty is taken before the figure you set, not out of it.",
  },
  {
    id: "CDVJV6SITYH2A4CNTG4YG5CDYDRM5ABTDIBA3UVBLXFQNE6FWK3BNTWD",
    label: "V1",
    semantics: "gross",
    accepting: false,
    note: "Earlier vault, no longer used for new orders. Its minimum guarded the swap output, so the bounty came out of what you received. Orders here can still be cancelled by their owner.",
  },
  {
    id: "CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB",
    label: "V0",
    semantics: "gross",
    accepting: false,
    note: "Earlier vault, no longer used for new orders. Orders here can still be cancelled by their owner.",
  },
];

export const ACTIVE_VAULT: VaultVersion =
  VAULTS.find((vault) => vault.accepting) ?? VAULTS[0];

export const vaultById = (id: string): VaultVersion | undefined =>
  VAULTS.find((vault) => vault.id === id);

/**
 * Order ids restart at 1 in every deployment, so an id alone names three
 * different orders. Anything that stores, compares or keys an order uses this.
 */
export const orderKey = (vaultId: string, orderId: number): string =>
  `${vaultId}:${orderId}`;
