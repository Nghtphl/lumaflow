# TriggerVault Security Architecture & Threat Model

This document outlines the security architecture, threat model, mitigation strategies, and operational risk controls implemented across the **TriggerVault** decentralized limit and stop order protocol built on **Stellar Soroban (SDK v22)**.

---

## 1. Threat Matrix & Vulnerability Mitigations

| Threat Vector | Risk Level | Target Component | Applied Mitigation | Status |
| :--- | :---: | :--- | :--- | :---: |
| **State Archival (TTL Expiration)** | Critical | Ledger Persistent Storage | Dual-threshold extend_ttl proactive renewal | **Resolved** |
| **Front-Running / Init Race** | High | Contract Deployment | Cryptographic dmin.require_auth() & re-init guard | **Resolved** |
| **Unauthorized Fund Extraction** | Critical | cancel_order | Native Soroban owner.require_auth() verification | **Resolved** |
| **Slippage & MEV Sandwiching** | High | execute_order | Atomic assertion (eceived_out >= min_amount_out) | **Resolved** |
| **Fee Griefing / Excessive Drain** | Medium | create_order | Hard protocol cap (Max 10% / 1000 BPS) | **Resolved** |
| **Zero-Value State Bloat (DoS)** | Low | Ledger Storage | Positive integer constraint (mount > 0) | **Resolved** |
| **Identical Token Arbitrage Exploit** | Low | Pool / Router | Revert on 	oken_in == token_out | **Resolved** |
| **Keeper Private Key Compromise** | High | Off-Chain Bot | Isolated hot-wallet & permissionless executor model | **Resolved** |

---

## 2. Soroban v22 State Architecture & Lifetime Management

### 2.1 State Archival Prevention (Proactive TTL Bumping)
Soroban utilizes a state archival model where ledger entries that are not accessed within a specific ledger window are moved to archival storage. For non-custodial vaults holding user collateral, dormant orders run the risk of becoming temporarily unspendable if not renewed.

* **Dual-Tier Threshold Renewal:**
  All critical state keys (Admin, Router, OrderCounter, and individual Order(id) entries) utilize the following parameters:
  - PERSISTENT_TTL_THRESHOLD = 518_400 (~30 days at 5-second ledger intervals)
  - PERSISTENT_TTL_EXTEND_TO = 2_073_600 (~120 days)
* Every interaction (create_order, cancel_order, execute_order, and get_order) automatically triggers ump_persistent_key and ump_instance_ttl, ensuring active orders never drop into archival state while the protocol is active.

### 2.2 Initialization Front-Running Protection
Separated deployment and initialization phases present a front-running vector where an adversary can front-run the deployer and claim the Admin key.
* **Mitigation:**
  TriggerVault::init enforces strict cryptographic verification:
  \\\ust
  admin.require_auth();
  if env.storage().persistent().has(&DataKey::Admin) {
      return Err(Error::AlreadyInitialized);
  }
  \\\
  This prevents unauthorized contract takeover and double-initialization attacks.

### 2.3 Native Soroban Auth Enforcement
Instead of relying on fragile parameter-based authentication patterns, TriggerVault implements the native Soroban Authorization Framework (Address::require_auth()):
* **Order Cancellation:** Only the verifiable order.owner can initiate collateral return. Third parties or malicious keepers cannot trigger arbitrary cancellations.
* **Administrative Operations:** Router address reassignments require cryptographic authorization from the designated protocol admin.

---

## 3. Economic Security & Execution Integrity

### 3.1 Slippage Assertion & Revert Guarantees
During order execution via external routers, market volatility or sandwich attacks could yield unfavorable exchange rates.
* **Mitigation:**
  Execution operates under an atomic assertion:
  \\\ust
  let received_out: i128 = env.invoke_contract(&router, &symbol_short!("swap"), ...);
  if received_out < order.min_amount_out {
      return Err(Error::SlippageExceeded);
  }
  \\\
  If the received token output is even one stroop below min_amount_out, the entire invocation reverts atomically, preserving user collateral.

### 3.2 Checks-Effects-Interactions (CEI) Protocol
To prevent reentrancy and unexpected state mutations during cross-contract calls:
1. **Checks:** Order existence, active status, input amounts, and router registration are verified.
2. **Effects:** Order status transitions to Executed prior to external calls.
3. **Interactions:** Protocol fee is split and transferred to the keeper, followed by router invocation.

### 3.3 Protocol Fee Caps
To eliminate malicious fee configurations or keeper drain vectors:
* Maximum allowed bounty fee is hard-capped at **1000 BPS (10%)**.
* Divisor operations use fixed constant BPS_DENOMINATOR = 10_000, eliminating division-by-zero panics.
* Integer arithmetic uses i128 types across all balance calculations, preventing overflow vulnerabilities.

---

## 4. Off-Chain Keeper Infrastructure Security

1. **Permissionless & Least Privilege:**
   The off-chain keeper bot possesses no privileged contract role. The execute_order endpoint is completely open to the public; anyone running a keeper can participate in decentralized fulfillment.
2. **Key Hijacking Isolation:**
   The private key utilized by the keeper bot only holds minimal testnet gas balances. A compromise of this key grants zero access to locked vault collateral.
3. **Simulation-Gated Broadcasts:**
   The keeper bot validates every trade via Soroban RPC simulateTransaction before network broadcast, mitigating gas waste on failing or front-run transactions.

---

## 5. Automated Test Coverage

The smart contract suite validates the following negative security scenarios:
- **Zero/Negative Collateral:** Invocations with invalid amounts revert with InvalidAmount.
- **Fee Exploitation:** Orders requesting fee BPS > 1000 revert with InvalidFee.
- **Identity Theft in Cancellation:** Unauthorized signers attempting to cancel orders fail native Soroban auth checks.
- **Double Init Attack:** Subsequent calls to init return AlreadyInitialized.
- **Slippage Breach:** Swaps returning less than min_amount_out fail with SlippageExceeded.

---

## 6. Disclosure & Auditing

TriggerVault was developed under the Stellar Soroban security guidelines. For vulnerability disclosures or audit inquiries, contact the core team via repository issue channels.
