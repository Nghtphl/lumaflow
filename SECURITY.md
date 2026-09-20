# Security Policy — LumaFlow

## 1. Threat Model & Architecture

LumaFlow is a non-custodial limit and automated order engine on Soroban. The protocol enforces security invariants on-chain:

- **Atomic Balance-Delta Settlement**: The vault does not rely on third-party return values. It records its internal token balance before invoking a swap, treats `balance_after - balance_before` as the realised output, and asserts that what remains after the keeper bounty is at least `min_user_out`.
- **Non-Custodial Escrow**: User funds remain strictly within the vault contract instance until order conditions are met or the creator cancels the order.
- **Strict Authorization**: Only the order creator can invoke `cancel_order`. `execute_order` is permissionless but strictly bound by the creator's predefined `min_user_out` — a floor on the amount transferred to the owner, after the bounty — and by the swap deadline.

## 2. Fee & Slippage Protections

- **Fee Caps**: Keeper rewards are bounded and paid strictly from the realized trade output, never deducted ahead of time from collateral.
- **Slippage Enforcement**: If market conditions change and the owner's share of the realised output falls below `min_user_out`, the transaction reverts atomically.

## 3. Reporting Vulnerabilities

If you discover a vulnerability within LumaFlow smart contracts or anchor integrations, please open a security advisory or report directly to the team.
