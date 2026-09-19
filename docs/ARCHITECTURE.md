# TriggerVault Architecture & Security Model

## System Flow
1. Order Creation (create_order): Creator authenticates and deposits token_in into vault.
2. Order Cancellation (cancel_order): Only creator can cancel active order; 100% refunded.
3. Order Execution (execute_order): Triggered by keepers; swaps via router, checks slippage, routes bounty to keeper and swapped tokens to user.

## Storage
- Persistent storage for orders (DataKey::Order(u32)).
- Deterministic key indexing with NextOrderId.
