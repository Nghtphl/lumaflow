import {
  Asset,
  BASE_FEE,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import type { AnchorConfig } from "./toml";
import { AnchorUnauthorizedError, resolveJwt } from "./sep10";
import type { Jwt } from "./sep10";
import { horizon } from "./trustline";

/**
 * SEP-6 — the fiat rail. TRY arrives by bank transfer and leaves as real
 * testnet USDC on the user's own account; the withdrawal is the mirror image.
 *
 * Nothing here hardcodes an endpoint: every URL comes from `cfg`, which came
 * from the anchor's stellar.toml. Point the app at a production anchor and this
 * file does not change.
 */

export interface Sep6Info {
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  feePercent: number;
  fundingMethods: string[];
  minAmount: number | null;
  maxAmount: number | null;
  minWithdrawAmount: number | null;
}

export interface DepositInstructions {
  id: string;
  /** Flattened bank instructions, ready to render as a definition list. */
  fields: Array<{ label: string; value: string }>;
  /** The reference the user must put on the bank transfer, when one is given. */
  reference: string;
  moreInfoUrl: string;
  eta: string;
}

export interface WithdrawInstructions {
  id: string;
  accountId: string;
  memo: string;
  memoType: string;
  eta: string;
}

export type Sep6Status =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "completed"
  | "error"
  | "expired"
  | (string & {});

export interface Sep6Transaction {
  id: string;
  kind: string;
  status: Sep6Status;
  statusMessage: string;
  amountIn: string;
  amountOut: string;
  amountInAsset: string;
  amountOutAsset: string;
  amountFeeAsset: string;
  amountFee: string;
  stellarTransactionId: string;
  externalTransactionId: string;
  moreInfoUrl: string;
}

/** Steps rendered as the status ladder; anything else maps to the nearest one. */
export const DEPOSIT_LADDER: Array<{ status: Sep6Status; label: string }> = [
  { status: "incomplete", label: "Order created" },
  { status: "pending_user_transfer_start", label: "Awaiting TRY transfer" },
  { status: "pending_anchor", label: "Anchor processing" },
  { status: "completed", label: "USDC delivered" },
];

export const WITHDRAW_LADDER: Array<{ status: Sep6Status; label: string }> = [
  { status: "incomplete", label: "Order created" },
  { status: "pending_user_transfer_start", label: "Awaiting USDC payment" },
  { status: "pending_anchor", label: "Anchor paying TRY" },
  { status: "completed", label: "TRY sent to IBAN" },
];

const TERMINAL: Sep6Status[] = ["completed", "error", "expired", "refunded"];

export const isTerminal = (status: Sep6Status): boolean =>
  TERMINAL.includes(status);

/** Index of a status on a ladder — used to light up the stepper. */
export function ladderIndex(
  ladder: Array<{ status: Sep6Status }>,
  status: Sep6Status,
): number {
  const exact = ladder.findIndex((step) => step.status === status);
  if (exact >= 0) return exact;
  // Statuses the anchor can emit that are not their own rung: they all mean
  // "the anchor is working on it".
  if (status === "pending_stellar" || status === "pending_trust") return 2;
  if (status === "completed") return ladder.length - 1;
  return 0;
}

async function anchorFetch<T>(url: string, jwt: Jwt, init?: RequestInit): Promise<T> {
  const token = await resolveJwt(jwt);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new AnchorUnauthorizedError();
  }
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `Anchor request failed (HTTP ${response.status}).`);
  }
  return payload;
}

interface RawAssetInfo {
  enabled?: boolean;
  fee_percent?: number;
  funding_methods?: string[];
  min_amount?: number;
  max_amount?: number;
}

/**
 * GET /info. Limits and the accepted funding methods are read here rather than
 * copied from documentation, so the UI enforces whatever the anchor currently
 * says instead of a number that was true last week.
 */
