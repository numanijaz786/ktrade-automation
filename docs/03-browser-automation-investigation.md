# 03 — KTrade Web Portal Browser-Automation Investigation

_Date: 2026-11-13 · Scope: personal, single-user automation of the owner's own KTrade account · Method: public pages and KTrade's published legal documents only (no login, no inspection of authenticated endpoints)._

## 1. Verdict

| Question | Answer | Evidence level |
|---|---|---|
| Does KTrade **explicitly permit** automated browser interaction? | **No.** No published policy permits it. | Verified: no terms-of-use, API or automation policy exists on the portal or the download page, or in any of the 7 published agreement documents. |
| Does KTrade **explicitly prohibit** it? | Not in those words. Credential clauses are strict, though (see §3). | Verified (published docs) |
| Is it technically possible? | Probably, for read-only screens with a human completing the second factor. **Not verified.** Verifying requires logging in, and the authorization gate below was not met. | Partially verified (public sign-in page only) |
| **Decision** | **`KTradeBrowserAdapter` stays DISABLED.** It is designed and documented here but **not implemented** until KTrade gives written permission (§6). The fallback (§7) ships instead. | Per your rule: "If KTrade explicitly permits browser automation…" |

## 2. What was observed (public, unauthenticated)

| Item | Finding | Source |
|---|---|---|
| Platforms | Web Portal `https://apps.ktrade.pk/webterminalv3/SignIn`, a second web terminal `http://ktradeweb.ktradepk.com/` (v1.1.3), a Windows desktop terminal (`kasb.com/terminal/desktop.zip`), Android/iOS apps (two app IDs each, so the download page is inconsistent), and a Research Portal | [kasb.com/download](https://www.kasb.com/download/) |
| Platform vendor | Not stated. The Android package `com.softech.trading` *suggests* a white-labelled third-party broker terminal. This is an inference. | Play Store link on the download page |
| Login workflow | A "Sign In" page with an **"Authentication 2"** step offering **"Continue"** and **"Generate?"**, which points to a second factor (OTP or generated PIN). The fields render client-side and were not visible without JS. | Public sign-in page |
| CAPTCHA | None visible on the static page. It may appear dynamically (not verified). | Public sign-in page |
| Persistent sessions / "remember me" | None visible. Session lifetime is **not verifiable without logging in**. | Public sign-in page |
| Terms of use / automation notice on the portal | **None.** There is no ToS link on the portal or the download page. | Public pages |
| `robots.txt` | 404 on `apps.ktrade.pk`, redirect on `ktradeweb`. A missing robots.txt **does not grant permission**, and it does not govern authenticated use anyway. | Direct request |
| Holdings, cash, order history, buy/sell, cancel, order status | Marketing says "Track Portfolio 24/7" and "Real Stocks Trading". The exact screens, fields and order types are **not verifiable without login**. | [kasb.com/invest-in-stocks](https://kasb.com/invest-in-stocks/) |
| Order types | The Risk Disclosure Document mentions "Limit Orders, Stop Loss Orders, and Market Orders" in general terms (§1.6) and tells customers to ask their broker for details. Which of these the KTrade terminal supports is **unconfirmed**. | Risk Disclosure Document |

## 3. Contractual analysis (KTrade's published documents)

Documents reviewed (text extracted locally from the PDFs linked at [kasb.com/service-agreement…](https://kasb.com/service-agreement-pakistanandcounting/)): Online Trading Terminal Agreement, Terms & Conditions (two documents), Risk Disclosure Document, Commission Structure, and Customer Awareness Notification.

**Relevant clauses (quoted):**

1. **Online Trading Terminal Agreement, T&C §2:** credentials are issued **by PSX** ("KTrade Securities Ltd will request PSX to generate username, password, and PIN…"). *"The Account Holder(s) shall not disclose the password/PIN to any person and shall take every reasonable precaution to prevent discovery of the password/PIN by any other person."*
2. **Same, §3:** *"All risks connected and involved with Electronic/Online Trading will be assumed fully [by] the Account Holder(s)… including those due [to] misuse [of] the Account Holder(s) Password or PIN, hacking of lines…"*
3. **Same, preamble:** *"All trades originated from this online internet trading terminal will be solely my/our responsibility to settle."*
4. **Customer Awareness Notification §3:** *"please do not share your ID, password, PIN, or any other login or account credentials with anyone, including your designated trader."*
5. **Risk Disclosure §1.10:** the customer *"shall be solely responsible for any consequences arising from disclosure of the access codes and/or passwords to any third person or any unauthorized use…"*
6. **T&C §4 (non-terminal orders):** outside the terminal, the broker acts on instructions only through recorded phone lines, authorized email/SMS/fax/letter, or in person.

**Interpretation (engineering view, not legal advice):**
- **Nothing grants permission** for scripted, automated or programmatic use of the terminal. Under your own rule ("only if KTrade explicitly permits"), that alone settles it.
- A self-hosted tool that **you** run, on **your** machine, with credentials **you** hold arguably does not "disclose" them to another person. It does, however, **store PSX-issued credentials in software**, which sits uneasily with "take every reasonable precaution to prevent discovery". Any compromise of that machine or database becomes a full brokerage compromise, and **all risk and liability falls on you** (§3).
- **Unknown regulatory layer:** PSX and SECP rules on automated or algorithmic order entry by retail clients through broker terminals were **not verified** here. This needs written confirmation from KTrade's compliance team, not an assumption.
- **Technical risk even with permission:** the terminal is a third-party web app shown as "v1.1.3" with a "new version available" banner, so it changes often. A DOM-driven bot can misread a field (for example price vs. quantity) or a status. With real money, a silent misread is the failure that matters.

## 4. Authorized alternatives identified (usable today)

| Source | What it provides | Why it's authorized |
|---|---|---|
| **Electronic Contract Notes** (email) | Every executed trade: symbol, qty, rate, commission and charges. Must arrive **by the start of the next trading day**. | T&C §5(e): KTrade *must* send them; it's your data in your mailbox |
| KTrade statements (ledger/holdings), exported or emailed | Cash ledger, holdings, fees | Your own records |
| **CDC Access / Asaan Connect** (CDC) | Independent custody record of holdings and movements | Official CDC investor portal, linked from KTrade's site |
| **NCCPL UIS + CDC/NCCPL SMS/e-alerts** | Per-trade and per-movement alerts, CGT statements | Risk Disclosure §3.1 explicitly recommends them |
| Commission Structure (published) | **0.3% or Rs 0.06/share, whichever is higher**; SST 15% on brokerage; CDC/NCCPL/CGT charges "as per actual"; Rs 50/month SMS | Seeds the default fee schedule (still effective-dated and editable) |

The contract-note email is the most valuable of these. It gives **broker-confirmed fills within one day** without touching the terminal. The import pipeline will parse contract notes from uploaded `.eml`/PDF files first. Optionally it can read them from **your own mailbox** through an OAuth read-only scope you grant (Gmail/Outlook), filtered to KTrade's sender address.

## 5. Designed (not implemented) `KTradeBrowserAdapter` architecture

This is kept so that it can be built quickly **if** written permission arrives. The design assumes permission explicitly covers the listed capabilities.

```
apps/browser-agent/   (separate local-only process; never in the API container)
├── Playwright (TypeScript), Chromium, headed by default
├── Runs on 127.0.0.1 only; talks to the API via an mTLS/Unix-socket channel
├── Persistent context in an encrypted, OS-user-only profile dir
└── Page objects per screen, each with schema validation of what it reads
```

| Concern | Design |
|---|---|
| Login | **User-initiated, user-completed.** The agent opens a **headed** browser on the sign-in page, and you type your credentials and complete "Authentication 2" (OTP) **yourself**. The agent never types the password or OTP, so no PSX credential is ever stored. This also removes most of the §3 credential concern. |
| Session | The agent reuses the authenticated context while it is valid. On expiry it **pauses**, sends a notification ("KTrade session expired. Click to re-authenticate.") and never tries a silent re-login. |
| CAPTCHA / OTP / device checks / anti-bot | Never automated or bypassed. If one is detected, the agent pauses and asks you to complete it. |
| Reads (balance, cash, holdings, orders, executions) | Page-object scrapers with Zod validation. Parsed values are cross-checked against invariants (e.g. Σ holdings value ≈ shown portfolio value). Any mismatch means the data is discarded and an alert is raised. Labelled `BROKER_DISPLAYED`, and promoted to `BROKER_CONFIRMED` only when reconciled with a contract note or statement. |
| Order preparation | The agent **fills the order form and stops before Submit**. You review it in the real KTrade UI and click Submit yourself. Auto-submit is a separate flag, off by default, and only allowed if permission explicitly covers it. |
| Order verification | A click is never treated as acceptance. Status comes from the terminal's order book **and** is finally confirmed by the contract note. |
| Cancel | Same pattern: the agent navigates to the order and you confirm. |
| Pacing | Human-like rate limits (≥ several seconds between page loads), market hours only, and no polling faster than a person would refresh. |
| Debugging | On failure it takes a screenshot and DOM snapshot, **with account numbers, balances and names redacted**, stored encrypted locally with 7-day retention. |
| Recovery | Bounded retries for navigation only. **Order actions are never retried automatically.** Any ambiguous state → the order is marked `UNKNOWN` and you are told to check the KTrade app. |
| Disconnect | One click closes the browser and wipes the profile directory (cookies, local storage) and the encryption key for that profile. |

## 6. What it would take to enable the adapter

1. **Written confirmation from KTrade compliance** (email is fine), specifically covering:
   a. read-only automated viewing of your own account through the web portal;
   b. automated order *preparation* with manual submission;
   c. (optional) automated submission;
   d. whether PSX or SECP rules require any approval or registration for (b) or (c).
2. Then a supervised **technical verification session**: you log in and the agent maps screens read-only, and each capability is marked verified in the adapter's capability manifest.
3. Your approval of each capability individually.

A draft request you can send (from your registered email to KTrade support or compliance, e.g. `info@kasb.com`):

> Subject: Request for permission — personal automation of my own KTrade web-terminal account (Client Code: ______)
>
> I'm building a personal, self-hosted portfolio tool used only by me. I'd like written confirmation of whether KTrade permits the following on my own account via the official web portal (apps.ktrade.pk/webterminalv3), with me completing login and OTP myself each session and no credential sharing:
> 1. Automated read-only viewing of holdings, cash balance, order book and trade history.
> 2. Automated preparation of buy/sell orders, which I then review and submit manually.
> 3. Automated submission of orders that I have pre-approved.
>
> Please also confirm whether PSX/SECP rules require any approval for (2) or (3), and whether KTrade offers an API or data export (e.g. CSV of ledger/holdings) as an alternative.

## 7. Fallback (what gets built now)

- `KTradeBrowserAdapter`: registered with **every capability `false`**. The UI shows "Disabled — awaiting written authorization from KTrade" with a link to this document.
- **Imports:** electronic contract notes (PDF/.eml), statements in CSV/XLSX/PDF, CDC holdings, and manual entry, each with a review screen before commit.
- **Assisted manual trading:** the app produces a fully risk-checked order ticket. You place it in the KTrade app and record "placed" and the fill. The trade is reconciled automatically when its contract note is imported.
- Everything else (portfolio, analytics, alerts, strategies, backtesting, paper trading, AI assistant) works fully on imported and manual data.
