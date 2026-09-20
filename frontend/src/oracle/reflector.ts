import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Reflector's SEP-40 price feed on Stellar testnet.
 *
 * Verified against the live contract rather than taken from documentation:
 * `decimals` is 14, `resolution` is 300 seconds, and `base` is USD. Two calls
 * matter here — `lastprice(Other("XLM"))` and `lastprice(Other("USDC"))` — and
 * the asset must be given in the `Other(Symbol)` form. The `Stellar(Address)`
 * form returns null on this deployment, and `twap` is not present on it at all.
 */
const ORACLE_ID =
  (import.meta.env.VITE_REFLECTOR_ORACLE_ID as string | undefined)?.trim() ||
  "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";

const READ_ONLY_SOURCE =
  "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A";

/** `decimals()` on the live contract. Prices are integers scaled by this. */
const PRICE_SCALE = 10n ** 14n;

/**
 * `resolution()` is 300s, so a feed that has missed two publications is late
 * rather than merely between updates. Anything older is treated as unusable.
 */
export const ORACLE_RESOLUTION_SECONDS = 300;
export const ORACLE_STALE_AFTER_SECONDS = ORACLE_RESOLUTION_SECONDS * 3;

export interface OracleQuote {
  /** Price of one XLM in USDC, crossed through both feeds. */
  xlmPerUsdc: number;
  xlmUsd: number;
  usdcUsd: number;
  /** Ledger timestamp the feed published, in seconds. */
  timestamp: number;
  ageSeconds: number;
  stale: boolean;
}

const asset = (code: string): xdr.ScVal =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(code)]);

interface RawPrice {
  price: bigint;
  timestamp: bigint;
}

async function lastPrice(
  server: rpc.Server,
  code: string,
): Promise<RawPrice | null> {
  const transaction = new TransactionBuilder(new Account(READ_ONLY_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(ORACLE_ID).call("lastprice", asset(code)))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) return null;
  if (!simulation.result?.retval) return null;
  const value = scValToNative(simulation.result.retval) as RawPrice | null;
  if (!value || typeof value.price !== "bigint") return null;
  return value;
}

/**
 * XLM priced in USDC, not in dollars. USDC is quoted against USD too and does
 * not sit exactly on 1.0 — it read 1.000245 when this was written — so crossing
 * the two feeds is what the vault's own pair actually trades at. Both legs
 * publish on the same tick, so the cross carries no timestamp skew.
 */
export async function fetchOracleQuote(
  server: rpc.Server,
): Promise<OracleQuote | null> {
  const [xlm, usdc] = await Promise.all([
    lastPrice(server, "XLM"),
    lastPrice(server, "USDC"),
  ]);
  if (!xlm || !usdc || usdc.price <= 0n || xlm.price <= 0n) return null;

  const scaled = (raw: bigint): number =>
    Number((raw * 1_000_000n) / PRICE_SCALE) / 1e6;

  const xlmUsd = scaled(xlm.price);
  const usdcUsd = scaled(usdc.price);
  if (!Number.isFinite(xlmUsd) || !Number.isFinite(usdcUsd) || usdcUsd <= 0) {
    return null;
  }

  // Cross on the integers so the 10^14 scale cancels instead of round-tripping
  // through two lossy divisions.
  const xlmPerUsdc = Number((xlm.price * 1_000_000n) / usdc.price) / 1e6;
  if (!Number.isFinite(xlmPerUsdc) || xlmPerUsdc <= 0) return null;

  const timestamp = Number(xlm.timestamp);
  // A feed timestamp ahead of local time means one of the two clocks is wrong;
  // treat the reading as unusable rather than guessing which.
  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;

  return {
    xlmPerUsdc,
    xlmUsd,
    usdcUsd,
    timestamp,
    ageSeconds,
    stale: ageSeconds < 0 || ageSeconds > ORACLE_STALE_AFTER_SECONDS,
  };
}