export async function anchorInfo(
  cfg: AnchorConfig,
  jwt: Jwt,
): Promise<Sep6Info> {
  const raw = await anchorFetch<{
    deposit?: Record<string, RawAssetInfo>;
    withdraw?: Record<string, RawAssetInfo>;
  }>(`${cfg.transferServer}/info`, jwt);
  const deposit = raw.deposit?.[cfg.asset.code];
  const withdraw = raw.withdraw?.[cfg.asset.code];
  return {
    depositEnabled: deposit?.enabled !== false,
    withdrawEnabled: withdraw?.enabled !== false,
    feePercent: Number(deposit?.fee_percent ?? withdraw?.fee_percent ?? 0),
    fundingMethods: deposit?.funding_methods || ["bank_account"],
    minAmount: typeof deposit?.min_amount === "number" ? deposit.min_amount : null,
    maxAmount: typeof deposit?.max_amount === "number" ? deposit.max_amount : null,
    minWithdrawAmount:
      typeof withdraw?.min_amount === "number" ? withdraw.min_amount : null,
  };
}

const PRETTY_FIELD: Record<string, string> = {
  iban: "IBAN",
  bank_name: "Bank",
  bank_account_number: "Account number",
  account_holder: "Account holder",
  recipient: "Recipient",
  external_transfer_memo: "Transfer reference",
  reference: "Transfer reference",
  amount: "Amount",
};

const prettyLabel = (key: string): string =>
  PRETTY_FIELD[key] ||
  key.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());

/**
 * `how` (legacy) and `instructions` (modern) both appear in the wild, and the
 * instruction values are sometimes strings and sometimes `{value, description}`
 * objects. Flatten all of it into label/value pairs the UI can just render.
 */
function flattenInstructions(raw: Record<string, unknown>): Array<{
  label: string;
  value: string;
}> {
  const fields: Array<{ label: string; value: string }> = [];
  const push = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      const entry = value as { value?: unknown; description?: unknown };
      if (entry.value !== undefined) {
        fields.push({ label: prettyLabel(key), value: String(entry.value) });
      }
      return;
    }
    fields.push({ label: prettyLabel(key), value: String(value) });
  };

  const instructions = raw.instructions;
  if (instructions && typeof instructions === "object") {
    for (const [key, value] of Object.entries(instructions)) push(key, value);
  }
  if (typeof raw.how === "string" && raw.how.trim()) {
    fields.push({ label: "Instructions", value: raw.how });
  } else if (raw.how && typeof raw.how === "object") {
    for (const [key, value] of Object.entries(raw.how)) push(key, value);
  }
  for (const key of ["external_transfer_memo", "bank_account", "iban"]) {
    if (key in raw && !fields.some((field) => field.label === prettyLabel(key))) {
      push(key, raw[key]);
    }
  }
  return fields;
}

/** GET /deposit — TRY in, USDC out. */
export async function startDeposit(
  cfg: AnchorConfig,
  jwt: Jwt,
  params: { account: string; amount?: string },
): Promise<DepositInstructions> {
  const query = new URLSearchParams({
    asset_code: cfg.asset.code,
    account: params.account,
    // Modern anchors read `funding_method`, older SEP-6 clients send `type`.
    // Sending both costs nothing and works against either.
    funding_method: "bank_account",
    type: "bank_account",
  });
  if (params.amount) query.set("amount", params.amount);

  const raw = await anchorFetch<Record<string, unknown>>(
    `${cfg.transferServer}/deposit?${query.toString()}`,
    jwt,
  );
  const fields = flattenInstructions(raw);
  const reference =
    fields.find((field) => field.label === "Transfer reference")?.value || "";
  return {
    id: String(raw.id || ""),
    fields,
    reference,
    moreInfoUrl: String(raw.more_info_url || ""),
    eta: raw.eta ? `${raw.eta}` : "",
  };
}

/**
 * Sandbox-only: tells the anchor "the lira just landed". A production anchor
 * learns this from its bank instead, which is the only line of this flow that
 * would be deleted when moving to mainnet.
 */
export async function simulateBankTransfer(
  cfg: AnchorConfig,
  jwt: Jwt,
  id: string,
  amount: string,
): Promise<void> {
  await anchorFetch(
    `${cfg.transferServer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`,
    jwt,
    { method: "POST", body: JSON.stringify({ amount }) },
  );
}

