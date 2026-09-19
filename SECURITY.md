# TriggerVault Security Architecture & Threat Model

This document outlines the security architecture, threat model, mitigation strategies, and operational risk controls implemented across the **TriggerVault** decentralized limit and stop order protocol built on **Stellar Soroban (SDK v22)**.

---

## 1. Threat Matrix & Vulnerability Mitigations

| Threat Vector / Web2 Equivalent | Risk Level | Target Component | Applied Web3 Mitigation | Status |
| :--- | :---: | :--- | :--- | :---: |
| **Authentication & Authorization** | Critical | Contract / Ledger | Soroban native Address::require_auth() | **Resolved** |
| **IDOR / Object Hijacking** | Critical | cancel_order | Strict cryptographic order.owner ownership validation | **Resolved** |
| **Input Validation** | High | create_order | Range assertions (mount > 0, 	oken_in != token_out, ee <= 10%) | **Resolved** |
| **State Archival (TTL Expiration)** | Critical | Storage Keys | Proactive dual-threshold extend_ttl renewal | **Resolved** |
| **Front-Running / Init Race** | High | Deployment Phase | dmin.require_auth() & AlreadyInitialized guard | **Resolved** |
| **Slippage & MEV Exploits** | High | execute_order | Atomic execution constraint (eceived_out >= min_amount_out) | **Resolved** |
| **Rate Limiting & Denial of Service** | Medium | Contract Calls | Stellar Base Fee & Soroban Resource/Gas Metering | **Resolved** |
| **Secret Management** | High | Off-Chain Keeper | Ephemeral hot-wallet with no privileged contract roles | **Resolved** |
| **Audit Logs & Monitoring** | Medium | Protocol Events | On-chain Soroban Event Emission (env.events().publish) | **Resolved** |
| **Dependency Vulnerabilities** | Medium | Packages / Crates | Automated static analysis (cargo audit, 
pm audit) | **Resolved** |

---

## 2. Soroban v22 State Architecture & Lifetime Management

### 2.1 State Archival Prevention (Proactive TTL Bumping)
Soroban isolates dormant ledger state through archival mechanisms. For a non-custodial protocol holding locked collateral, dormant orders run the risk of becoming unspendable if not proactively renewed.
- PERSISTENT_TTL_THRESHOLD = 518_400 (~30 days at 5-second ledger intervals)
- PERSISTENT_TTL_EXTEND_TO = 2_073_600 (~120 days)
Every user interaction (create_order, cancel_order, execute_order, and get_order) executes ump_persistent_key and ump_instance_ttl, ensuring active positions never drop into archival state.

### 2.2 Initialization Front-Running Protection
Separated deployment and initialization phases present an attack vector where malicious bots claim contract administration.
- **Mitigation:**
  TriggerVault::init cryptographically enforces dmin.require_auth() and permanently locks re-initialization:
  \\\ust
  admin.require_auth();
  if env.storage().persistent().has(&DataKey::Admin) {
      return Err(Error::AlreadyInitialized);
  }
  \\\

### 2.3 Native Soroban Auth Enforcement (Anti-IDOR)
To prevent Insecure Direct Object References (IDOR):
- **Order Cancellation:** Only the validated order.owner can retrieve collateral. An arbitrary user cannot cancel or withdraw another user's order ID.
- **Admin Configuration:** Router parameter updates strictly require administrative authorization.

---

## 3. Economic Security & Execution Integrity

### 3.1 Slippage Assertion & Atomicity
During order execution via automated market makers (AMMs) or liquidity pools, slippage or sandwich attacks could degrade expected returns.
- **Mitigation:**
  Execution operates under an atomic assertion:
  \\\ust
  let received_out: i128 = env.invoke_contract(&router, &symbol_short!("swap"), ...);
  if received_out < order.min_amount_out {
      return Err(Error::SlippageExceeded);
  }
  \\\
  If the received token output is below min_amount_out, the transaction reverts completely, leaving collateral safe.

### 3.2 Protocol Fee Hard-Caps
- Maximum allowed keeper bounty is capped at **1000 BPS (10.0%)**.
- Math computations use fixed scalar denominators (BPS_DENOMINATOR = 10_000) and native i128 integer types, preventing division-by-zero panics and overflow conditions.

---

## 4. Off-Chain Keeper & Infrastructure Security

1. **Permissionless & Least Privilege:**
   The off-chain keeper bot holds zero privileged keys. Any participant running the keeper client can fulfill eligible orders.
2. **Hot-Wallet Isolation:**
   The KEEPER_SECRET_KEY is loaded strictly via local environment variables (.env) and only maintains minimal testnet XLM for gas submission.
3. **Simulation-Gated Broadcasts:**
   Before broadcasting transactions, the keeper validates conditions using Soroban RPC simulateTransaction, mitigating transaction fee exhaustion on failed attempts.

---

## 5. Auditability, Logging & Supply Chain Security

### 5.1 Immutable Audit Logs (Event Emission)
Every state transition emits structured Soroban events, providing an audit trail for indexers and explorers:
- (order, created) -> (order_id, owner, amount_in)
- (order, cancel) -> (order_id)
- (order, exec) -> (order_id, keeper, received_out)

### 5.2 Dependency Scanning
The repository utilizes static analysis across smart contract crates and client dependencies:
- **Rust / Soroban:** cargo clippy --all-targets and cargo audit for known CVEs.
- **Client & Keeper:** 
pm audit and strict TypeScript compilation checks.
