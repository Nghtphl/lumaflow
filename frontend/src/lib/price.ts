/**
 * A large ask against a small deposit drives the implied unit price below a
 * hundredth of a cent, where a fixed four places would render every such limit
 * as "0.0000". Significant digits keep those apart.
 */
export const formatUsdcPrice = (value: number): string =>
  value >= 0.01 ? value.toFixed(4) : value.toPrecision(2);

/**
 * Which side of the limit price fills. Collateral in dollars is a bid on the
 * target asset, so it fills as that asset gets cheaper; collateral in the
 * target asset is an offer, and fills as it gets dearer.
 */
export const limitComparator = (collateralSymbol: string): "≤" | "≥" =>
  collateralSymbol === "USDC" ? "≤" : "≥";