/** GET /withdraw — USDC in, TRY out. */
export async function startWithdraw(
  cfg: AnchorConfig,
  jwt: Jwt,
  params: { amount: string; dest?: string },
): Promise<WithdrawInstructions> {
  const query = new URLSearchParams({
    asset_code: cfg.asset.code,
    funding_method: "bank_account",
    type: "bank_account",
    amount: params.amount,
  });
  if (params.dest) query.set("dest", params.dest);

  const raw = await anchorFetch<Record<string, unknown>>(
    `${cfg.transferServer}/withdraw?${query.toString()}`,
    jwt,
  );
  const accountId = String(raw.account_id || "");
  const memo = String(raw.memo ?? "");
  if (!accountId || !memo) {
    throw new Error("Anchor did not return a treasury account and memo for the withdrawal.");
  }
  return {
    id: String(raw.id || ""),
    accountId,
    memo,
    memoType: String(raw.memo_type || "id"),
    eta: raw.eta ? `${raw.eta}` : "",
  };
}

/**
 * Sends the classic USDC payment that funds a withdrawal.
 *
 * **The memo is the only thing tying this payment to the withdrawal order.** A
 * payment that reaches the treasury without it is not refundable by the anchor
 * — it simply sits there unmatched. `memo_type` is "id" on this anchor, so the
 * memo must be built with `Memo.id`, never `Memo.text`.
 */
export async function sendWithdrawalPayment(
  cfg: AnchorConfig,
  account: string,
  instructions: WithdrawInstructions,
  amount: string,
): Promise<string> {
  const source = await horizon.loadAccount(account);
  const memo =
    instructions.memoType === "text"
      ? Memo.text(instructions.memo)
      : instructions.memoType === "hash"
        ? Memo.hash(instructions.memo)
        : Memo.id(instructions.memo);

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: instructions.accountId,
        asset: new Asset(cfg.asset.code, cfg.asset.issuer),
        amount,
      }),
    )
    .addMemo(memo)
    .setTimeout(120)
    .build();

  const signed = await signTransaction(transaction.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: account,
  });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error("Withdrawal payment was rejected in the wallet.");
  }
  const result = await horizon.submitTransaction(
    TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET),
  );
  if (!result.successful) throw new Error("Horizon rejected the withdrawal payment.");
  return result.hash;
}

/** GET /transaction?id= */
export async function getTransaction(
  cfg: AnchorConfig,
  jwt: Jwt,
  id: string,
): Promise<Sep6Transaction> {
  const raw = await anchorFetch<{ transaction?: Record<string, unknown> }>(
    `${cfg.transferServer}/transaction?id=${encodeURIComponent(id)}`,
    jwt,
  );
  const transaction = raw.transaction || {};
  return {
    id: String(transaction.id || id),
    kind: String(transaction.kind || ""),
    status: String(transaction.status || "incomplete") as Sep6Status,
    statusMessage: String(transaction.message || transaction.status_eta || ""),
    amountIn: String(transaction.amount_in ?? ""),
    amountOut: String(transaction.amount_out ?? ""),
    amountInAsset: String(transaction.amount_in_asset ?? ""),
    amountOutAsset: String(transaction.amount_out_asset ?? ""),
    amountFeeAsset: String(transaction.amount_fee_asset ?? ""),
    amountFee: String(transaction.amount_fee ?? ""),
    stellarTransactionId: String(transaction.stellar_transaction_id || ""),
    externalTransactionId: String(transaction.external_transaction_id || ""),
    moreInfoUrl: String(transaction.more_info_url || ""),
  };
}

/**
 * Polls a transaction until it reaches a terminal status. Returns a cancel
 * function; the caller must invoke it on unmount, or a closed dialog keeps
 * hammering the anchor for the rest of the session.
 */
export function pollTransaction(
  cfg: AnchorConfig,
  jwt: Jwt,
  id: string,
  onUpdate: (transaction: Sep6Transaction) => void,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false;
  const deadline = Date.now() + 5 * 60_000;

  const tick = async (): Promise<void> => {
    while (!stopped && Date.now() < deadline) {
      try {
        const transaction = await getTransaction(cfg, jwt, id);
        if (stopped) return;
        onUpdate(transaction);
        if (isTerminal(transaction.status)) return;
      } catch (error) {
        if (stopped) return;
        // A blip must not kill the poll — only a hard auth failure is worth
        // surfacing, because the caller has to re-authenticate for it.
        if (error instanceof AnchorUnauthorizedError) {
          onError?.(error);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  };

  void tick();
  return () => {
    stopped = true;
  };
}
