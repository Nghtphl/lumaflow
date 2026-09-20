# TriggerVault Technical Specification

## Data Structures
- Order: id, owner, token_in, token_out, amount_in, min_user_out, fee_bps, status
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

`min_user_out` is the order's on-chain limit boundary, and it is a floor on **what the
owner receives**, not on the swap. An executor may attempt execution at any time. The
vault measures the increase in its own `token_out` balance across the swap — it does not
trust the amount reported by the router — then takes the keeper bounty from that observed
delta and checks the remainder against `min_user_out`. If the owner's share falls short,
the entire transaction reverts.

Because the bounty is deducted before the check, the vault asks the router for a *gross*
minimum large enough to leave `min_user_out` standing afterwards, rounded up so truncation
cannot land a stroop below the floor. That request is only a request; the guarantee is
re-derived from the observed delta. The bounty is capped at 1,000 basis points (10%), so
the divisor is never smaller than 9,000 and never zero.

`create_order` derives that gross requirement up front and rejects an order whose floor
could never be met, so collateral is never escrowed against a promise the contract already
knows it cannot keep.

This is a limit-order primitive, not an oracle-based stop-loss. A future stop-loss
mode requires an explicit trigger type and a trusted price-source specification.

## Storage lifetime

Critical persistent entries and the contract instance are created with an
approximately 120-day TTL target and renewed when less than approximately 30 days
remain. Order reads and state-changing operations request renewal. Off-chain
services must submit a state-changing maintenance transaction before the threshold;
RPC simulation of a getter does not persist a TTL extension.
