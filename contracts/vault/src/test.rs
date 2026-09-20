#![cfg(test)]
//! Each router double lives in its own module on purpose.
//!
//! `#[contractimpl]` emits module-level items named after the *method*
//! (`__swap_exact_tokens_for_tokens`, `__SPEC_XDR_FN_...`), not after the
//! contract type. Three routers sharing a module therefore redefine the same
//! four symbols and the test target stops compiling. A module per double keeps
//! the generated names apart.

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Persistent as _, Address as _, MockAuth, MockAuthInvoke},
    Env, IntoVal, Vec,
};

/// Router double that behaves like SoroswapRouter: it authorizes against `to`,
/// **pulls** `amount_in` out of `to` into the pool, and only then pays the
/// output. The pull is what makes this a meaningful test — it exercises the
/// nested-transfer authorization that a real AMM requires, which a router that
/// pays out of its own balance would never surface.
///
/// The contract doubles as its own pair, mirroring a Uniswap-style pool holding
/// both reserves.
mod pulling_router {
    use super::*;

    #[contract]
    pub struct PullingRouter;

    #[contractimpl]
    impl PullingRouter {
        pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
            env.current_contract_address()
        }

        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            _amount_out_min: i128,
            path: Vec<Address>,
            to: Address,
            _deadline: u64,
        ) -> Vec<i128> {
            to.require_auth();

            let pair = env.current_contract_address();
            let token_in = token::Client::new(&env, &path.get(0).unwrap());
            token_in.transfer(&to, &pair, &amount_in);

            let simulated_out: i128 = amount_in * 2;
            let token_out = token::Client::new(&env, &path.get(1).unwrap());
            token_out.transfer(&pair, &to, &simulated_out);

            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(simulated_out);
            res
        }
    }
}
use pulling_router::PullingRouter;

/// Takes the input like a real router but delivers less than it claims. The
/// vault must believe its own balance delta, not the returned amounts.
mod misreporting_router {
    use super::*;

    #[contract]
    pub struct MisreportingRouter;

    #[contractimpl]
    impl MisreportingRouter {
        pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
            env.current_contract_address()
        }

        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            _amount_out_min: i128,
            path: Vec<Address>,
            to: Address,
            _deadline: u64,
        ) -> Vec<i128> {
            to.require_auth();

            let pair = env.current_contract_address();
            token::Client::new(&env, &path.get(0).unwrap()).transfer(&to, &pair, &amount_in);

            // Transfer less than the limit while claiming a sufficient router output.
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &800);

            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(1_000);
            res
        }
    }
}
use misreporting_router::MisreportingRouter;

/// Pays the output without ever taking the input. Left unchecked this would
/// strand the order's collateral in the vault, unattributed to any order.
mod non_pulling_router {
    use super::*;

    #[contract]
    pub struct NonPullingRouter;

    #[contractimpl]
    impl NonPullingRouter {
        pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
            env.current_contract_address()
        }

        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            _amount_out_min: i128,
            path: Vec<Address>,
            to: Address,
            _deadline: u64,
        ) -> Vec<i128> {
            let pair = env.current_contract_address();
            let simulated_out: i128 = amount_in * 2;
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &simulated_out);

            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(simulated_out);
            res
        }
    }
}
use non_pulling_router::NonPullingRouter;

/// Pays back exactly the `amount_out_min` it was handed, nothing more.
///
/// This is the tightest fill the vault can possibly receive, which is what
/// makes it the probe for the rounding: the gross floor is derived from the net
/// floor, so if that division rounded down, the owner would land a stroop short
/// and every test using a generous router would still pass.
mod exact_floor_router {
    use super::*;

    #[contract]
    pub struct ExactFloorRouter;

    #[contractimpl]
    impl ExactFloorRouter {
        pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
            env.current_contract_address()
        }

        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            amount_out_min: i128,
            path: Vec<Address>,
            to: Address,
            _deadline: u64,
        ) -> Vec<i128> {
            to.require_auth();

            let pair = env.current_contract_address();
            token::Client::new(&env, &path.get(0).unwrap()).transfer(&to, &pair, &amount_in);
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &amount_out_min);

            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(amount_out_min);
            res
        }
    }
}
use exact_floor_router::ExactFloorRouter;

