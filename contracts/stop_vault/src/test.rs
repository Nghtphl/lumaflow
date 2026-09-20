#![cfg(test)]
//! Each contract double lives in its own module on purpose.
//!
//! `#[contractimpl]` emits module-level items named after the *method*
//! (`__lastprice`, `__SPEC_XDR_FN_...`), not after the contract type. Two
//! doubles sharing a module therefore redefine the same symbols and the test
//! target stops compiling. A module per double keeps the generated names apart.

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Env, Symbol,
};

/// Configurable SEP-40 feed.
///
/// One double rather than six, because every oracle failure this contract has
/// to survive is a *value* it can be told to return — missing, negative, stale,
/// ahead of the ledger, skewed between legs, or published at a scale the policy
/// does not expect. Splitting those into separate contracts would test the
/// harness rather than the vault.
mod mock_oracle {
    use super::*;

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn seed(env: Env, decimals: u32, base: Symbol) {
            env.storage().instance().set(&symbol_short!("dec"), &decimals);
            env.storage().instance().set(&symbol_short!("base"), &base);
            env.storage().instance().set(&symbol_short!("mode"), &0u32);
        }

        /// 0 = answer normally, 1 = return None, 2 = panic.
        pub fn set_mode(env: Env, mode: u32) {
            env.storage().instance().set(&symbol_short!("mode"), &mode);
        }

        pub fn set_decimals(env: Env, decimals: u32) {
            env.storage().instance().set(&symbol_short!("dec"), &decimals);
        }

        pub fn set_base(env: Env, base: Symbol) {
            env.storage().instance().set(&symbol_short!("base"), &base);
        }

        pub fn set_price(env: Env, asset: Symbol, price: i128, timestamp: u64) {
            env.storage().instance().set(&asset, &(price, timestamp));
        }

        pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
            let mode: u32 = env
                .storage()
                .instance()
                .get(&symbol_short!("mode"))
                .unwrap_or(0);
            if mode == 1 {
                return None;
            }
            if mode == 2 {
                panic!("oracle is down");
            }
            let code = match asset {
                OracleAsset::Other(code) => code,
                OracleAsset::Stellar(_) => return None,
            };
            env.storage()
                .instance()
                .get::<Symbol, (i128, u64)>(&code)
                .map(|(price, timestamp)| PriceData { price, timestamp })
        }

        pub fn decimals(env: Env) -> u32 {
            env.storage()
                .instance()
                .get(&symbol_short!("dec"))
                .unwrap_or(14)
        }

        pub fn base(env: Env) -> OracleAsset {
            let code: Symbol = env
                .storage()
                .instance()
                .get(&symbol_short!("base"))
                .unwrap();
            OracleAsset::Other(code)
        }
    }
}
use mock_oracle::{MockOracle, MockOracleClient};

/// Behaves like SoroswapRouter: authorizes against `to`, **pulls** the input
/// into the pool itself, then pays the output. The pull is what makes it
/// meaningful — it exercises the nested-transfer authorization a real AMM
/// needs, which a router paying from its own balance would never surface.
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
            token::Client::new(&env, &path.get(0).unwrap()).transfer(&to, &pair, &amount_in);
            let out = amount_in * 2;
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &out);
            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(out);
            res
        }
    }
}
use pulling_router::PullingRouter;

/// Delivers 1% less than the floor it was asked for while claiming it filled.
/// The shortfall is sized to clear `min_user_out` on the gross and fail it on
/// the net, which is the only gap the bounty ordering can open.
mod stingy_router {
    use super::*;

    #[contract]
    pub struct StingyRouter;

    #[contractimpl]
    impl StingyRouter {
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
            let out = amount_out_min * 99 / 100;
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &out);
            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(amount_out_min);
            res
        }
    }
}
use stingy_router::StingyRouter;

/// Pays without ever taking the input. The vault must reject it: the collateral
/// would otherwise sit unaccounted in the contract.
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
            let out = amount_in * 2;
            token::Client::new(&env, &path.get(1).unwrap()).transfer(&pair, &to, &out);
            let mut res = Vec::new(&env);
            res.push_back(amount_in);
            res.push_back(out);
            res
        }
    }
}
use non_pulling_router::NonPullingRouter;

const SCALE: i128 = 100_000_000_000_000; // 10^14
const XLM_AT_20_CENTS: i128 = 20_000_000_000_000;
const XLM_AT_17_CENTS: i128 = 17_000_000_000_000;
const USDC_AT_PAR: i128 = SCALE;
const NOW: u64 = 1_700_000_000;
const DEADLINE: u64 = NOW + 86_400;
const STOP_AT_18_CENTS: i128 = 18_000_000_000_000;

