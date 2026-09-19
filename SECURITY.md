# Security Policy — TriggerVault

## 1. Threat Model & Architecture

TriggerVault is a non-custodial limit and automated order engine on Soroban. The protocol enforces security invariants on-chain:

- **Atomic Balance-Delta Settlement**: The vault does not rely on third-party return values. It records its internal token balance before invoking a swap and asserts that `balance_after - balance_before >= min_amount_out`.
- **Non-Custodial Escrow**: User funds remain strictly within the vault contract instance until order conditions are met or the creator cancels the order.
- **Strict Authorization**: Only the order creator can invoke `cancel_order`. `execute_order` is permissionless for registered keepers but strictly bound by the creator's predefined `min_amount_out` and execution deadline.

## 2. Fee & Slippage Protections

- **Fee Caps**: Keeper rewards are bounded and paid strictly from the realized trade output, never deducted ahead of time from collateral.
- **Slippage Enforcement**: If market conditions change and the swap output falls below `min_amount_out`, the transaction panics and reverts atomically.

## 3. Reporting Vulnerabilities

If you discover a vulnerability within TriggerVault smart contracts or anchor integrations, please open a security advisory or report directly to the team.
