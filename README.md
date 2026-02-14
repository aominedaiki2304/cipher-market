# CipherMarket

Private prediction markets that only work *cleanly* with BITE v2 **Conditional Transactions (CTX)**:

- Traders submit **encrypted limit orders** on-chain (their side + max spend + limit price stay private).
- After the market closes, a **conditioned CTX** decrypts the batch and the contract **clears the sealed orderbook** (single clearing price + fills/refunds).
- The attestor commits an **encrypted outcome**, then a second **conditioned CTX** reveals it and enables settlement.
- Every step emits **on-chain receipts** with **reason codes**, plus local **trace logs** you can hand to judges.

This is built for the “private + conditional” bounty track: it’s not just “hide calldata in the mempool”, it’s a workflow change (sealed clearing + sealed resolution) that public execution cannot do well.

## Chain Target

This repo is configured for **SKALE BITE v2 Sandbox**:

- `RPC_URL=https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox`
- `CHAIN_ID=103698795`
- Test USDC (6 decimals): `0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8`

## What’s Private (UX Copy)

- What is private?
  - Each order’s **side (YES/NO)**, **max spend**, and **limit price** are BITE-encrypted and stored as ciphertext on-chain.
  - The **market outcome** can be committed encrypted and revealed later.
- When does it unlock?
  - Orders unlock **only after `closeTime`** and **only** through an **attested CTX** that triggers the contract’s `onDecrypt`.
  - Outcome unlocks **only after** an encrypted commitment exists and a second **attested CTX** reveals it.
- Who can trigger?
  - Any caller can trigger CTX steps, but **must supply a valid attestor signature** and the contract must be in the correct state.
- What happens on failure?
  - Invalid triggers revert; invalid decrypted orders are **refunded** and logged with **failure receipts** + reason codes (e.g. `COMMITMENT_MISMATCH`, `LIMIT_NOT_MET`, `UNMATCHED`).

## End-to-End Lifecycle (What Judges Can Verify)

**1) Market policy**

Relayer (or any operator) creates markets with on-chain caps:

- `orderDepositUnit` (fixed escrow per order)
- `maxStakePerOrder` (bounds hidden max spend)
- `maxTotalStake` (market cap)
- optional `allowlistEnabled + allowlist[]`
- `attestor`, `approver`, `disputeWindowSeconds`

Contract: `contracts/src/PrivatePredictionMarket.sol`

**2) Encrypted intent**

Trader submits:

- ciphertext `encryptedPayload` (BITE v2)
- commitment `commitmentHash = keccak256(plaintextPayload)` (public, for integrity)
- public escrow: contract pulls `orderDepositUnit` USDC via `transferFrom`

Contract call: `submitEncryptedOrder(marketId, encryptedPayload, commitmentHash)`

**3) Condition check + CTX batch decrypt**

After `closeTime`, someone triggers the batch with an **attestor-signed** payload:

- includes `ordersRoot` (digest of orderIds + commitmentHashes + trader addresses)
- includes `expiry`

Contract call: `triggerBatchDecrypt(marketId, orderIds[], payload, attestationSignature)`  
Contract action: calls CTX precompile `submitCTX(...)` and stores the returned `ctxSender`

**4) Decrypt + execute (sealed clearing)**

Network calls back:

- `onDecrypt(decryptedArgs, plaintextArgs)`
- contract enforces `msg.sender == ctxSender`

In `onDecrypt`, the contract:

- verifies each decrypted order matches its commitment and envelope trader
- selects a **single clearing price** for YES (in bps) that maximizes matched lots
- fills / partially fills / refunds orders based on limit prices
- updates positions and refundable amounts
- emits `ReceiptRecorded` for every order and the batch summary

**5) Confidential resolution**

Attestor commits the outcome encrypted:

- `commitEncryptedOutcome(marketId, encryptedOutcome, commitmentHash)`

Then anyone can trigger the outcome CTX reveal with an **attestor-signed** payload:

- `triggerOutcomeDecrypt(marketId, expiry, signature)`
- `onDecrypt(...)` reveals `{ outcome, evidenceHash }`

**6) Dispute + finalize**

- Anyone can `openDispute(marketId, reasonHash)` during the dispute window.
- Approver can override: `overrideResolution(marketId, finalOutcome, reasonHash)`
- Otherwise finalize after deadline: `finalizeResolution(marketId)`

**7) Claim**

Traders claim from the UI:

- winners: refundable + winning lots payout
- losers: refundable only (and `INVALID` refunds executed cost)

Contract: `claimPayout(marketId)`

## Why CTX Is Doing “The Interesting Thing” Here

CTX enables a *sealed orderbook* and a *sealed oracle outcome*:

- Traders can submit limit orders without broadcasting their intent pre-close.
- The market can clear in one shot only when the condition is met.
- The attestor can commit an outcome early without leaking it, then reveal it only when allowed.

Public execution can’t do this without leaking order flow/outcome or adding manual reveal phases.

## Guardrails (Non-Negotiable for the Bounty)