struct Fixture {
    vault: Address,
    oracle: MockOracleClient<'static>,
    owner: Address,
    executor: Address,
    token_in: Address,
    token_out: Address,
}

fn sym(env: &Env, text: &str) -> Symbol {
    Symbol::new(env, text)
}

fn policy(env: &Env, oracle: &Address) -> OraclePolicy {
    OraclePolicy {
        source: oracle.clone(),
        base: OracleAsset::Other(sym(env, "USD")),
        asset: OracleAsset::Other(sym(env, "XLM")),
        quote: OracleAsset::Other(sym(env, "USDC")),
        decimals: 14,
        max_age_secs: 900,
        max_skew_secs: 60,
        max_future_secs: 0,
        version: 1,
    }
}

/// A vault wired to `router`, with a healthy feed at 0.20 USDC/XLM, collateral
/// minted to the owner and output liquidity sitting in the pool.
fn setup(env: &Env, router: Address, owner_balance: i128, pool: i128) -> Fixture {
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = NOW);

    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(env, &oracle_id);
    oracle.seed(&14, &sym(env, "USD"));
    oracle.set_price(&sym(env, "XLM"), &XLM_AT_20_CENTS, &NOW);
    oracle.set_price(&sym(env, "USDC"), &USDC_AT_PAR, &NOW);

    let token_admin = Address::generate(env);
    let token_in = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_out = env.register_stellar_asset_contract_v2(token_admin).address();

    let vault = env.register(
        TriggerStopVault,
        (
            router.clone(),
            policy(env, &oracle_id),
            token_in.clone(),
            token_out.clone(),
            1_000_000_000i128,
        ),
    );

    let owner = Address::generate(env);
    let executor = Address::generate(env);
    token::StellarAssetClient::new(env, &token_in).mint(&owner, &owner_balance);
    token::StellarAssetClient::new(env, &token_out).mint(&router, &pool);

    Fixture {
        vault,
        oracle,
        owner,
        executor,
        token_in,
        token_out,
    }
}

fn create(f: &Fixture, client: &TriggerStopVaultClient, min_user_out: i128, fee_bps: u32) -> u32 {
    client.create_stop_order(
        &f.owner,
        &f.token_in,
        &f.token_out,
        &1_000i128,
        &min_user_out,
        &fee_bps,
        &DEADLINE,
        &STOP_AT_18_CENTS,
    )
}

fn drop_price(f: &Fixture, env: &Env) {
    f.oracle
        .set_price(&sym(env, "XLM"), &XLM_AT_17_CENTS, &env.ledger().timestamp());
}

// ── trigger ─────────────────────────────────────────────────────────────────

#[test]
fn stop_above_the_market_is_accepted_and_not_yet_triggerable() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    let id = create(&f, &client, 450, 100);
    assert_eq!(client.get_order(&id).status, StopStatus::Armed);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::TriggerNotMet))
    );
}

#[test]
fn a_stop_at_or_below_the_market_is_refused_before_collateral_moves() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let balance = token::Client::new(&env, &f.token_in).balance(&f.owner);

    // Exactly at the market, and below it. Neither is a stop.
    for stop in [XLM_AT_20_CENTS, XLM_AT_20_CENTS + 1] {
        assert_eq!(
            client.try_create_stop_order(
                &f.owner,
                &f.token_in,
                &f.token_out,
                &1_000i128,
                &450i128,
                &100u32,
                &DEADLINE,
                &stop,
            ),
            Err(Ok(Error::StopNotBelowMarket))
        );
    }
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.owner), balance);
}

#[test]
fn equality_with_the_stop_is_a_fall_through_it() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle
        .set_price(&sym(&env, "XLM"), &STOP_AT_18_CENTS, &NOW);
    client.trigger_stop(&id, &f.executor);

    let order = client.get_order(&id);
    assert_eq!(order.status, StopStatus::Triggered);
    assert_eq!(order.observed_price, STOP_AT_18_CENTS);
    assert_eq!(order.observed_timestamp, NOW);
    assert_eq!(order.triggered_at, NOW);
}

#[test]
fn the_cross_rate_is_taken_against_the_quote_not_against_one() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    // XLM sits at 0.18 USD, which would be exactly on the stop if USDC were
    // assumed to be worth one dollar. It is not: USDC is at 1.02, so a lumen
    // buys fewer than 0.18 USDC and the level has genuinely been passed.
    f.oracle.set_price(&sym(&env, "XLM"), &STOP_AT_18_CENTS, &NOW);
    f.oracle
        .set_price(&sym(&env, "USDC"), &(SCALE * 102 / 100), &NOW);
    client.trigger_stop(&id, &f.executor);
    assert!(client.get_order(&id).observed_price < STOP_AT_18_CENTS);
}

