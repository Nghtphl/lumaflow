#![no_std]
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token, vec,
    Address, Env, IntoVal, Symbol, Vec,
};

/// Subset of the SoroswapRouter interface that TriggerVault depends on.
///
/// `swap_exact_tokens_for_tokens` is the AMM entry point. `router_pair_for`
/// resolves the pool contract that the router will move `amount_in` into, which
/// the vault needs in advance in order to authorize that transfer (see
/// `execute_order`).
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

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    OrderNotFound = 1,
    OrderNotActive = 2,
    InvalidAmount = 3,
    InvalidFee = 4,
    RouterNotSet = 5,
    SlippageExceeded = 6,
    NotAuthorized = 7,
    IdenticalTokens = 8,
    InvalidBalanceDelta = 9,
    AlreadyInitialized = 10,
    InputNotSpent = 11,
    MathOverflow = 12,
}

// Soroban ledgers close approximately every five seconds. Active protocol state is
// renewed when it has less than ~30 days left, back to ~120 days. Persistent data
// can still be restored from archival, but proactively renewing it keeps normal
// order execution and cancellation on the live ledger.
pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
pub(crate) const PERSISTENT_TTL_EXTEND_TO: u32 = 2_073_600;
pub(crate) const MAX_FEE_BPS: u32 = 1_000;
pub(crate) const SWAP_DEADLINE_WINDOW: u64 = 300;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum OrderStatus {
    Active = 0,
    Executed = 1,
    Cancelled = 2,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Order {
    pub id: u32,
    pub owner: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    /// The floor on what reaches the owner's wallet, *after* the keeper bounty.
    ///
    /// The earlier deployment held a gross floor and deducted the bounty from
    /// it afterwards, so an order guarded at 38 paid out 37.62 at 100 bps — the
    /// guarantee named a number the owner never received. This one is checked
    /// against the figure actually transferred to the owner.
    pub min_user_out: i128,
    pub fee_bps: u32,
    pub status: OrderStatus,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Order(u32),
    NextOrderId,
    Router,
    Admin,
}

#[contract]
pub struct TriggerVault;

#[contractimpl]
impl TriggerVault {
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
    }

    fn bump_persistent_key(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
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
        let rounded = scaled
            .checked_add(divisor - 1)
            .ok_or(Error::MathOverflow)?;
        Ok(rounded / divisor)
    }

    pub fn init(env: Env, admin: Address, router: Address) -> Result<(), Error> {
        admin.require_auth();

        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Router, &router);
        Self::bump_persistent_key(&env, &DataKey::Admin);
        Self::bump_persistent_key(&env, &DataKey::Router);
        Self::bump_instance_ttl(&env);
        Ok(())
    }

    pub fn set_router(env: Env, router: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAuthorized)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Router, &router);
        Self::bump_persistent_key(&env, &DataKey::Admin);
        Self::bump_persistent_key(&env, &DataKey::Router);
        Self::bump_instance_ttl(&env);
        Ok(())
    }

    pub fn get_router(env: Env) -> Result<Address, Error> {
        let router = env
            .storage()
            .persistent()
            .get(&DataKey::Router)
            .ok_or(Error::RouterNotSet)?;
        Self::bump_persistent_key(&env, &DataKey::Router);
        Self::bump_instance_ttl(&env);
        Ok(router)
    }

    pub fn create_order(
        env: Env,
        owner: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_user_out: i128,
        fee_bps: u32,
    ) -> Result<u32, Error> {
        owner.require_auth();

        if amount_in <= 0 || min_user_out <= 0 {
            return Err(Error::InvalidAmount);
        }
        if token_in == token_out {
            return Err(Error::IdenticalTokens);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        // An order whose gross floor cannot be derived can never execute. Prove
        // it here, before the collateral moves, rather than letting the owner
        // fund an order that only fails when a keeper first tries it. Being
        // cancellable is not an answer to escrowing funds against a promise the
        // contract already knows it cannot keep.
        Self::gross_floor_for(min_user_out, fee_bps)?;

        let token_client = token::Client::new(&env, &token_in);
        token_client.transfer(&owner, &env.current_contract_address(), &amount_in);

        let current_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextOrderId)
            .unwrap_or(0);
        let new_id = current_id + 1;

        let order = Order {
            id: new_id,
            owner: owner.clone(),
            token_in,
            token_out,
            amount_in,
            min_user_out,
            fee_bps,
            status: OrderStatus::Active,
        };

        env.storage().persistent().set(&DataKey::Order(new_id), &order);
        env.storage().persistent().set(&DataKey::NextOrderId, &new_id);
        Self::bump_persistent_key(&env, &DataKey::Order(new_id));
        Self::bump_persistent_key(&env, &DataKey::NextOrderId);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("created")),
            (new_id, owner, amount_in),
        );

        Ok(new_id)
    }

    pub fn cancel_order(env: Env, order_id: u32) -> Result<(), Error> {
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)?;

        order.owner.require_auth();

        if order.status != OrderStatus::Active {
            return Err(Error::OrderNotActive);
        }

        order.status = OrderStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);
        Self::bump_persistent_key(&env, &DataKey::Order(order_id));
        Self::bump_instance_ttl(&env);

        let token_client = token::Client::new(&env, &order.token_in);
        token_client.transfer(&env.current_contract_address(), &order.owner, &order.amount_in);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("cancel")),
            order_id,
        );

        Ok(())
    }

    pub fn execute_order(env: Env, order_id: u32, executor: Address) -> Result<(), Error> {
        executor.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)?;

        if order.status != OrderStatus::Active {
            return Err(Error::OrderNotActive);
        }

        Self::bump_persistent_key(&env, &DataKey::Order(order_id));

        // What the router will be asked for: the gross that leaves
        // `min_user_out` standing once the bounty comes out. Computed before
        // any external call so an unsatisfiable order fails without having
        // touched the router or issued an authorization. It is only a request —
        // the guarantee is re-derived from the observed delta below.
        let router_floor = Self::gross_floor_for(order.min_user_out, order.fee_bps)?;

        let router = Self::get_router(env.clone())?;
        let vault = env.current_contract_address();

        let token_in_client = token::Client::new(&env, &order.token_in);
        let token_out_client = token::Client::new(&env, &order.token_out);

        // Both legs are measured as balance deltas on this contract. The router's
        // return value is never trusted, and pre-existing balances held for other
        // open orders cancel out of the delta.
        let token_in_before = token_in_client.balance(&vault);
        let token_out_before = token_out_client.balance(&vault);

        let router_client = RouterClient::new(&env, &router);

        // SoroswapRouter does not take custody of the input: it calls
        // `token_in.transfer(from = to, to = pair, amount_in)` itself, one frame
        // below this call. An invoker's authorization is only implied for the
        // calls it makes directly, so that nested transfer would fail unless the
        // vault authorizes it up front. The entry is scoped as tightly as the
        // auth framework allows: this token, this pool, this exact amount, and no
        // sub-invocations of its own. A wrong pool address cannot redirect funds
        // — the router computes the real recipient, and a mismatch simply fails
        // the authorization and reverts the whole transaction.
        let pair = router_client.router_pair_for(&order.token_in, &order.token_out);
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

        let deadline = env.ledger().timestamp() + SWAP_DEADLINE_WINDOW;
        router_client.swap_exact_tokens_for_tokens(
            &order.amount_in,
            &router_floor,
            &path,
            &vault,
            &deadline,
        );

        // The collateral must have left the vault exactly once. This rejects a
        // router that reports a swap without taking the input, which would
        // otherwise leave unaccounted collateral stranded in the vault.
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

        // Bounty first, then the floor — in that order, because the floor is a
        // promise about the owner's wallet and the bounty comes out before the
        // owner is paid. Checking the gross here instead would guarantee a
        // number nobody receives.
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

        if fee_amount > 0 {
            token_out_client.transfer(&vault, &executor, &fee_amount);
        }
        token_out_client.transfer(&vault, &order.owner, &user_amount);

        order.status = OrderStatus::Executed;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("execute")),
            (order_id, executor, amount_out, fee_amount),
        );

        Ok(())
    }

    pub fn get_order(env: Env, order_id: u32) -> Result<Order, Error> {
        let order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)?;
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
}

#[cfg(test)]
mod test;
