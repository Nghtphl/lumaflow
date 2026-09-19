import { Horizon, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import type { AnchorConfig } from "./toml";

export const HORIZON_URL =
  (import.meta.env.VITE_HORIZON_URL as string | undefined)?.trim() ||
  "https://horizon-testnet.stellar.org";

let horizon: Horizon.Server | null = null;

export function getHorizon(): Horizon.Server {
  if (!horizon) horizon = new Horizon.Server(HORIZON_URL);
  return horizon;
}

export interface ClassicBalances {
  native: number;
  /** Anchor asset balance, or `null` when the account has no trustline for it. */
  anchorAsset: number | null;
}

/**
 * Classic balances straight from Horizon. `anchorAsset` being `null` (rather
 * than `0`) is the signal the UI uses to offer the "Enable USDC" step: a
 * missing trustline and a zero balance are very different situations.
 */
export async function loadClassicBalances(
  cfg: AnchorConfig,
  account: string,
): Promise<ClassicBalances> {
  const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(account)}`);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This Stellar account does not exist yet — fund it on testnet first."
        : `Horizon returned HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    balances?: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }>;
  };
  const balances = Array.isArray(body.balances) ? body.balances : [];

  const native = Number(
    balances.find((item) => item.asset_type === "native")?.balance || 0,
  );
  const line = balances.find(
    (item) =>
      item.asset_code === cfg.asset.code && item.asset_issuer === cfg.asset.issuer,
  );

  return {
    native: Number.isFinite(native) ? native : 0,
    anchorAsset: line ? Number(line.balance) || 0 : null,
  };
}

/** Horizon buries the useful part of a failure several levels down. */
export function describeHorizonError(error: unknown): string {
  const response = (error as { response?: { data?: unknown } } | null)?.response;
  const data = response?.data as
    | { title?: string; detail?: string; extras?: { result_codes?: Record<string, unknown> } }
    | undefined;
  const codes = data?.extras?.result_codes;
  if (codes) {
    const operations = Array.isArray(codes.operations) ? codes.operations.join(", ") : "";
    const transaction = typeof codes.transaction === "string" ? codes.transaction : "";
    const joined = [transaction, operations].filter(Boolean).join(" · ");
    if (joined) return joined;
  }
  if (data?.detail) return data.detail;
  if (data?.title) return data.title;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Sign a classic transaction with Freighter and submit it through Horizon.
 * Returns the ledger hash.
 */
export async function signAndSubmitClassic(
  transaction: Transaction,
  account: string,
  networkPassphrase: string,
): Promise<string> {
  const signed = await signTransaction(transaction.toXDR(), {
    networkPassphrase,
    address: account,
  });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error("Transaction rejected by wallet.");
  }

  const submitted = TransactionBuilder.fromXDR(signed.signedTxXdr, networkPassphrase);
  try {
    const result = await getHorizon().submitTransaction(submitted as Transaction);
    return result.hash;
  } catch (error) {
    throw new Error(describeHorizonError(error));
  }
}
