#![no_std]
//! TriggerVault V3 — oracle-gated stop-sell escrow.
//!
//! V2 guards what reaches the owner's wallet but has no opinion about *when* a
//! sale may happen: any keeper may settle a V2 order the moment an AMM can meet
//! the floor. That is a limit order. A stop-loss is the opposite instruction —
//! sell once the market has fallen through a level — and it cannot be expressed
//! by a floor, because a falling price makes a floor harder to meet, not easier.
//!
//! This contract adds the missing half: a trigger, gated on a price feed, kept
//! strictly separate from the payout floor. The two never substitute for one
//! another. `stop_price` decides whether selling is *permitted*; `min_user_out`
//! decides whether a particular fill is *acceptable*. An order can be triggered
//! and still refuse to settle, and that is the correct outcome rather than a
//! failure: a stop that quietly accepts any price is not protection.
//!
//! Deliberately absent, and to stay absent in this version: any admin that can
//! move an order's payout, minimum, fee, tokens or policy; any router or oracle
//! setter; any emergency withdrawal; any upgrade entry point. The router, the
//! oracle and the oracle policy are fixed by the constructor and cannot be
//! changed afterwards. That does not make the dependencies immutable — the
//! oracle deployment this points at carries its own admin and upgrade entry —
//! it only means this contract will not be the thing that moves them.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token, vec,
    Address, Env, IntoVal, Symbol, Vec,
};

/// Subset of the SoroswapRouter interface this vault depends on. Identical to
/// the V2 dependency: the router pulls the input itself, one frame below the
/// call, which is why `execute_stop` authorizes that nested transfer up front.
#[contractclient(name = "RouterClient")]
pub trait RouterInterface {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}

/// SEP-40 asset identifier.
///
/// The deployment this was verified against answers only the `Other(Symbol)`
/// form; `Stellar(Address)` returns null for both legs of this pair. The
/// variant is kept because the standard defines it and a different feed may
/// use it — not because this contract has a path that reaches it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price sample: an integer price at the feed's own scale, and the
/// timestamp the feed says it belongs to.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
    fn decimals(env: Env) -> u32;
    fn base(env: Env) -> OracleAsset;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    OrderNotFound = 1,
    InvalidAmount = 2,
    InvalidFee = 3,
    IdenticalTokens = 4,
    TokenNotAllowed = 5,
    InvalidDeadline = 6,
    DeadlinePassed = 7,
    NotArmed = 8,
    NotTriggered = 9,
    OrderClosed = 10,
    TriggerNotMet = 11,
    StopNotBelowMarket = 12,
    SlippageExceeded = 13,
    InvalidBalanceDelta = 14,
    InputNotSpent = 15,
    NoOutputReceived = 16,
    MathOverflow = 17,
    OracleUnavailable = 18,
    OracleSchemaMismatch = 19,
    OraclePriceInvalid = 20,
    OracleStale = 21,
    OracleFuture = 22,
    OracleSkew = 23,
    InvalidPolicy = 24,
    AmountTooLarge = 25,
    AlreadyInitialized = 26,
}

// Soroban ledgers close roughly every five seconds. Active protocol state is
// renewed when it has less than ~30 days left, back to ~120 days. Simulation of
// a getter does not renew anything; only a state-changing transaction does.
pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
pub(crate) const PERSISTENT_TTL_EXTEND_TO: u32 = 2_073_600;
pub(crate) const MAX_FEE_BPS: u32 = 1_000;
pub(crate) const SWAP_DEADLINE_WINDOW: u64 = 300;