On-chain guardrails:

- Spend caps: `orderDepositUnit`, `maxStakePerOrder`, `maxTotalStake`
- Optional allowlist (`allowlistEnabled`)
- Attestor-signed batch trigger + expiry
- Attestor-signed outcome reveal + expiry
- Dispute window + human approver override

Operational guardrails:

- Background relayer only submits CTX after `closeTime`
- Traders claim themselves (no custodial withdrawals)

## Receipts, Logs, and Evidence

**On-chain receipts**

Every meaningful action emits `ReceiptRecorded(...)` and stores a `Receipt` struct retrievable via `getReceipt(receiptId)`.  
Fields include: `status`, `reasonCode`, `conditionPassed`, `executed`, `side`, `amount`, `evidenceHash`, `timestamp`.

**Local traces**

The API appends a JSONL trace at:

- `artifacts/traces/full-flow.jsonl`
- plus summaries like `artifacts/traces/five-trader-edge-tests.json`

**Sample JSON receipts (normalized for demos)**

- `artifacts/receipts/*.json`

## Repository Layout

- `contracts/src/PrivatePredictionMarket.sol` (CTX supplicant, sealed clearing, receipts)
- `contracts/src/libraries/BitePrecompile.sol` (calls `0x...001B` submitCTX precompile)
- `apps/api` (encryption, attestation signing, background relayer, trace logs)
- `frontend` (ConnectKit wallet UX, markets, market detail, receipts, portfolio/claim)
- `scripts/*` (deploy, edge tests, funding utilities)
- `artifacts/*` (deployment info, receipts JSON, traces)

## Deployed Contract (This Workspace)

The latest deployment produced by `npm run deploy:contract` is stored at:

- `artifacts/deployment/private-prediction-market.json`

Current address (from that file):

- `0x4f6c396a26ebe815c5a0f310f8faf13f45bc39ee`

## Quickstart (Clean Install)

Prereqs:

- Node.js 18+ (npm)
- A wallet with sFUEL on the SKALE BITE sandbox

Install + run (single line):

```bash
npm install && npm install --prefix frontend && npm run dev
```

Services:

- Frontend: `http://localhost:8080`
- API + Relayer: `http://localhost:8787`

## Configure Environment

Copy `.env.example` to `.env` and fill:

- `RPC_URL`, `CHAIN_ID`, `USDC_ADDRESS`
- `DEPLOYER_PRIVATE_KEY` (pays relayer txs and CTX gas)
- `ATTESTOR_PRIVATE_KEY` (signs batch/outcome attestations; also commits encrypted outcome)

Optional:

- `RELAYER_ENABLED=1` (default)
- `RELAYER_MARKET_CREATION_ENABLED=1` (default)

## Deploy (Optional)

If you want to redeploy the contract:

```bash
npm run deploy:doctor
npm run deploy:contract
```

Deployment info is written to:

- `artifacts/deployment/private-prediction-market.json`

## Demo Mode (3-Min Markets)

To make markets cycle quickly for a live demo, set in `.env`:

```bash
RELAYER_MARKET_DURATION_SECONDS=180
RELAYER_MARKET_DISPUTE_WINDOW_SECONDS=15
RELAYER_TARGET_OPEN_MARKETS=5
```

Then restart `npm run dev`. The relayer will keep 3–5 open markets available.

## 3-Minute Demo Script (Single Take)

1. Open `http://localhost:8080` and connect your wallet (ConnectKit).
2. Click into an OPEN market.
3. Place a YES order (encrypted). Place a NO order from a second wallet (encrypted).
4. Say: “Order side + max spend + limit are encrypted and stored on-chain. Nothing can execute until the close condition is met.”
5. Wait for close (3 minutes). Keep the page open.
6. Say: “The background relayer submits an attested CTX. The contract decrypts and clears the sealed orderbook in `onDecrypt`.”
7. Scroll to **Receipts** on the market page:
   - open a success receipt (filled / partial fill)
   - open a failure receipt (e.g. `UNMATCHED` or `LIMIT_NOT_MET`)
8. Go to **Portfolio** (click your wallet in the header).
9. After resolution finalizes, show the **Claim** action:
   - winners: “Claim Winnings”
   - refunds/losers: “Withdraw” (if refundable > 0)
10. Close: “This is private + conditional execution with an auditable trail. The market was blind until CTX unlocked it.”

## Tests (Edge Cases Across 5 Traders)

This script funds/approves traders A–E (if needed), then runs two scenarios:

```bash
node scripts/run-five-trader-edge-tests.mjs
```

Outputs:

- `artifacts/traces/five-trader-edge-tests.json`

## Troubleshooting

- Orders failing instantly: you likely need USDC allowance for the market contract (approve in UI once).
- Deploy failing with “eth_sendRawTransaction is not supported”: your RPC doesn’t support broadcasting signed raw txs. Use the sandbox RPC above.
- CTX not completing: reduce batch size (demo relayer keeps batches small) and ensure relayer has enough sFUEL for CTX gas payment.
