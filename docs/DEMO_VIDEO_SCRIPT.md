# FlareRamp — investor pitch + on-screen features (≈5 min Loom)

Read the **SAY** column. Click whatever is in **SHOW**. One browser window, Loom screen capture.

**Prep (off camera):** executor ready, Xaman unlocked (Testnet), mint form filled (source `r…`, recipient `0x…`, amount `1`), destination = Wallet.

---

## 0:00 — Hook

| SAY | SHOW |
|-----|------|
| Most bridges ask you to trust an operator with your XRP and hope it shows up. FlareRamp doesn’t. You pay the official Core Vault. Flare’s Data Connector proves it. We mint FXRP on Coston2. We never take your seed. | Home / mint hero. Slow pan across **Check → Sign → Prove → Mint** stepper. |

---

## 0:25 — Problem → product

| SAY | SHOW |
|-----|------|
| Direct mint is easy to break: wrong vault, stale price, bad memo, double-pay while FDC is still voting. We turn it into one path: Check, Sign, Prove, Mint. | Stay on mint tab. Hover or click each of the four steps so they light up / come into view. |

---

## 0:45 — Feature: live Check

| SAY | SHOW |
|-----|------|
| Before Xaman, we pull live protocol data — Core Vault, exact fees, fresh FTSO price, and the memo. If Check fails, Sign stays locked. | Destination **Wallet** selected. Hit **Check**. Scroll the readiness list (pass/warn). Point cursor at vault address, fee line, FTSO timestamp, memo hex. |

---

## 1:10 — Feature: Xaman Sign

| SAY | SHOW |
|-----|------|
| You sign only in Xaman. Confirm destination, amount, and memo yourself. | Click **Open in Xaman** / show QR. Phone in frame if possible. Approve (~35s). Soft line: “Approving the verified payment…” then silence. |

---

## 1:50 — Feature: Prove (FDC)

| SAY | SHOW |
|-----|------|
| Payment’s on XRPL. Now FDC attests it — usually one to three minutes. Don’t resend. The executor checkpoints every stage so a refresh doesn’t lose the mint. | Prove panel: stages moving (`confirming` → `attestation_requested` → …). Cursor on stage label. **Pause Loom** if wait > ~45s; resume when near mint. |

---

## 2:40 — Feature: Mint + Proof Receipt

| SAY | SHOW |
|-----|------|
| FXRP is on Coston2. Here’s a shareable Proof Receipt — XRPL hash, Coston2 settlement, public explorers. Auditable, not a dashboard screenshot. | Stage **minted**. Click **Proof Receipt**. Scroll receipt. Open XRPL explorer tab, then Coston2 tx tab (2–3s each). |

---

## 3:05 — Feature: vault destinations

| SAY | SHOW |
|-----|------|
| Same ramp, two outcomes. Wallet delivery — or mint-and-deposit into Firelight or Upshift via Smart Accounts, with live vault TVL before you commit. | **Start over**. Open destination chooser. Select **Firelight** (or Upshift). Open **vault details / TVL** modal. Hit **Check** so vault path + Personal Account show. *(Full second Sign only if ahead of time.)* |

---

## 3:50 — Feature: zero-FLR redeem

| SAY | SHOW |
|-----|------|
| Coming back doesn’t require Flare gas for the user. Redeem tab: XRPL payment to the operator, instruction memo, FDC Payment proof, executeInstruction — still no seed. | Switch to **Coston2 FXRP → XRPL**. Keep **XRPL / Xaman**. Action **Redeem**. Enter source, amount. **Check instruction** — point at live fee + memo + Personal Account. Sign if time; else stop on the quote. |

---

## 4:30 — Positioning (no click-spam)

| SAY | SHOW |
|-----|------|
| We’re not picking mint agents. Not a public executor market. Not one-click yield theater. We’re the safety layer between an irreversible XRPL payment and a verifiable FXRP mint on Flare. | Hold on redeem quote **or** bounce back to Proof Receipt. Slow, steady frame. |

---

## 4:45 — Close

| SAY | SHOW |
|-----|------|
| FlareRamp: Check, Sign, Prove, Mint — XRP to FXRP with FDC-backed evidence. Repo flareramp-signal — payment and settlement links in the description. | Receipt or home. End record. |

---

## Feature checklist (must appear on camera)

- [ ] Check → Sign → Prove → Mint stepper  
- [ ] Live Check results (vault / fees / FTSO / memo)  
- [ ] Xaman QR or deep link + approve  
- [ ] Prove stage progress  
- [ ] Minted + Proof Receipt + explorers  
- [ ] Firelight or Upshift destination + TVL  
- [ ] Redeem tab with live instruction fee  

---

## Loom description

```
FlareRamp — XRPL Testnet → Coston2 FXRP (investor demo)

Check → Sign (Xaman) → Prove (FDC) → Mint
Vault destinations (Firelight / Upshift) · XRPL-native redeem

Repo: https://github.com/Kenny-svg/flareramp-signal
XRPL: <paste>
Coston2: <paste>
Receipt: <paste>
```