/// What the stored minimum and the stored trigger each mean, and the rules the
/// oracle reading must satisfy. Fixed by the constructor: an order written
/// under this policy can never be re-judged under a different one, because
/// there is no entry point that replaces it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OraclePolicy {
    /// The SEP-40 feed. No setter exists for this field.
    pub source: Address,
    /// Expected `base()` on that feed. A feed that changes its base is refused
    /// rather than reinterpreted.
    pub base: OracleAsset,
    /// The asset being sold, as the feed names it.
    pub asset: OracleAsset,
    /// The asset being bought, as the feed names it. The trigger price is a
    /// cross rate of these two against the shared base.
    pub quote: OracleAsset,
    /// Expected `decimals()`. The stop price is quoted at this scale.
    pub decimals: u32,
    /// How old a sample may be, in seconds. Chosen from the feed's measured
    /// publication cadence at deploy time, not guessed here.
    pub max_age_secs: u64,
    /// How far apart the two legs of the cross rate may be published.
    pub max_skew_secs: u64,
    /// How far ahead of ledger time a sample may claim to be. Zero in this
    /// version; anything larger needs a measured reason and its own test.
    pub max_future_secs: u64,
    /// Bumped whenever any field above would change. Recorded on every order.
    pub version: u32,
}

/// What the order is watching for.
///
/// One variant today. It is an enum rather than a bare price so that a sealed
/// variant can be added by a *later contract* without this one pretending to
/// carry a field it never validates.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TriggerSpec {
    /// Sell once the cross rate trades at or below `stop_price`, expressed in
    /// quote-per-asset at the policy's scale.
    PublicStopBelow(i128),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum StopStatus {
    Armed = 0,
    Triggered = 1,
    Executed = 2,
    Cancelled = 3,
}

/// `Expired` is not a stored state. A passed deadline is a fact about the
/// ledger clock, derivable by anyone from `deadline`, and making it a status
/// would require someone to pay for the transaction that writes it. It closes
/// the trigger and execution paths and leaves cancellation open.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct StopOrder {
    pub id: u32,
    pub owner: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    /// The floor on what reaches the owner's wallet, after the keeper bounty.
    pub min_user_out: i128,
    pub fee_bps: u32,
    /// After this ledger time the order can only be cancelled.
    pub deadline: u64,
    pub trigger: TriggerSpec,
    /// The policy version this order was written under.
    pub policy_version: u32,
    pub status: StopStatus,
    /// Ledger time the trigger was recorded. Zero while Armed.
    pub triggered_at: u64,
    /// The cross rate that satisfied the trigger, at policy scale. Zero while
    /// Armed. Kept so the reason for settling is auditable after the fact.
    pub observed_price: i128,
    /// The feed timestamp that observation came from. Zero while Armed.
    pub observed_timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Order(u32),
    NextOrderId,
    Config,
}

/// Everything fixed at deployment. There is no setter for any of it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub router: Address,
    pub policy: OraclePolicy,
    /// The only collateral this version accepts.
    pub collateral_token: Address,
    /// The only payout this version accepts.
    pub payout_token: Address,
    /// Largest single order, in collateral atoms.
    pub max_amount_in: i128,
}

#[contract]
pub struct TriggerStopVault;

#[contractimpl]
impl TriggerStopVault {
    /// Fixes the router, the oracle policy, the token pair and the size cap.
    ///
    /// A constructor rather than an `initialize` entry point: an initializer
    /// that anyone may call first is a race, and one that only an admin may
    /// call needs an admin, which this contract deliberately does not have.
    pub fn __constructor(
        env: Env,
        router: Address,
        policy: OraclePolicy,
        collateral_token: Address,
        payout_token: Address,
        max_amount_in: i128,
    ) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if collateral_token == payout_token {
            return Err(Error::IdenticalTokens);
        }
        if max_amount_in <= 0 {
            return Err(Error::InvalidAmount);
        }
        // A policy that cannot be satisfied would escrow collateral against an
        // order that can never trigger, so it is refused here rather than at
        // the first trigger attempt.
        if policy.decimals == 0 || policy.decimals > 38 {
            return Err(Error::InvalidPolicy);
        }
        if policy.max_age_secs == 0 {
            return Err(Error::InvalidPolicy);
        }
        if policy.asset == policy.quote || policy.asset == policy.base {
            return Err(Error::InvalidPolicy);
        }