struct Fixture {
    contract_id: Address,
    owner: Address,
    executor: Address,
    token_in: Address,
    token_out: Address,
    router_id: Address,
}

/// Vault initialized against `router`, with `token_in` minted to the owner and
/// `token_out` liquidity sitting in the pool.
fn setup(env: &Env, router_id: Address, owner_balance: i128, pool_liquidity: i128) -> Fixture {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(env, &contract_id);
    client.init(&admin, &router_id);

    let owner = Address::generate(env);
    let executor = Address::generate(env);
    let token_admin = Address::generate(env);

    let token_in = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_out = env.register_stellar_asset_contract_v2(token_admin).address();

    token::StellarAssetClient::new(env, &token_in).mint(&owner, &owner_balance);
    token::StellarAssetClient::new(env, &token_out).mint(&router_id, &pool_liquidity);

    Fixture {
        contract_id,
        owner,
        executor,
        token_in,
        token_out,
        router_id,
    }
}

#[test]
fn test_create_and_cancel_order() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router_id = env.register(PullingRouter, ());

    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &router_id);

    let owner = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token_in_address = sac.address();
    let token_in_client = token::Client::new(&env, &token_in_address);
    let token_in_admin = token::StellarAssetClient::new(&env, &token_in_address);

    let token_out = Address::generate(&env);

    token_in_admin.mint(&owner, &1000);
    assert_eq!(token_in_client.balance(&owner), 1000);

    let order_id = client.create_order(&owner, &token_in_address, &token_out, &500, &450, &50);
    assert_eq!(order_id, 1);
    assert_eq!(token_in_client.balance(&owner), 500);

    client.cancel_order(&1);
    assert_eq!(token_in_client.balance(&owner), 1000);
    assert_eq!(client.get_order(&1).status, OrderStatus::Cancelled);
}

#[test]
fn test_execute_order_with_keeper_bounty() {
    let env = Env::default();
    let router_id = env.register(PullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let token_in_client = token::Client::new(&env, &f.token_in);
    let token_out_client = token::Client::new(&env, &f.token_out);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &900, &500);
    assert_eq!(order_id, 1);

    client.execute_order(&order_id, &f.executor);

    assert_eq!(token_out_client.balance(&f.executor), 50);
    assert_eq!(token_out_client.balance(&f.owner), 950);
    assert_eq!(token_in_client.balance(&f.router_id), 500);
    assert_eq!(token_in_client.balance(&f.contract_id), 0);
    assert_eq!(token_out_client.balance(&f.contract_id), 0);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Executed);
}

/// The regression test for the router authorization pattern.
///
/// Every other execution test runs under `mock_all_auths`, which satisfies
/// *any* `require_auth` — including the vault's own signature on the transfer
/// that the router performs one frame below it. That blanket mock is exactly
/// what hides a missing `authorize_as_current_contract` until a real testnet
/// transaction fails. Here the only mocked authorization is the keeper's
/// top-level call, so the nested transfer can only succeed if `execute_order`
/// issued the invoker-contract entry itself.
#[test]
fn test_execute_order_authorizes_router_pull_with_scoped_auth() {
    let env = Env::default();
    let router_id = env.register(PullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &900, &500);

    let executor = f.executor.clone();
    env.mock_auths(&[MockAuth {
        address: &executor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "execute_order",
            args: (order_id, executor.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.execute_order(&order_id, &executor);

    let token_in_client = token::Client::new(&env, &f.token_in);
    let token_out_client = token::Client::new(&env, &f.token_out);
    assert_eq!(token_in_client.balance(&f.contract_id), 0);
    assert_eq!(token_in_client.balance(&f.router_id), 500);
    assert_eq!(token_out_client.balance(&f.owner), 950);
    assert_eq!(token_out_client.balance(&executor), 50);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Executed);
}

#[test]
fn test_rejects_router_that_does_not_take_the_input() {
    let env = Env::default();
    let router_id = env.register(NonPullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &900, &100);

    assert!(client.try_execute_order(&order_id, &f.executor).is_err());

    let token_in_client = token::Client::new(&env, &f.token_in);
    let token_out_client = token::Client::new(&env, &f.token_out);
    assert_eq!(token_in_client.balance(&f.contract_id), 500);
    assert_eq!(token_out_client.balance(&f.owner), 0);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}

#[test]
fn test_rejects_zero_amounts() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &router);

    let owner = Address::generate(&env);
    let token_in = Address::generate(&env);
    let token_out = Address::generate(&env);

    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &0, &1, &100)
        .is_err());
    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &-1, &1, &100)
        .is_err());
    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &1, &0, &100)
        .is_err());
    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &1, &-1, &100)
        .is_err());
    assert!(client
        .try_create_order(&owner, &token_in, &token_in, &1, &1, &100)
        .is_err());
    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &1, &1, &1_001)
        .is_err());
}

