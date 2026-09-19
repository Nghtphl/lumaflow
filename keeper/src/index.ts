import {
  rpc,
  Contract,
  TransactionBuilder,
  Account,
  scValToNative,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 4000;

// RPC simülasyonları için salt-okunur dummy adres
const DUMMY_CALLER = "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A";

interface VaultOrder {
  id: number;
  owner: string;
  token_in: string;
  token_out: string;
  amount_in: bigint;
  min_amount_out: bigint;
  fee_bps: number;
  status: number; // 0: Active, 1: Executed, 2: Cancelled
}

class TriggerVaultKeeper {
  private server: rpc.Server;
  private vaultContract: Contract;

  constructor() {
    this.server = new rpc.Server(RPC_URL);
    this.vaultContract = new Contract(VAULT_CONTRACT_ID);
  }

  private async callContract(method: string, ...args: xdr.ScVal[]): Promise<any> {
    const dummyAccount = new Account(DUMMY_CALLER, "0");
    const tx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(this.vaultContract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result) {
      return scValToNative(sim.result.retval);
    }
    return null;
  }

  public async start() {
    console.log("==================================================");
    console.log("🚀 TriggerVault Otonom Keeper Başlatıldı");
    console.log(`📡 Ağ: Stellar Testnet (${RPC_URL})`);
    console.log(`🏦 Kasa Kontratı: ${VAULT_CONTRACT_ID}`);
    console.log(`⏱️  Tarama Aralığı: ${POLL_INTERVAL_MS}ms`);
    console.log("==================================================\n");

    while (true) {
      try {
        await this.scanVault();
      } catch (err: any) {
        console.error("❌ Tarama hatası:", err.message || err);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async scanVault() {
    const totalOrdersRaw = await this.callContract("get_order_count");
    const totalOrders = Number(totalOrdersRaw || 0);

    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] 🔍 Kasa taranıyor... Toplam Emir Sayısı: ${totalOrders}`);

    if (totalOrders === 0) return;

    for (let id = 1; id <= totalOrders; id++) {
      const orderRaw: VaultOrder = await this.callContract("get_order", xdr.ScVal.scvU32(id));
      if (!orderRaw) continue;

      const statusMap = ["AKTİF", "GERÇEKLEŞTİ", "İPTAL EDİLDİ"];
      const statusText = statusMap[orderRaw.status] || "BİLİNMİYOR";

      if (orderRaw.status === 0) {
        const xlmAmount = Number(orderRaw.amount_in) / 10_000_000;
        const minOutXlm = Number(orderRaw.min_amount_out) / 10_000_000;
        const bountyPercent = orderRaw.fee_bps / 100;

        console.log(`  🎯 [Emir #${id}] ${statusText}`);
        console.log(`     ├─ Sahip: ${orderRaw.owner}`);
        console.log(`     ├─ Kilitli Teminat: ${xlmAmount} XLM`);
        console.log(`     ├─ Hedef Çıkış: ≥ ${minOutXlm} Token`);
        console.log(`     ├─ Keeper Primi: %${bountyPercent}`);
        console.log(`     └─ Durum: Fiyat ve slippage şartı bekleniyor...`);
      }
    }
  }
}

const keeper = new TriggerVaultKeeper();
keeper.start();
