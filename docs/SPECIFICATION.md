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
