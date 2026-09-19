#![cfg(test)]
use super::*;
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Env, Vec};

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
