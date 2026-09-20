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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class TriggerVaultKeeper {
  private readonly server = new rpc.Server(RPC_URL);
  private readonly vault = new Contract(VAULT_CONTRACT_ID);
  private readonly keypair = KEEPER_SECRET_KEY
    ? Keypair.fromSecret(KEEPER_SECRET_KEY)
    : null;
  private running = true;

  async start(): Promise<void> {
    await this.verifyConnection();
    console.log(`TriggerVault keeper started: ${VAULT_CONTRACT_ID}`);
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
    const source = new Account(READ_ONLY_SOURCE, "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(this.vault.call(method, ...args))
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

const keeper = new TriggerVaultKeeper();
process.once("SIGINT", () => keeper.stop());
process.once("SIGTERM", () => keeper.stop());
keeper.start().catch((error) => {
  console.error(`Keeper stopped: ${errorText(error)}`);
  process.exitCode = 1;
});
