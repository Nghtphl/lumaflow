#![cfg(test)]
use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Persistent as _, Address as _},
    Env, Vec,
};

#[contract]
pub struct MockRouter;

#[contractimpl]
impl MockRouter {
    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        _amount_in: i128,
        _amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        let token_out_addr = path.get(1).unwrap();
        let token_out_client = token::Client::new(&env, &token_out_addr);

        let simulated_out: i128 = 1000;
        token_out_client.transfer(&env.current_contract_address(), &to, &simulated_out);

        let mut res = Vec::new(&env);
        res.push_back(_amount_in);
        res.push_back(simulated_out);
        res
    }
}

#[contract]
pub struct MisreportingRouter;

#[contractimpl]
impl MisreportingRouter {
    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        _amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        let token_out_addr = path.get(1).unwrap();
        let token_out_client = token::Client::new(&env, &token_out_addr);

        // Transfer less than the limit while claiming a sufficient router output.
        // The vault must use its real balance delta and reject the execution.
        token_out_client.transfer(&env.current_contract_address(), &to, &800);

        let mut res = Vec::new(&env);
        res.push_back(amount_in);
        res.push_back(1_000);
        res
    }
}

#[test]
fn test_create_and_cancel_order() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let mock_router_id = env.register(MockRouter, ());

    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &mock_router_id);

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
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let mock_router_id = env.register(MockRouter, ());

    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &mock_router_id);

    let owner = Address::generate(&env);
    let executor = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let sac_in = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_in = sac_in.address();
    let token_in_admin = token::StellarAssetClient::new(&env, &token_in);
    let token_in_client = token::Client::new(&env, &token_in);

    let sac_out = env.register_stellar_asset_contract_v2(token_admin);
    let token_out = sac_out.address();
    let token_out_admin = token::StellarAssetClient::new(&env, &token_out);
    let token_out_client = token::Client::new(&env, &token_out);

    token_in_admin.mint(&owner, &500);
    token_out_admin.mint(&mock_router_id, &2000);

    let order_id = client.create_order(&owner, &token_in, &token_out, &500, &900, &500);
    assert_eq!(order_id, 1);

    client.execute_order(&1, &executor);

    assert_eq!(token_out_client.balance(&executor), 50);
    assert_eq!(token_out_client.balance(&owner), 950);
    assert_eq!(token_in_client.balance(&mock_router_id), 500);
    assert_eq!(token_in_client.balance(&contract_id), 0);
    assert_eq!(client.get_order(&1).status, OrderStatus::Executed);
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
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let router_id = env.register(MisreportingRouter, ());
    let contract_id = env.register(TriggerVault, ());
    let client = TriggerVaultClient::new(&env, &contract_id);
    client.init(&admin, &router_id);

    let owner = Address::generate(&env);
    let executor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_in = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_out = env.register_stellar_asset_contract_v2(token_admin).address();
    let token_in_admin = token::StellarAssetClient::new(&env, &token_in);
    let token_out_admin = token::StellarAssetClient::new(&env, &token_out);
    let token_in_client = token::Client::new(&env, &token_in);
    let token_out_client = token::Client::new(&env, &token_out);

    token_in_admin.mint(&owner, &500);
    token_out_admin.mint(&router_id, &2_000);
    let order_id = client.create_order(&owner, &token_in, &token_out, &500, &900, &100);

    assert!(client.try_execute_order(&order_id, &executor).is_err());

    // A failed Soroban invocation is atomic: both router transfers roll back and
    // the order remains cancellable with the original input still in the vault.
    assert_eq!(token_in_client.balance(&contract_id), 500);
    assert_eq!(token_in_client.balance(&router_id), 0);
    assert_eq!(token_out_client.balance(&contract_id), 0);
    assert_eq!(token_out_client.balance(&router_id), 2_000);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Active);
}
