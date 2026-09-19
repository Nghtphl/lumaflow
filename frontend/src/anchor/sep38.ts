import type { AnchorConfig } from "./toml";
import { sep38Asset } from "./toml";
import { AnchorUnauthorizedError, resolveJwt } from "./sep10";
import type { Jwt } from "./sep10";

export const FIAT_ASSET = "iso4217:TRY";
export const FIAT_CODE = "TRY";

export interface Sep38Price {
  /** Units of the sell asset per unit of the buy asset, fees included. */
  totalPrice: number;
  /** The same ratio before the anchor's spread. */
  price: number;
  sellAmount: number;
  buyAmount: number;
  feeTotal: number;
  feeAsset: string;
  quotedAt: Date;
}

export interface AnchorRates {
  /** TRY paid per 1 USDC on the way in (deposit). */
  depositTryPerUsdc: number;
  /** TRY received per 1 USDC on the way out (withdrawal). */
  withdrawTryPerUsdc: number;
  quotedAt: Date;
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function price(
  cfg: AnchorConfig,
  params: { sellAsset: string; buyAsset: string; sellAmount: string },
): Promise<Sep38Price> {
  if (!cfg.quoteServer) {
    throw new Error(`${cfg.orgName} does not publish a SEP-38 quote server`);
  }
  const query = new URLSearchParams({
    sell_asset: params.sellAsset,
    buy_asset: params.buyAsset,
    sell_amount: params.sellAmount,
    context: "sep6",
  });
  const response = await fetch(`${cfg.quoteServer}/price?${query.toString()}`);
  if (response.status === 401 || response.status === 403) {
    throw new AnchorUnauthorizedError();
  }
  const body = (await response.json().catch(() => ({}))) as {
    total_price?: string;
    price?: string;
    sell_amount?: string;
    buy_amount?: string;
    fee?: { total?: string; asset?: string };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || `SEP-38 price failed: HTTP ${response.status}`);
  }

  return {
    totalPrice: toNumber(body.total_price),
    price: toNumber(body.price),
    sellAmount: toNumber(body.sell_amount),
    buyAmount: toNumber(body.buy_amount),
    feeTotal: toNumber(body.fee?.total),
    feeAsset: body.fee?.asset || "",
    quotedAt: new Date(),
  };
}

/** On-ramp preview: "500 TRY buys you N USDC, of which F TRY is spread." */
export function priceTryToUsdc(cfg: AnchorConfig, sellAmountTry: string): Promise<Sep38Price> {
  return price(cfg, {
    sellAsset: FIAT_ASSET,
    buyAsset: sep38Asset(cfg),
    sellAmount: sellAmountTry,
  });
}

/** Off-ramp preview: "N USDC pays out M TRY to your IBAN." */
export function priceUsdcToTry(cfg: AnchorConfig, sellAmountUsdc: string): Promise<Sep38Price> {
  return price(cfg, {
    sellAsset: sep38Asset(cfg),
    buyAsset: FIAT_ASSET,
    sellAmount: sellAmountUsdc,
  });
}

/**
 * Both sides of the anchor's TRY/USDC book in one call pair. This is the number
 * the order form is built on: it converts a target the user typed in lira into
 * the USDC-denominated limit the Soroban contract actually enforces. Remove the
 * anchor and the lira column has nothing behind it.
 */
export async function fetchAnchorRates(cfg: AnchorConfig): Promise<AnchorRates> {
  const [buy, sell] = await Promise.all([
    priceTryToUsdc(cfg, "1000"),
    priceUsdcToTry(cfg, "100"),
  ]);

  const depositTryPerUsdc = buy.buyAmount > 0 ? buy.sellAmount / buy.buyAmount : 0;
  const withdrawTryPerUsdc = sell.sellAmount > 0 ? sell.buyAmount / sell.sellAmount : 0;
  if (depositTryPerUsdc <= 0 || withdrawTryPerUsdc <= 0) {
    throw new Error("Anchor returned an unusable TRY/USDC rate");
  }

  return {
    depositTryPerUsdc,
    withdrawTryPerUsdc,
    quotedAt: new Date(),
  };
}

export interface Sep38Quote {
  id: string;
  price: number;
  totalPrice: number;
  sellAmount: number;
  buyAmount: number;
  expiresAt: Date | null;
}

/**
 * A firm quote. Unlike `/price` this is authenticated and binding, and its `id`
 * is what `/deposit-exchange` and `/withdraw-exchange` consume to lock the rate.
 */
export async function requestQuote(
  cfg: AnchorConfig,
  jwt: Jwt,
  params: {
    sellAsset: string;
    buyAsset: string;
    sellAmount?: string;
    buyAmount?: string;
  },
): Promise<Sep38Quote> {
  if (!cfg.quoteServer) {
    throw new Error(`${cfg.orgName} does not publish a SEP-38 quote server`);
  }
  const token = await resolveJwt(jwt);
  const response = await fetch(`${cfg.quoteServer}/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sell_asset: params.sellAsset,
      buy_asset: params.buyAsset,
      ...(params.sellAmount ? { sell_amount: params.sellAmount } : {}),
      ...(params.buyAmount ? { buy_amount: params.buyAmount } : {}),
      context: "sep6",
    }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AnchorUnauthorizedError();
  }
  const body = (await response.json().catch(() => ({}))) as {
    id?: string;
    price?: string;
    total_price?: string;
    sell_amount?: string;
    buy_amount?: string;
    expires_at?: string;
    error?: string;
  };
  if (!response.ok || !body.id) {
    throw new Error(body.error || `SEP-38 quote failed: HTTP ${response.status}`);
  }

  return {
    id: body.id,
    price: toNumber(body.price),
    totalPrice: toNumber(body.total_price),
    sellAmount: toNumber(body.sell_amount),
    buyAmount: toNumber(body.buy_amount),
    expiresAt: body.expires_at ? new Date(body.expires_at) : null,
  };
}

export const formatTry = (value: number): string =>
  `${value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
