# TriggerVault ⚡

> **Autonomous FX Hedging & Non-Custodial Order Settlement on Stellar**\
> Built for the Rise In × Stellar Pro Hackathon 2026.





TriggerVault connects Turkish retail users and international freelancers to automated, non-custodial limit orders denominated directly in Turkish Lira (TRY). By bridging local payment rails with Soroswap AMM liquidity via SEP standards, TriggerVault allows users to deposit Lira via bank transfer, lock in automated exit conditions, and withdraw proceeds straight back to their IBAN.

---

## Architecture
```mermaid
flowchart TD
    U["Turkish User<br/>Denominated in TRY"]

    subgraph FE["TriggerVault DApp (React + Freighter)"]
        A1["anchor/toml.ts<br/>SEP-1 Discovery"]
        A2["anchor/sep10.ts<br/>Freighter WebAuth → JWT"]
        A3["anchor/sep6.ts<br/>Deposit / Withdraw Rails"]
        A4["anchor/sep38.ts<br/>Real-Time TRY Quotes"]
        A5["anchor/trustline.ts<br/>Classic changeTrust"]
        UI["FX Ramp & Limit Order Interface"]
    end

    subgraph AN["TR Anchor (SEP-1/6/10/12/38)"]
        BANK["Bank Transfer Simulator (FAST / EFT)"]
        TRZ["Anchor Treasury"]
    end

    subgraph SN["Stellar Network (Testnet)"]
        USDC["USDC (Circle Testnet Issuer)"]
        SAC["USDC Stellar Asset Contract"]
        V["TriggerVault Contract"]
        DEX["Soroswap Router"]
    end

    K["Autonomous Keeper Bot"]

    U -->|"1. Deposit TRY"| BANK
    BANK -->|"2. Mint testnet USDC"| USDC
    U --> UI
    UI --> A1 & A2 & A3 & A4 & A5
    A3 -->|"Interactive / Poll"| AN
    USDC -->|"3. SAC Wrap"| SAC
    SAC -->|"4. create_order(USDC)"| V
    K -->|"5. Trigger on target price"| V
    V <-->|"6. Atomic swap with balance delta"| DEX
    V -->|"7. Transfer net proceeds"| USDC
    USDC -->|"8. Payment with Memo.id"| TRZ
    TRZ -->|"9. Payout TRY to IBAN"| U
```