#[test]
fn test_init_requires_admin_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);

    assert!(client.try_init(&admin, &router).is_err());
}

#[test]
fn test_create_order_requires_owner_authorization() {
    let env = Env::default();
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let token_in = Address::generate(&env);
    let token_out = Address::generate(&env);

    assert!(client
        .try_create_order(&owner, &token_in, &token_out, &1, &1, &100)
        .is_err());
}

#[test]
fn test_init_cannot_run_twice() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);

    client.init(&admin, &router);
    assert!(client.try_init(&admin, &router).is_err());
}

#[test]
fn test_cancel_requires_owner_authorization() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &router);

    let owner = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_in = env.register_stellar_asset_contract_v2(token_admin).address();
    let token_out = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token_in).mint(&owner, &100);
    let order_id = client.create_order(&owner, &token_in, &token_out, &100, &90, &100);

    // Return to enforcing mode with no authorization entries. The owner's
    // require_auth in cancel_order must therefore reject this invocation.
    env.set_auths(&[]);
    assert!(client.try_cancel_order(&order_id).is_err());
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}

#[test]
fn test_critical_persistent_entries_have_extended_ttl() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &router);

    let owner = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_in = env.register_stellar_asset_contract_v2(token_admin).address();
    let token_out = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token_in).mint(&owner, &100);
    let order_id = client.create_order(&owner, &token_in, &token_out, &100, &90, &100);

    env.as_contract(&contract_id, || {
        let minimum_expected = PERSISTENT_TTL_EXTEND_TO - 1;
        assert!(env.storage().persistent().get_ttl(&DataKey::Admin) >= minimum_expected);
        assert!(env.storage().persistent().get_ttl(&DataKey::Router) >= minimum_expected);
        assert!(env
            .storage()
            .persistent()
            .get_ttl(&DataKey::NextOrderId)
            >= minimum_expected);
        assert!(env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Order(order_id))
            >= minimum_expected);
    });
}

#[test]
fn test_slippage_uses_actual_received_balance_and_reverts_atomically() {
    let env = Env::default();
    let router_id = env.register(MisreportingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let token_in_client = token::Client::new(&env, &f.token_in);
    let token_out_client = token::Client::new(&env, &f.token_out);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &900, &100);

    assert!(client.try_execute_order(&order_id, &f.executor).is_err());

    // A failed Soroban invocation is atomic: both router transfers roll back and
    // the order remains cancellable with the original input still in the vault.
    assert_eq!(token_in_client.balance(&f.contract_id), 500);
    assert_eq!(token_in_client.balance(&f.router_id), 0);
    assert_eq!(token_out_client.balance(&f.contract_id), 0);
    assert_eq!(token_out_client.balance(&f.router_id), 2_000);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}

// ── The net payout floor ─────────────────────────────────────────────────────
//
// `min_user_out` is a promise about the owner's wallet, not about the swap. The
// earlier deployment checked the gross output and took the bounty out
// afterwards, so an order guarded at 960 could settle paying 950. These pin the
// corrected semantics down at both boundaries and at both ends of the fee range.

