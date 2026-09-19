# TriggerVault: Non-Custodial Slippage-Bounded Trigger Orders on Soroban

TriggerVault is a decentralized, non-custodial automated execution protocol on Stellar Soroban (SDK v22). It enables automated Limit and Stop-Loss orders directly on Stellar Layer 1 without custody risks, enforced by slippage bounds and executed via an open keeper incentive mechanism.

## Architecture Overview
- contracts/vault: Rust smart contract (no_std, Soroban SDK v22.0.0).
- keeper: Automated off-chain TypeScript monitoring bot.
- frontend: Modern dark-theme React dashboard built with Vite and Tailwind CSS.
- docs: Complete technical specifications, architectural diagrams, and pitch defense materials.

## License
MIT License. Built for the Stellar Soroban Hackathon.