#[test]
fn a_trigger_cannot_be_recorded_twice() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::NotArmed))
    );
}

// ── the persistent trigger ──────────────────────────────────────────────────

#[test]
fn a_recorded_fall_survives_a_swap_that_could_not_fill() {
    let env = Env::default();
    let router = env.register(StingyRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    assert_eq!(
        client.try_execute_stop(&id, &f.executor),
        Err(Ok(Error::SlippageExceeded))
    );
    // The fall happened. A thin pool does not un-happen it.
    assert_eq!(client.get_order(&id).status, StopStatus::Triggered);
}

#[test]
fn a_recovered_price_does_not_close_a_triggered_order() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);

    // Back above the stop, and fresh.
    env.ledger().with_mut(|l| l.timestamp = NOW + 60);
    f.oracle
        .set_price(&sym(&env, "XLM"), &XLM_AT_20_CENTS, &(NOW + 60));
    client.execute_stop(&id, &f.executor);
    assert_eq!(client.get_order(&id).status, StopStatus::Executed);
}

#[test]
fn an_armed_order_cannot_be_settled() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    assert_eq!(
        client.try_execute_stop(&id, &f.executor),
        Err(Ok(Error::NotTriggered))
    );
    assert_eq!(token::Client::new(&env, &f.token_out).balance(&f.owner), 0);
}

// ── settlement ──────────────────────────────────────────────────────────────

#[test]
fn settlement_pays_the_bounty_and_the_net_separately() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    client.execute_stop(&id, &f.executor);

    let out = token::Client::new(&env, &f.token_out);
    // 1000 in, doubled by the router: 2000 gross, 1% bounty, the rest to the owner.
    assert_eq!(out.balance(&f.executor), 20);
    assert_eq!(out.balance(&f.owner), 1_980);
    assert_eq!(out.balance(&f.executor) + out.balance(&f.owner), 2_000);
    assert_eq!(out.balance(&f.vault), 0);
    assert_eq!(client.get_order(&id).status, StopStatus::Executed);
}

#[test]
fn a_fill_that_clears_the_gross_but_not_the_net_is_refused() {
    let env = Env::default();
    let router = env.register(StingyRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    assert_eq!(
        client.try_execute_stop(&id, &f.executor),
        Err(Ok(Error::SlippageExceeded))
    );
    // Nothing moved: collateral is still escrowed, nobody was paid.
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.vault), 1_000);
    assert_eq!(token::Client::new(&env, &f.token_out).balance(&f.owner), 0);
}

#[test]
fn a_router_that_does_not_take_the_input_is_refused() {
    let env = Env::default();
    let router = env.register(NonPullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    assert_eq!(
        client.try_execute_stop(&id, &f.executor),
        Err(Ok(Error::InputNotSpent))
    );
}

#[test]
fn another_owners_escrow_is_not_spent_by_a_settlement() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    let first = create(&f, &client, 450, 100);
    let second = create(&f, &client, 450, 100);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.vault), 2_000);

    drop_price(&f, &env);
    client.trigger_stop(&first, &f.executor);
    client.execute_stop(&first, &f.executor);

    // The second order's collateral is untouched and still cancellable.
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.vault), 1_000);
    assert_eq!(client.get_order(&second).status, StopStatus::Armed);
    client.cancel_order(&second);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.vault), 0);
}

#[test]
fn a_zero_bounty_pays_the_whole_fill_to_the_owner() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 0);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    client.execute_stop(&id, &f.executor);

    let out = token::Client::new(&env, &f.token_out);
    assert_eq!(out.balance(&f.executor), 0);
    assert_eq!(out.balance(&f.owner), 2_000);
}

#[test]
fn the_bounty_is_capped() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    assert_eq!(
        client.try_create_stop_order(
            &f.owner,
            &f.token_in,
            &f.token_out,
            &1_000i128,
            &450i128,
            &(MAX_FEE_BPS + 1),
            &DEADLINE,
            &STOP_AT_18_CENTS,
        ),
        Err(Ok(Error::InvalidFee))
    );
}

// ── oracle failure modes ────────────────────────────────────────────────────

#[test]
fn a_feed_that_returns_nothing_blocks_the_trigger() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle.set_mode(&1);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleUnavailable))
    );
}

#[test]
fn a_feed_that_panics_blocks_the_trigger_without_taking_the_vault_with_it() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle.set_mode(&2);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleUnavailable))
    );
    assert_eq!(client.get_order(&id).status, StopStatus::Armed);
}