        let config = Config {
            router,
            policy,
            collateral_token,
            payout_token,
            max_amount_in,
        };
        env.storage().persistent().set(&DataKey::Config, &config);
        Self::bump_persistent_key(&env, &DataKey::Config);
        Self::bump_instance_ttl(&env);
        Ok(())
    }

    // ── reads ───────────────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> Result<Config, Error> {
        let config = Self::config(&env)?;
        Self::bump_persistent_key(&env, &DataKey::Config);
        Self::bump_instance_ttl(&env);
        Ok(config)
    }

    pub fn get_order(env: Env, order_id: u32) -> Result<StopOrder, Error> {
        let order = Self::order(&env, order_id)?;
        Self::bump_persistent_key(&env, &DataKey::Order(order_id));
        Self::bump_instance_ttl(&env);
        Ok(order)
    }

    pub fn get_order_count(env: Env) -> u32 {
        let count = env
            .storage()
            .persistent()
            .get(&DataKey::NextOrderId)
            .unwrap_or(0);
        if count > 0 {
            Self::bump_persistent_key(&env, &DataKey::NextOrderId);
        }
        Self::bump_instance_ttl(&env);
        count
    }

    /// The cross rate the contract would read right now, at policy scale.
    ///
    /// Exposed so a keeper can decide whether a trigger is worth attempting and
    /// so an interface can show the same number the contract would use. It is a
    /// read: simulating it proves nothing about a later transaction, and it
    /// renews no TTL.
    pub fn current_price(env: Env) -> Result<i128, Error> {
        let config = Self::config(&env)?;
        let (price, _) = Self::read_cross_rate(&env, &config.policy)?;
        Ok(price)
    }

    // ── writes ──────────────────────────────────────────────────────────────

    /// Escrows collateral against a stop that is not yet permitted to sell.
    ///
    /// Every check runs before the transfer. An order that could never trigger,
    /// never settle, or never be read is refused while the collateral is still
    /// the owner's, because being cancellable afterwards is not an answer to
    /// having taken it under a promise the contract already knows it cannot
    /// keep.
    pub fn create_stop_order(
        env: Env,
        owner: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_user_out: i128,
        fee_bps: u32,
        deadline: u64,
        stop_price: i128,
    ) -> Result<u32, Error> {
        owner.require_auth();
        let config = Self::config(&env)?;

        if amount_in <= 0 || min_user_out <= 0 || stop_price <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount_in > config.max_amount_in {
            return Err(Error::AmountTooLarge);
        }
        if token_in == token_out {
            return Err(Error::IdenticalTokens);
        }
        // This version sells one pair in one direction. A wider allowlist is a
        // later decision with its own oracle policy per pair, not a relaxation
        // of this check.
        if token_in != config.collateral_token || token_out != config.payout_token {
            return Err(Error::TokenNotAllowed);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }
        // Prove the gross the router would have to deliver is representable
        // before taking anything.
        Self::gross_floor_for(min_user_out, fee_bps)?;

        // A stop written at or below the current market is not a stop; it is a
        // market sell wearing one's name, and it would trigger on its first
        // reading. Refuse it and let the owner re-decide against live numbers.
        // This is only possible because the price is public: a sealed variant
        // cannot make the same check without a proof, which is exactly why it
        // is not in this contract.
        let (price_now, _) = Self::read_cross_rate(&env, &config.policy)?;
        if price_now <= stop_price {
            return Err(Error::StopNotBelowMarket);
        }

        let token_client = token::Client::new(&env, &token_in);
        token_client.transfer(&owner, &env.current_contract_address(), &amount_in);

        let current_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextOrderId)
            .unwrap_or(0);
        let new_id = current_id + 1;

        let order = StopOrder {
            id: new_id,
            owner: owner.clone(),
            token_in,
            token_out,
            amount_in,
            min_user_out,
            fee_bps,
            deadline,
            trigger: TriggerSpec::PublicStopBelow(stop_price),
            policy_version: config.policy.version,
            status: StopStatus::Armed,
            triggered_at: 0,
            observed_price: 0,
            observed_timestamp: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Order(new_id), &order);
        env.storage()
            .persistent()
            .set(&DataKey::NextOrderId, &new_id);
        Self::bump_persistent_key(&env, &DataKey::Order(new_id));
        Self::bump_persistent_key(&env, &DataKey::NextOrderId);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("stop"), symbol_short!("created")),
            (new_id, owner, amount_in, stop_price),
        );

        Ok(new_id)
    }

    /// Records that the market fell through the stop. Moves no funds.
    ///
    /// Separating this from settlement is the whole point of the design. A
    /// combined call would roll the trigger back whenever the swap failed, so a
    /// fall that genuinely happened would be forgotten because liquidity
    /// happened to be thin in the same ledger. Here the observation is durable
    /// once its own transaction succeeds, and the sale is attempted separately
    /// and may be retried.
    ///
    /// Permissionless, and that gives the caller nothing: it names no recipient
    /// and moves no balance. The executor that is eventually paid is whoever
    /// calls `execute_stop`.
    pub fn trigger_stop(env: Env, order_id: u32, executor: Address) -> Result<(), Error> {
        executor.require_auth();
        let config = Self::config(&env)?;
        let mut order = Self::order(&env, order_id)?;

        match order.status {
            StopStatus::Armed => {}
            StopStatus::Triggered => return Err(Error::NotArmed),
            StopStatus::Executed | StopStatus::Cancelled => return Err(Error::OrderClosed),
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }

        let (price, timestamp) = Self::read_cross_rate(&env, &config.policy)?;
        let TriggerSpec::PublicStopBelow(stop_price) = order.trigger;
        // At or below. Equality is a fall through the level, not a near miss.
        if price > stop_price {
            return Err(Error::TriggerNotMet);
        }

        order.status = StopStatus::Triggered;
        order.triggered_at = env.ledger().timestamp();
        order.observed_price = price;
        order.observed_timestamp = timestamp;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);
        Self::bump_persistent_key(&env, &DataKey::Order(order_id));
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("stop"), symbol_short!("trigger")),
            (order_id, executor, price, timestamp, config.policy.version),
        );

        Ok(())
    }

    /// Settles a triggered order through the router and pays out.
    ///
    /// The price is **not** re-tested against the stop. The fall was recorded
    /// by `trigger_stop` and does not un-happen because the market recovered
    /// before a keeper could fill; an owner who no longer wants the sale
    /// cancels. What is re-tested is that the feed is still healthy, so that a
    /// triggered order cannot be settled while the oracle this contract depends
    /// on is unreadable — and `cancel_order` deliberately does not make that
    /// call, so the owner's exit never depends on the feed.
    pub fn execute_stop(env: Env, order_id: u32, executor: Address) -> Result<(), Error> {
        executor.require_auth();
        let config = Self::config(&env)?;
        let mut order = Self::order(&env, order_id)?;

        match order.status {
            StopStatus::Triggered => {}
            StopStatus::Armed => return Err(Error::NotTriggered),
            StopStatus::Executed | StopStatus::Cancelled => return Err(Error::OrderClosed),
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }
        // Health only. A price above the stop is fine here.
        Self::read_cross_rate(&env, &config.policy)?;

        Self::bump_persistent_key(&env, &DataKey::Order(order_id));

        let router_floor = Self::gross_floor_for(order.min_user_out, order.fee_bps)?;
        let vault = env.current_contract_address();
        let token_in_client = token::Client::new(&env, &order.token_in);
        let token_out_client = token::Client::new(&env, &order.token_out);

        // Both legs are measured as deltas on this contract, so collateral held
        // for other open orders cancels out and the router's return value is
        // never trusted.
        let token_in_before = token_in_client.balance(&vault);
        let token_out_before = token_out_client.balance(&vault);

        let router_client = RouterClient::new(&env, &config.router);
        let pair = router_client.router_pair_for(&order.token_in, &order.token_out);
        // Scoped to this token, this pool and this exact amount, with no
        // sub-invocations of its own. A wrong pair cannot redirect funds: the
        // router computes the real recipient and a mismatch fails the
        // authorization, reverting everything.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: order.token_in.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (vault.clone(), pair, order.amount_in).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let mut path: Vec<Address> = Vec::new(&env);
        path.push_back(order.token_in.clone());
        path.push_back(order.token_out.clone());

        let swap_deadline = env.ledger().timestamp() + SWAP_DEADLINE_WINDOW;
        router_client.swap_exact_tokens_for_tokens(
            &order.amount_in,
            &router_floor,
            &path,
            &vault,
            &swap_deadline,
        );

        let token_in_spent = token_in_before
            .checked_sub(token_in_client.balance(&vault))
            .ok_or(Error::InvalidBalanceDelta)?;
        if token_in_spent != order.amount_in {
            return Err(Error::InputNotSpent);
        }

        let amount_out = token_out_client
            .balance(&vault)
            .checked_sub(token_out_before)
            .ok_or(Error::InvalidBalanceDelta)?;
        if amount_out <= 0 {
            return Err(Error::NoOutputReceived);
        }

        // Bounty first, then the floor, in that order: the floor is a promise
        // about the owner's wallet and the bounty comes out before the owner is
        // paid. Checking the gross instead would guarantee a number nobody
        // receives.
        let fee_amount = amount_out
            .checked_mul(order.fee_bps as i128)
            .ok_or(Error::MathOverflow)?
            / 10_000;
        let user_amount = amount_out
            .checked_sub(fee_amount)
            .ok_or(Error::MathOverflow)?;
        if user_amount < order.min_user_out {
            return Err(Error::SlippageExceeded);
        }

        // Effect before the payouts. Under Soroban's atomicity a failed
        // transfer reverts this too, so the ordering buys no extra safety on
        // its own — it is written this way so that the "terminal state pays
        // once" rule is legible at the point the state changes.
        order.status = StopStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);

        if fee_amount > 0 {
            token_out_client.transfer(&vault, &executor, &fee_amount);
        }
        token_out_client.transfer(&vault, &order.owner, &user_amount);

        Self::bump_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("stop"), symbol_short!("execute")),
            (order_id, executor, amount_out, fee_amount),
        );

        Ok(())
    }

    /// Returns the whole collateral to the owner.
    ///
    /// Open while the order is Armed, while it is Triggered and after the
    /// deadline. It reads no price and calls no router: the owner's way out
    /// must not depend on a feed being up, a keeper being alive or a pool
    /// having liquidity, because those are precisely the conditions under which
    /// someone wants out.
    pub fn cancel_order(env: Env, order_id: u32) -> Result<(), Error> {
        let mut order = Self::order(&env, order_id)?;
        order.owner.require_auth();

        match order.status {
            StopStatus::Armed | StopStatus::Triggered => {}
            StopStatus::Executed | StopStatus::Cancelled => return Err(Error::OrderClosed),
        }

        order.status = StopStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Order(order_id), &order);
        Self::bump_persistent_key(&env, &DataKey::Order(order_id));
        Self::bump_instance_ttl(&env);

        let token_client = token::Client::new(&env, &order.token_in);
        token_client.transfer(
            &env.current_contract_address(),
            &order.owner,
            &order.amount_in,
        );

        env.events().publish(
            (symbol_short!("stop"), symbol_short!("cancel")),
            (order_id, order.amount_in),
        );

        Ok(())
    }

    // ── internals ───────────────────────────────────────────────────────────

    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
    }

    fn bump_persistent_key(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
    }

    fn config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Config)
            .ok_or(Error::InvalidPolicy)
    }

    fn order(env: &Env, order_id: u32) -> Result<StopOrder, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)
    }

    /// The gross output needed for `min_user_out` to survive the bounty.
    ///
    /// `fee_bps` is capped at `MAX_FEE_BPS`, so the divisor is never smaller
    /// than 9_000 and never zero. The division rounds **up**: asking the router
    /// for the exact quotient would let a truncated gross land a stroop short
    /// of the floor, and the router minimum is a request, not the guarantee.
    fn gross_floor_for(min_user_out: i128, fee_bps: u32) -> Result<i128, Error> {
        let divisor = 10_000i128 - (fee_bps as i128);
        let scaled = min_user_out
            .checked_mul(10_000)
            .ok_or(Error::MathOverflow)?;
        let rounded = scaled.checked_add(divisor - 1).ok_or(Error::MathOverflow)?;
        Ok(rounded / divisor)
    }

    /// One validated SEP-40 sample, or an error naming what was wrong with it.
    ///
    /// Every failure mode the feed can present is a distinct error rather than
    /// a panic: an unreadable feed must not be indistinguishable from a feed
    /// that says the trigger was not met.
    fn read_sample(
        env: &Env,
        client: &OracleClient,
        asset: &OracleAsset,
        policy: &OraclePolicy,
    ) -> Result<PriceData, Error> {
        let sample = client
            .try_lastprice(asset)
            .map_err(|_| Error::OracleUnavailable)?
            .map_err(|_| Error::OracleUnavailable)?
            .ok_or(Error::OracleUnavailable)?;

        if sample.price <= 0 {
            return Err(Error::OraclePriceInvalid);
        }

        let now = env.ledger().timestamp();
        if sample.timestamp > now {
            // Subtracting in the other order would wrap on u64. Compare first.
            if sample.timestamp - now > policy.max_future_secs {
                return Err(Error::OracleFuture);
            }
        } else if now - sample.timestamp > policy.max_age_secs {
            return Err(Error::OracleStale);
        }

        Ok(sample)
    }

    /// The quote-per-asset cross rate at policy scale, with its feed timestamp.
    ///
    /// Both legs are read against the same base and crossed with a single
    /// multiplication before any division, so the scale is applied once and the
    /// result is never rounded twice. Rounding down here is deliberate and
    /// conservative for a stop-below: a truncated rate can only read *lower*
    /// than the true one, and the trigger fires at or below the level, so the
    /// error can delay a trigger by one atom but can never invent one.
    fn read_cross_rate(env: &Env, policy: &OraclePolicy) -> Result<(i128, u64), Error> {
        let client = OracleClient::new(env, &policy.source);

        // Schema before values: a feed that changed its scale or its base is
        // refused, not reinterpreted against numbers that no longer mean what
        // the stored stop price meant.
        let decimals = client
            .try_decimals()
            .map_err(|_| Error::OracleUnavailable)?
            .map_err(|_| Error::OracleUnavailable)?;
        if decimals != policy.decimals {
            return Err(Error::OracleSchemaMismatch);
        }
        let base = client
            .try_base()
            .map_err(|_| Error::OracleUnavailable)?
            .map_err(|_| Error::OracleUnavailable)?;
        if base != policy.base {
            return Err(Error::OracleSchemaMismatch);
        }

        let asset = Self::read_sample(env, &client, &policy.asset, policy)?;
        let quote = Self::read_sample(env, &client, &policy.quote, policy)?;

        // Two legs published far apart are two different moments, and crossing
        // them produces a rate that never existed.
        let skew = if asset.timestamp > quote.timestamp {
            asset.timestamp - quote.timestamp
        } else {
            quote.timestamp - asset.timestamp
        };
        if skew > policy.max_skew_secs {
            return Err(Error::OracleSkew);
        }

        let scale = Self::pow10(policy.decimals)?;
        let price = asset
            .price
            .checked_mul(scale)
            .ok_or(Error::MathOverflow)?
            / quote.price;
        if price <= 0 {
            return Err(Error::OraclePriceInvalid);
        }

        // The older of the two is what the pair is actually worth as evidence.
        let timestamp = if asset.timestamp < quote.timestamp {
            asset.timestamp
        } else {
            quote.timestamp
        };
        Ok((price, timestamp))
    }

    fn pow10(exponent: u32) -> Result<i128, Error> {
        let mut value: i128 = 1;
        let mut remaining = exponent;
        while remaining > 0 {
            value = value.checked_mul(10).ok_or(Error::MathOverflow)?;
            remaining -= 1;
        }
        Ok(value)
    }
}

#[cfg(test)]
mod test;
