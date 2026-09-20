import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";

dotenv.config();

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const RPC_URL = requiredEnv("RPC_URL");
const VAULT_CONTRACT_ID = requiredEnv("VAULT_CONTRACT_ID");
/**
 * The stop vault, when one has been deployed. Optional on purpose: a keeper
 * pointed at a stop vault that does not exist would log a failure every poll
 * and teach its operator to ignore the log.
 */
const STOP_VAULT_CONTRACT_ID = process.env.STOP_VAULT_CONTRACT_ID?.trim();
const KEEPER_SECRET_KEY = process.env.KEEPER_SECRET_KEY?.trim();
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 4_000);
const CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_POLL_MS = 2_000;
const READ_ONLY_SOURCE =
  "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A";

type VaultOrder = {
  id: number;
  owner: string;
  token_in: string;
  token_out: string;
  amount_in: bigint;
  min_user_out: bigint;
  fee_bps: number;
  status: number;
};

/** `StopOrder` as the V3 contract returns it. */
type StopVaultOrder = VaultOrder & {
  deadline: bigint;
  /** `["PublicStopBelow", <price at feed scale>]`. */
  trigger: [string, bigint];
  policy_version: number;
};

/** Mirrors `StopStatus`. */
const STOP_ARMED = 0;
const STOP_TRIGGERED = 1;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class LumaFlowKeeper {
  private readonly server = new rpc.Server(RPC_URL);
  private readonly vault = new Contract(VAULT_CONTRACT_ID);
  private readonly stopVault = STOP_VAULT_CONTRACT_ID
    ? new Contract(STOP_VAULT_CONTRACT_ID)
    : null;
  private readonly keypair = KEEPER_SECRET_KEY
    ? Keypair.fromSecret(KEEPER_SECRET_KEY)
    : null;
  private running = true;

  async start(): Promise<void> {
    await this.verifyConnection();
    console.log(`LumaFlow keeper started: ${VAULT_CONTRACT_ID}`);
    console.log(
      this.stopVault
        ? `Stop vault: ${STOP_VAULT_CONTRACT_ID}`
        : "Stop vault: not configured (STOP_VAULT_CONTRACT_ID unset)",
    );
    console.log(
      this.keypair
        ? `Execution mode: ${this.keypair.publicKey()}`
        : "Read-only mode: KEEPER_SECRET_KEY is not configured",
    );

    while (this.running) {
      try {
        await this.scanOrders();
      } catch (error) {
        console.error(`Scan failed: ${errorText(error)}`);
      }
      try {
        if (this.running) await this.scanStopOrders();
      } catch (error) {
        console.error(`Stop scan failed: ${errorText(error)}`);
      }
      if (this.running) await delay(POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async verifyConnection(): Promise<void> {
    const [health, network] = await Promise.all([
      this.server.getHealth(),
      this.server.getNetwork(),
    ]);
    if (health.status !== "healthy") throw new Error("RPC is not healthy");
    if (network.passphrase !== NETWORK_PASSPHRASE) {
      throw new Error("NETWORK_PASSPHRASE does not match RPC network");
    }
    if (this.keypair) await this.server.getAccount(this.keypair.publicKey());
  }

  private async readContract<T>(
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<T> {
    return this.readOn<T>(this.vault, method, ...args);
  }

  private async readOn<T>(
    contract: Contract,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<T> {
    const source = new Account(READ_ONLY_SOURCE, "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error(`${method} simulation failed`);
    }
    return scValToNative(simulation.result.retval) as T;
  }

  private async scanOrders(): Promise<void> {
    const orderCount = await this.readContract<number>("get_order_count");

    for (let orderId = 1; orderId <= orderCount && this.running; orderId += 1) {
      try {
        const order = await this.readContract<VaultOrder>(
          "get_order",
          xdr.ScVal.scvU32(orderId),
        );
        // Retired deployments store a gross floor under a different name. The
        // keeper settles only where the guarantee is the owner's net payout, so
        // a vault carrying the old schema is refused outright rather than
        // executed on terms its owners never agreed to.
        if (order.min_user_out === undefined) {
          console.error(
            `Refusing to run: ${VAULT_CONTRACT_ID} stores a gross minimum ` +
              `(min_amount_out). This keeper only settles vaults that guarantee ` +
              `the owner's net payout. Point VAULT_CONTRACT_ID at the current vault.`,
          );
          this.running = false;
          return;
        }

        if (order.status !== 0) continue;

        console.log(
          `Active order #${order.id} | owner=${order.owner} | ` +
            `amount=${order.amount_in} | minOut=${order.min_user_out} | ` +
            `fee=${order.fee_bps}bps`,
        );
        if (this.keypair) await this.executeOrder(order);
      } catch (error) {
        console.error(`Order #${orderId} read failed: ${errorText(error)}`);
      }
    }
  }

  private async executeOrder(order: VaultOrder): Promise<void> {
    const keypair = this.keypair;
    if (!keypair) return;

    try {
      const publicKey = keypair.publicKey();
      const source = await this.server.getAccount(publicKey);
      const transaction = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          this.vault.call(
            "execute_order",
            xdr.ScVal.scvU32(order.id),
            Address.fromString(publicKey).toScVal(),
          ),
        )
        .setTimeout(60)
        .build();

      const simulation = await this.server.simulateTransaction(transaction);
      if (!rpc.Api.isSimulationSuccess(simulation)) return;

      const prepared = rpc.assembleTransaction(transaction, simulation).build();
      prepared.sign(keypair);
      const submission = await this.send(prepared);
      const result = await this.waitForConfirmation(submission.hash);

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`Order #${order.id} executed: ${submission.hash}`);
      } else {
        console.error(`Order #${order.id} failed: ${submission.hash}`);
      }
    } catch (error) {
      console.log(`Order #${order.id} not executable: ${errorText(error)}`);
    }
  }

  /**
   * One pass over the stop vault.
   *
   * Armed orders are checked against the price the *contract* computes, not
   * against a rate this process derives: the keeper's job is to avoid pointless
   * calls, and a second opinion about the price would only create a second way
   * to be wrong. Triggered orders are handed to simulation, which refuses the
   * ones the pool cannot fill.
   */
  private async scanStopOrders(): Promise<void> {
    const stopVault = this.stopVault;
    if (!stopVault) return;

    const count = await this.readOn<number>(stopVault, "get_order_count");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error(`Stop vault returned an unusable order count: ${count}`);
      return;
    }

    let price: bigint | null = null;
    try {
      price = await this.readOn<bigint>(stopVault, "current_price");
    } catch (error) {
      // A feed that cannot be read blocks triggering, but not the pass: the
      // orders already triggered can still be settled.
      console.error(`Stop vault price unavailable: ${errorText(error)}`);
    }

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (let orderId = 1; orderId <= count && this.running; orderId += 1) {
      try {
        const order = await this.readOn<StopVaultOrder>(
          stopVault,
          "get_order",
          xdr.ScVal.scvU32(orderId),
        );
        if (order.status !== STOP_ARMED && order.status !== STOP_TRIGGERED) {
          continue;
        }
        if (order.deadline !== undefined && now >= order.deadline) {
          // Past its deadline the contract refuses both calls. Only the owner
          // can act now, and the keeper is not the owner.
          continue;
        }

        if (order.status === STOP_TRIGGERED) {
          console.log(`Stop order #${order.id} triggered, attempting settlement`);
          if (this.keypair) {
            await this.submit(stopVault, "execute_stop", [
              xdr.ScVal.scvU32(order.id),
              Address.fromString(this.keypair.publicKey()).toScVal(),
            ], `Stop order #${order.id} execute`);
          }
          continue;
        }

        const stopPrice = Array.isArray(order.trigger) ? order.trigger[1] : null;
        if (stopPrice === null || stopPrice === undefined) {
          console.error(
            `Stop order #${order.id} carries a trigger this keeper does not ` +
              `understand; leaving it alone.`,
          );
          continue;
        }
        if (price === null) continue;
        if (price > stopPrice) continue;

        console.log(
          `Stop order #${order.id} | price=${price} <= stop=${stopPrice} | recording the fall`,
        );
        if (this.keypair) {
          await this.submit(stopVault, "trigger_stop", [
            xdr.ScVal.scvU32(order.id),
            Address.fromString(this.keypair.publicKey()).toScVal(),
          ], `Stop order #${order.id} trigger`);
        }
      } catch (error) {
        console.error(`Stop order #${orderId} read failed: ${errorText(error)}`);
      }
    }
  }

  /**
   * Simulate, sign, send, and wait for one call.
   *
   * A simulation that fails ends the attempt quietly: for a stop that usually
   * means the pool cannot meet the floor, which is the contract protecting the
   * owner rather than an error to retry against.
   */
  private async submit(
    contract: Contract,
    method: string,
    args: xdr.ScVal[],
    label: string,
  ): Promise<void> {
    const keypair = this.keypair;
    if (!keypair) return;

    try {
      const source = await this.server.getAccount(keypair.publicKey());
      const transaction = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(60)
        .build();

      const simulation = await this.server.simulateTransaction(transaction);
      if (!rpc.Api.isSimulationSuccess(simulation)) {
        console.log(`${label}: not possible yet`);
        return;
      }

      const prepared = rpc.assembleTransaction(transaction, simulation).build();
      prepared.sign(keypair);
      const submission = await this.send(prepared);
      const result = await this.waitForConfirmation(submission.hash);

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`${label}: ${submission.hash}`);
      } else {
        console.error(`${label} failed: ${submission.hash}`);
      }
    } catch (error) {
      console.log(`${label} skipped: ${errorText(error)}`);
    }
  }

  private async send(
    transaction: Transaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    const response = await this.server.sendTransaction(transaction);
    if (response.status !== "PENDING" && response.status !== "DUPLICATE") {
      const detail = response.errorResult?.toXDR("base64") || response.status;
      throw new Error(`Transaction rejected: ${detail}`);
    }
    return response;
  }

  private async waitForConfirmation(
    hash: string,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await this.server.getTransaction(hash);
      if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return result;
      await delay(CONFIRMATION_POLL_MS);
    }
    throw new Error(`Confirmation timed out: ${hash}`);
  }
}

const keeper = new LumaFlowKeeper();
process.once("SIGINT", () => keeper.stop());
process.once("SIGTERM", () => keeper.stop());
keeper.start().catch((error) => {
  console.error(`Keeper stopped: ${errorText(error)}`);
  process.exitCode = 1;
});