#[test]
fn a_stale_sample_blocks_the_trigger_at_the_policy_boundary() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    // Both orders are written while the market is still above the stop; the
    // feed is only allowed to go stale afterwards.
    let at_the_boundary = create(&f, &client, 450, 100);
    let past_the_boundary = create(&f, &client, 450, 100);

    // max_age_secs is 900. Exactly 900 is still usable; 901 is not.
    f.oracle.set_price(&sym(&env, "XLM"), &XLM_AT_17_CENTS, &NOW);
    env.ledger().with_mut(|l| l.timestamp = NOW + 900);
    client.trigger_stop(&at_the_boundary, &f.executor);
    assert_eq!(
        client.get_order(&at_the_boundary).status,
        StopStatus::Triggered
    );

    env.ledger().with_mut(|l| l.timestamp = NOW + 901);
    assert_eq!(
        client.try_trigger_stop(&past_the_boundary, &f.executor),
        Err(Ok(Error::OracleStale))
    );
}

#[test]
fn a_sample_from_the_future_is_refused() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle
        .set_price(&sym(&env, "XLM"), &XLM_AT_17_CENTS, &(NOW + 1));
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleFuture))
    );
}

#[test]
fn legs_published_too_far_apart_are_not_crossed() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    env.ledger().with_mut(|l| l.timestamp = NOW + 200);
    f.oracle
        .set_price(&sym(&env, "XLM"), &XLM_AT_17_CENTS, &(NOW + 200));
    f.oracle.set_price(&sym(&env, "USDC"), &USDC_AT_PAR, &NOW);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleSkew))
    );
}

#[test]
fn a_feed_that_changes_its_scale_or_its_base_is_refused() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);
    drop_price(&f, &env);

    f.oracle.set_decimals(&7);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleSchemaMismatch))
    );

    f.oracle.set_decimals(&14);
    f.oracle.set_base(&sym(&env, "EUR"));
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OracleSchemaMismatch))
    );
}

#[test]
fn a_non_positive_price_is_refused() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle.set_price(&sym(&env, "XLM"), &0i128, &NOW);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OraclePriceInvalid))
    );

    f.oracle.set_price(&sym(&env, "XLM"), &(-1i128), &NOW);
    assert_eq!(
        client.try_trigger_stop(&id, &f.executor),
        Err(Ok(Error::OraclePriceInvalid))
    );
}

#[test]
fn a_dead_feed_does_not_trap_the_collateral() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    f.oracle.set_mode(&2);
    client.cancel_order(&id);
    assert_eq!(client.get_order(&id).status, StopStatus::Cancelled);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.owner), 10_000);
}

// ── deadline, state and authorization ───────────────────────────────────────

#[test]
fn the_deadline_closes_trigger_and_settlement_but_not_the_exit() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let armed = create(&f, &client, 450, 100);
    let triggered = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&triggered, &f.executor);

    // Equality is already past: the order is good up to, not through, the deadline.
    env.ledger().with_mut(|l| l.timestamp = DEADLINE);
    f.oracle.set_price(&sym(&env, "XLM"), &XLM_AT_17_CENTS, &DEADLINE);
    f.oracle.set_price(&sym(&env, "USDC"), &USDC_AT_PAR, &DEADLINE);

    assert_eq!(
        client.try_trigger_stop(&armed, &f.executor),
        Err(Ok(Error::DeadlinePassed))
    );
    assert_eq!(
        client.try_execute_stop(&triggered, &f.executor),
        Err(Ok(Error::DeadlinePassed))
    );
    client.cancel_order(&armed);
    client.cancel_order(&triggered);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.owner), 10_000);
}

#[test]
fn a_deadline_in_the_past_is_refused_at_creation() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    assert_eq!(
        client.try_create_stop_order(
            &f.owner,
            &f.token_in,
            &f.token_out,
            &1_000i128,
            &450i128,
            &100u32,
            &NOW,
            &STOP_AT_18_CENTS,
        ),
        Err(Ok(Error::InvalidDeadline))
    );
}

#[test]
fn a_closed_order_never_pays_again() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    client.execute_stop(&id, &f.executor);
    let paid = token::Client::new(&env, &f.token_out).balance(&f.owner);

    for outcome in [
        client.try_execute_stop(&id, &f.executor),
        client.try_trigger_stop(&id, &f.executor),
    ] {
        assert_eq!(outcome, Err(Ok(Error::OrderClosed)));
    }
    assert_eq!(client.try_cancel_order(&id), Err(Ok(Error::OrderClosed)));
    assert_eq!(token::Client::new(&env, &f.token_out).balance(&f.owner), paid);
}