/// The case the rename exists for: gross clears the floor, net does not.
#[test]
fn test_rejects_a_fill_that_clears_gross_but_not_the_net_floor() {
    let env = Env::default();
    let router_id = env.register(PullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);
    let token_out_client = token::Client::new(&env, &f.token_out);

    // Router pays 1_000 gross; a 500 bps bounty leaves the owner 950.
    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &960, &500);

    let outcome = client.try_execute_order(&order_id, &f.executor);
    assert_eq!(outcome, Err(Ok(Error::SlippageExceeded)));

    // And the revert is total: no bounty, no payout, collateral still escrowed.
    assert_eq!(token_out_client.balance(&f.owner), 0);
    assert_eq!(token_out_client.balance(&f.executor), 0);
    assert_eq!(
        token::Client::new(&env, &f.token_in).balance(&f.contract_id),
        500
    );
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}

/// The boundary itself: net landing exactly on the floor is a fill.
#[test]
fn test_accepts_a_fill_that_lands_exactly_on_the_net_floor() {
    let env = Env::default();
    let router_id = env.register(PullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &950, &500);
    client.execute_order(&order_id, &f.executor);

    let token_out_client = token::Client::new(&env, &f.token_out);
    assert_eq!(token_out_client.balance(&f.owner), 950);
    assert_eq!(token_out_client.balance(&f.executor), 50);
}

/// The tightest fill the vault can receive still leaves the owner whole.
///
/// A generous router hides the derivation entirely, so this one pays back
/// exactly the gross it was asked for. 997 against 137 bps is deliberately
/// awkward: the exact gross is 1010.85, the derivation rounds it up to 1011,
/// the bounty floors to 13, and the owner ends on 998 — a stroop of headroom
/// rather than a stroop short.
#[test]
fn test_tightest_possible_fill_still_clears_the_net_floor() {
    let env = Env::default();
    let router_id = env.register(ExactFloorRouter, ());
    let f = setup(&env, router_id, 500, 5_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);
    let token_out_client = token::Client::new(&env, &f.token_out);

    // 997 is deliberately awkward against 137 bps: the exact gross is fractional.
    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &997, &137);
    client.execute_order(&order_id, &f.executor);

    let paid = token_out_client.balance(&f.owner);
    assert!(paid >= 997, "owner received {}, promised at least 997", paid);
    assert_eq!(paid, 998);
    // Everything the router paid was split between the two; nothing stuck.
    assert_eq!(token_out_client.balance(&f.executor), 13);
    assert_eq!(token_out_client.balance(&f.contract_id), 0);
}

/// With no bounty the two floors coincide, and nothing is skimmed.
#[test]
fn test_zero_fee_leaves_gross_and_net_identical() {
    let env = Env::default();
    let router_id = env.register(ExactFloorRouter, ());
    let f = setup(&env, router_id, 500, 5_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id = client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &1_000, &0);
    client.execute_order(&order_id, &f.executor);

    let token_out_client = token::Client::new(&env, &f.token_out);
    assert_eq!(token_out_client.balance(&f.owner), 1_000);
    assert_eq!(token_out_client.balance(&f.executor), 0);
}

/// At the 1_000 bps ceiling the divisor is at its smallest, which is where a
/// sloppy derivation would drift furthest.
#[test]
fn test_max_fee_still_honours_the_net_floor() {
    let env = Env::default();
    let router_id = env.register(ExactFloorRouter, ());
    let f = setup(&env, router_id, 500, 5_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id =
        client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &900, &MAX_FEE_BPS);
    client.execute_order(&order_id, &f.executor);

    let paid = token::Client::new(&env, &f.token_out).balance(&f.owner);
    assert!(paid >= 900, "owner received {} at the fee ceiling", paid);
}

/// A floor large enough to overflow the derivation fails before the vault has
/// spoken to the router at all, so no authorization is ever issued.
#[test]
fn test_unsatisfiable_floor_fails_before_touching_the_router() {
    let env = Env::default();
    let router_id = env.register(PullingRouter, ());
    let f = setup(&env, router_id, 500, 2_000);
    let client = TriggerVaultClient::new(&env, &f.contract_id);

    let order_id =
        client.create_order(&f.owner, &f.token_in, &f.token_out, &500, &i128::MAX, &100);

    let outcome = client.try_execute_order(&order_id, &f.executor);
    assert_eq!(outcome, Err(Ok(Error::MathOverflow)));
    assert_eq!(
        token::Client::new(&env, &f.token_in).balance(&f.contract_id),
        500
    );
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}
