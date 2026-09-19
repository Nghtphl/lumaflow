#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env, Vec,
};

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
}

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
    pub min_amount_out: i128,
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
    pub fn init(env: Env, admin: Address, router: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Router, &router);
    }

    pub fn set_router(env: Env, router: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAuthorized)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Router, &router);
        Ok(())
    }

    pub fn get_router(env: Env) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Router)
            .ok_or(Error::RouterNotSet)
    }

    pub fn create_order(
        env: Env,
        owner: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        fee_bps: u32,
    ) -> Result<u32, Error> {
        owner.require_auth();

        if amount_in <= 0 || min_amount_out <= 0 {
            return Err(Error::InvalidAmount);
        }
        if fee_bps > 10_000 {
            return Err(Error::InvalidFee);
        }

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
            min_amount_out,
            fee_bps,
            status: OrderStatus::Active,
        };

        env.storage().persistent().set(&DataKey::Order(new_id), &order);
        env.storage().persistent().set(&DataKey::NextOrderId, &new_id);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("create")),
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

        let token_client = token::Client::new(&env, &order.token_in);
        token_client.transfer(&env.current_contract_address(), &order.owner, &order.amount_in);

        order.status = OrderStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);

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

        let router = Self::get_router(env.clone())?;

        // 1. Kilitli token_in'i Router adresine transfer et
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(&env.current_contract_address(), &router, &order.amount_in);

        // 2. Takas parametrelerini oluştur ve Router'ı çağır
        let mut path: Vec<Address> = Vec::new(&env);
        path.push_back(order.token_in.clone());
        path.push_back(order.token_out.clone());

        let deadline = env.ledger().timestamp() + 300;
        let router_client = RouterClient::new(&env, &router);
        let amounts = router_client.swap_exact_tokens_for_tokens(
            &order.amount_in,
            &order.min_amount_out,
            &path,
            &env.current_contract_address(),
            &deadline,
        );

        let amount_out = if amounts.is_empty() {
            0
        } else {
            amounts.get(amounts.len() - 1).unwrap_or(0)
        };

        if amount_out < order.min_amount_out {
            return Err(Error::SlippageExceeded);
        }

        // 3. Prim hesapla ve dağıt
        let fee_amount = (amount_out * (order.fee_bps as i128)) / 10_000;
        let user_amount = amount_out - fee_amount;

        let token_out_client = token::Client::new(&env, &order.token_out);
        if fee_amount > 0 {
            token_out_client.transfer(&env.current_contract_address(), &executor, &fee_amount);
        }
        token_out_client.transfer(&env.current_contract_address(), &order.owner, &user_amount);

        // 4. Durumu güncelle
        order.status = OrderStatus::Executed;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("execute")),
            (order_id, executor, amount_out, fee_amount),
        );

        Ok(())
    }

    pub fn get_order(env: Env, order_id: u32) -> Result<Order, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)
    }

    pub fn get_order_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::NextOrderId)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