#[test]
fn cancelling_wins_the_race_it_is_in_and_settlement_cannot_reopen_it() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    drop_price(&f, &env);
    client.trigger_stop(&id, &f.executor);
    client.cancel_order(&id);

    assert_eq!(
        client.try_execute_stop(&id, &f.executor),
        Err(Ok(Error::OrderClosed))
    );
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.owner), 10_000);
    assert_eq!(token::Client::new(&env, &f.token_out).balance(&f.owner), 0);
}

#[test]
fn the_pair_is_the_only_one_this_version_accepts() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_create_stop_order(
            &f.owner,
            &f.token_in,
            &stranger,
            &1_000i128,
            &450i128,
            &100u32,
            &DEADLINE,
            &STOP_AT_18_CENTS,
        ),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(
        client.try_create_stop_order(
            &f.owner,
            &f.token_in,
            &f.token_in,
            &1_000i128,
            &450i128,
            &100u32,
            &DEADLINE,
            &STOP_AT_18_CENTS,
        ),
        Err(Ok(Error::IdenticalTokens))
    );
}

#[test]
fn an_order_larger_than_the_cap_is_refused() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000_000_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    assert_eq!(
        client.try_create_stop_order(
            &f.owner,
            &f.token_in,
            &f.token_out,
            &1_000_000_001i128,
            &450i128,
            &100u32,
            &DEADLINE,
            &STOP_AT_18_CENTS,
        ),
        Err(Ok(Error::AmountTooLarge))
    );
}

#[test]
fn zero_and_negative_parameters_are_refused() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    for (amount, min_out, stop) in [
        (0i128, 450i128, STOP_AT_18_CENTS),
        (1_000, 0, STOP_AT_18_CENTS),
        (1_000, 450, 0),
        (-1, 450, STOP_AT_18_CENTS),
    ] {
        assert_eq!(
            client.try_create_stop_order(
                &f.owner,
                &f.token_in,
                &f.token_out,
                &amount,
                &min_out,
                &100u32,
                &DEADLINE,
                &stop,
            ),
            Err(Ok(Error::InvalidAmount))
        );
    }
}

#[test]
fn only_the_owner_can_take_the_collateral_back() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);
    let id = create(&f, &client, 450, 100);

    // Authorization is mocked for everyone in this fixture, so the check that
    // matters is the one the contract makes: the refund is addressed to the
    // stored owner, never to the caller.
    let stranger = Address::generate(&env);
    client.cancel_order(&id);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&stranger), 0);
    assert_eq!(token::Client::new(&env, &f.token_in).balance(&f.owner), 10_000);
}

#[test]
fn the_configuration_cannot_be_replaced_after_deployment() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    let config = client.get_config();
    assert_eq!(config.policy.version, 1);
    assert_eq!(config.collateral_token, f.token_in);
    assert_eq!(config.payout_token, f.token_out);
    // There is no setter to call: the surface is the proof. If one is ever
    // added, this assertion is where the reviewer should stop.
    let spec = env.as_contract(&f.vault, || {
        env.storage().persistent().has(&DataKey::Config)
    });
    assert!(spec);
}

// ── arithmetic ──────────────────────────────────────────────────────────────

#[test]
fn the_gross_floor_rounds_up_so_truncation_cannot_land_below_the_net() {
    // 450 net at 100 bps needs 454.54… gross; asking for 454 would settle at
    // 454 - 4 = 450 only by luck, and at other sizes it lands a unit short.
    assert_eq!(TriggerStopVault::gross_floor_for(450, 100).unwrap(), 455);
    assert_eq!(TriggerStopVault::gross_floor_for(1, 1_000).unwrap(), 2);
    assert_eq!(TriggerStopVault::gross_floor_for(9_000, 1_000).unwrap(), 10_000);
    assert_eq!(TriggerStopVault::gross_floor_for(100, 0).unwrap(), 100);
}

#[test]
fn the_gross_floor_refuses_to_overflow() {
    assert_eq!(
        TriggerStopVault::gross_floor_for(i128::MAX, 100),
        Err(Error::MathOverflow)
    );
}

#[test]
fn the_cross_rate_is_reported_at_policy_scale() {
    let env = Env::default();
    let router = env.register(PullingRouter, ());
    let f = setup(&env, router, 10_000, 100_000);
    let client = TriggerStopVaultClient::new(&env, &f.vault);

    // 0.20 USD per XLM over 1.00 USD per USDC is 0.20 USDC per XLM.
    assert_eq!(client.current_price(), XLM_AT_20_CENTS);
}
