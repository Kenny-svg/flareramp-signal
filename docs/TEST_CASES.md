# FlareRamp feature test cases

Use this checklist for live demo / QA on **XRPL Testnet** + **Coston2**.  
Repo: https://github.com/Kenny-svg/flareramp-signal

## Shared setup (before any case)

| Item | What to use |
|------|-------------|
| XRPL source | Your Testnet `r…` address (Xaman, Testnet network) |
| TestXRP | [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) — keep ≥ 5–10 TestXRP for several runs |
| Coston2 receive (EOA) | Your MetaMask / EOA `0x…` on Coston2 (case 1) |
| Executor gas | Operator `0x3F3FFB6071aE872d7df12a6e3f94d8E082504af9` funded with **C2FLR** ([faucet](https://faucet.flare.network/coston2)) |
| Executor health | `https://flareramp-signal.onrender.com/ready` → `storeReady` + `watcherConnected` |
| Web | Your Vercel URL (or `http://localhost:3000`) |
| XRPL explorer | https://testnet.xrpl.org |
| Coston2 explorer | https://coston2-explorer.flare.network |

**Payment destination (auto-filled by Check — do not invent):**

- Wallet mint → protocol **Core Vault** XRPL address (shown in readiness)
- Smart Account redeem / vault exit → **operator** XRPL wallet from `MasterAccountController` (shown in SA review)

**Registered vaults (Coston2):**

| Protocol | Vault contract | Vault id (MAC) |
|----------|----------------|----------------|
| Firelight | `0xC90D6847747b85d1fa2E07859869fb9fB72c0361` | 1 |
| Upshift | `0x9E63a5D282F2fBb7DcE822B98e363b2719D28319` | 2 |

TVL numbers on the chooser are **live** — they will not match this doc exactly.

---

## Case 1 — Bridge to your wallet

**Goal:** Mint FXRP to your Coston2 EOA.

| Field | Value |
|-------|--------|
| Tab | XRPL Testnet → Coston2 FXRP |
| Destination | **Wallet** (“Bridge to your wallet”) |
| XRPL source | Your `r…` |
| Coston2 recipient | Your `0x…` EOA |
| Amount | `1` TestXRP (or lot-friendly amount shown by Check) |

**Steps:** Check → Sign in Xaman → Prove → Mint.

**Verify:**

1. XRPL tx on https://testnet.xrpl.org (payment to Core Vault, memo matches Check)
2. Stage ends at `minted`
3. Coston2 settlement hash on explorer
4. FXRP balance of recipient EOA increased (Portfolio tab or explorer token balance)
5. Open **Proof Receipt** `/receipt/<xrplTxId>`

---

## Case 2 — Bridge and deposit to Firelight

**Goal:** Mint into Personal Account and deposit to Firelight.

| Field | Value |
|-------|--------|
| Destination | **Firelight** (“Bridge and deposit to Firelight”) |
| XRPL source | Your `r…` (must resolve a Personal Account) |
| Amount | `1` TestXRP |
| Optional share receiver | Leave default (Personal Account) unless testing redirect |

**Steps:** Open vault details modal (TVL) → Check → Sign → Prove → Mint (`executeDirectMintingWithData` / `0xFE`).

**Verify:**

1. Proof Receipt shows vault deposit / PA path
2. Firelight vault `0xC90D6847…0361` — your **Personal Account** holds vault shares (ERC-20 balanceOf PA on vault contract)
3. Liquid FXRP on PA may be ~0 after deposit; shares > 0
4. Vaults tab → position lookup for PA address (if UI supports it)

---

## Case 3 — Bridge and deposit to Upshift

**Goal:** Mint into Personal Account and deposit to Upshift.

| Field | Value |
|-------|--------|
| Destination | **Upshift** |
| XRPL source | Your `r…` |
| Amount | `1` TestXRP |
| Vault | `0x9E63a5D2…8319` |

**Steps / verify:** Same pattern as case 2, against the Upshift vault address.

---

## Case 4 — Failure: Check blocks bad input

| Action | Expected |
|--------|----------|
| Empty / invalid XRPL source | Check fails; Sign disabled |
| Amount below protocol minimum | Fail/warn on readiness |
| Reject / expire Xaman request | Terminal sign stage; **no** second XRPL payment |

---

## Case 5 — Recorded replay (outage path)

| Field | Value |
|-------|--------|
| URL | `/demo/replay` |
| Env | `DEMO_REPLAY_ENABLED=true` |

**Verify:** Banner **Recorded demo — not a live mint**; explorer links open; no Xaman / no new chain txs.

---

## Case 6 — XRPL-native redeem (zero-FLR)

**Precondition:** Personal Account holds enough FXRP (from case 1 mint-to-PA, or transfer). Lot size must divide amount.

| Field | Value |
|-------|--------|
| Tab | Coston2 FXRP → XRPL → **XRPL / Xaman (zero-FLR)** |
| Action | Redeem FXRP → XRP |
| XRPL source | Same `r…` that owns the PA |
| Amount | Exact lots (e.g. lot size from Check / review) |
| Destination | Operator wallet (auto) — **no destination tag** |
| Fee | Live instruction fee in drops (review panel) |

**Verify:** Stages → `instruction_executed`; PA FXRP decreases; XRP returns on XRPL to source (per FAssets redeem rules); Proof Receipt for instruction.

---

## Case 7 — Firelight withdraw request (0x12)

**Precondition:** PA has Firelight vault shares (case 2).

| Field | Value |
|-------|--------|
| Action | Firelight withdraw request |
| Amount | Whole FXRP units to exit (e.g. `1`) |
| Fee payment | Operator XRPL + instruction memo |

**Verify:** `instruction_executed`; shares decrease / withdraw pending on vault; **do not** claim yet.

---

## Case 8 — Firelight claim (0x13)

**Precondition:** Case 7 done **and** Firelight period ended.

| Field | Value |
|-------|--------|
| Action | Firelight claim withdrawal |
| Input | **Period id** (not FXRP amount) — use Check’s “claimable period(s)” hint |
| Wrong input | FXRP amount as period → `NoWithdrawalAmount` |

**Verify:** FXRP returns to Personal Account; period marked claimed.

---

## Case 9 — Upshift withdraw request (0x22)

Same as case 7 against Upshift; amount in whole FXRP.

---

## Case 10 — Upshift claim (0x23)

| Field | Value |
|-------|--------|
| Action | Upshift claim withdrawal |
| Input | Claim date **YYYYMMDD** from when redeem was requested |

**Verify:** After lag elapsed; FXRP back on PA.

---

## Case 11 — MetaMask redeem (EOA, needs C2FLR)

**Precondition:** FXRP in an EOA (case 1), MetaMask on Coston2, C2FLR for gas.

| Field | Value |
|-------|--------|
| Tab | Coston2 FXRP → XRPL → **MetaMask** |
| Amount | Any positive FXRP your wallet can cover |
| XRPL destination | Your `r…` (and destination tag only if `redeemWithTag` path) |

**Verify:** On-chain redeem tx; agent risk panel may show queue health; XRP arrives on XRPL after agent fulfillment (can take time).

---

## Case 12 — Cross-chain FXRP portfolio

| Field | Value |
|-------|--------|
| Tab | Cross-chain FXRP |
| Address | Your Coston2 `0x…` |

**Verify:** Coston2 row shows FXRP after case 1; total updates; no crash on empty chains.

---

## Case 13 — Vaults / liquidity map

| Field | Value |
|-------|--------|
| Tab | Vaults |
| Expect | Firelight + Upshift nodes with live TVL |

**Verify:** Details modal; optional position lookup for PA after case 2/3.

---

## Quick “where do I look?” map

| Question | Where |
|----------|--------|
| What XRPL address do I pay? | Check / SA review — Core Vault or operator (never guess) |
| What Coston2 address receives FXRP? | Case 1: your EOA; Cases 2–3: Personal Account then vault shares |
| How do I find my Personal Account? | SA review / mint review after Check (`getPersonalAccount(xrpl)`) |
| Did mint finish? | UI stage `minted` + Proof Receipt + Coston2 tx |
| Did vault deposit work? | Vault token `balanceOf(personalAccount)` on Firelight/Upshift contract |
| Did redeem/instruction finish? | Stage `instruction_executed` + receipt |
| Executor alive? | `GET /ready` on Render |

## Suggested demo order (time-boxed)

1. Case 1 (wallet mint) — full Check→Sign→Prove→Mint  
2. Case 2 **or** 3 (one vault) — show TVL modal  
3. Case 6 (SA redeem) **or** Case 11 (MetaMask) if PA empty  
4. Case 5 (replay) — 20 seconds  

Skip full Firelight claim in a 5-minute video unless a period is already claimable.
