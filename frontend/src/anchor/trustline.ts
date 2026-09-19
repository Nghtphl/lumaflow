import {
  Asset,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import type { AnchorConfig } from "./toml";

/**
 * The anchor pays **classic** USDC, and a Stellar account cannot receive a
 * classic asset it does not trust. Without this step a deposit reports
 * `completed` at the anchor while nothing ever lands in the wallet, so the UI
 * blocks the deposit button until this returns.
 */

const HORIZON_URL =
  (import.meta.env.VITE_HORIZON_URL as string | undefined)?.trim() ||
  "https://horizon-testnet.stellar.org";

const horizon = new Horizon.Server(HORIZON_URL);

export interface TrustlineState {
  exists: boolean;
  balance: string; // "0.0000000" when there is no trustline yet
  limitReached: boolean;
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}

async function loadBalances(account: string): Promise<HorizonBalance[]> {
  const response = await fetch(
    `${HORIZON_URL.replace(/\/+$/, "")}/accounts/${encodeURIComponent(account)}`,
  );
  if (response.status === 404) {
    throw new Error(
      "This account does not exist on testnet yet. Fund it with friendbot first.",
    );
  }
  if (!response.ok) throw new Error(`Horizon returned HTTP ${response.status}`);
  const payload = (await response.json()) as { balances?: HorizonBalance[] };
  return payload.balances || [];
}

/** Current trustline / balance for the anchor's asset, without signing anything. */
export async function getTrustlineState(
  cfg: AnchorConfig,
  account: string,
): Promise<TrustlineState> {
  const balances = await loadBalances(account);
  const line = balances.find(
    (item) =>
      item.asset_code === cfg.asset.code && item.asset_issuer === cfg.asset.issuer,
  );
  if (!line) return { exists: false, balance: "0.0000000", limitReached: false };
  return {
    exists: true,
    balance: line.balance,
    limitReached: Boolean(line.limit) && Number(line.balance) >= Number(line.limit),
  };
}

/** Native XLM balance — used to warn before a changeTrust bumps the base reserve. */
export async function getNativeBalance(account: string): Promise<number> {
  const balances = await loadBalances(account);
  return Number(
    balances.find((item) => item.asset_type === "native")?.balance || 0,
  );
}

/**
 * Adds the trustline if it is missing. Resolves `true` when a transaction was
 * actually submitted, `false` when the trustline already existed — the caller
 * uses that to decide whether to show a confirmation.
 */
export async function ensureTrustline(
  cfg: AnchorConfig,
  account: string,
): Promise<boolean> {
  const state = await getTrustlineState(cfg, account);
  if (state.exists) return false;

  const source = await horizon.loadAccount(account);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset(cfg.asset.code, cfg.asset.issuer),
      }),
    )
    .setTimeout(120)
    .build();

  const signed = await signTransaction(transaction.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: account,
  });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error("Trustline signature was rejected in the wallet.");
  }

  const result = await horizon.submitTransaction(
    TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET),
  );
  if (!result.successful) {
    throw new Error("Horizon rejected the trustline transaction.");
  }
  return true;
}

export { HORIZON_URL, horizon };
