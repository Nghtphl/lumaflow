# TriggerVault Technical Specification

## Data Structures
- Order: id, owner, token_in, token_out, amount_in, min_amount_out, fee_bps, status
- OrderStatus: Active (0), Executed (1), Cancelled (2)

## Entrypoints
- init(admin: Address, router: Address)
- set_router(router: Address)
- get_router() -> Address
- create_order(...) -> u32
- cancel_order(order_id: u32)
- execute_order(order_id: u32, executor: Address)
- get_order(order_id: u32) -> Order
- get_order_count() -> u32

## Limit-order and slippage semantics

`min_amount_out` is the order's on-chain limit boundary. An executor may attempt
execution at any time, but the entire transaction reverts unless the swap increases
the vault's actual `token_out` balance by at least `min_amount_out`. The protocol
does not trust the amount reported by the router. Keeper bounty is calculated only
from the observed balance increase and is capped at 1,000 basis points (10%).

This is a limit-order primitive, not an oracle-based stop-loss. A future stop-loss
mode requires an explicit trigger type and a trusted price-source specification.

## Storage lifetime

Critical persistent entries and the contract instance are created with an
approximately 120-day TTL target and renewed when less than approximately 30 days
remain. Order reads and state-changing operations request renewal. Off-chain
services must submit a state-changing maintenance transaction before the threshold;
RPC simulation of a getter does not persist a TTL extension.
