# User Action Required

Only things that genuinely need **you**: permissions, accounts, payments, physical verification, or facts only you have. Everything else proceeds without you. Each item is listed once; it's updated as its status changes.

_Last updated: 2026-11-14_

| #   | Item                                                            | Blocks                                | Cost                   | Status                            |
| --- | --------------------------------------------------------------- | ------------------------------------- | ---------------------- | --------------------------------- |
| 1   | Written automation permission from KTrade                       | Automated reads/orders via KTrade     | none                   | ⏳ open                           |
| 2   | Redacted KTrade contract note, ledger and CDC statement samples | KTrade-format imports, reconciliation | none                   | ⏳ open                           |
| 3   | Market-data vendor decision                                     | Real/delayed PSX prices               | paid (vendor quote)    | ⏳ open                           |
| 4   | Confirmed tax rates (CGT, dividend WHT) and your filer status   | Tax estimates                         | none                   | ⏳ open                           |
| 5   | Hosting / domain for the single secure URL                      | Production deployment                 | paid (VPS ~US$6–12/mo) | ⏳ open                           |
| 6   | Email/Telegram setup for notifications                          | Email/Telegram alerts                 | none                   | ⏳ later (when the feature lands) |
| 7   | LLM API key and data-sharing opt-in                             | AI assistant / research write-ups     | usage-based            | ⏳ later (when the feature lands) |

---

### 1. KTrade written automation permission

- **Why:** KTrade publishes no API, and its terms don't permit automated access (docs/01, docs/03). Without written permission, automation would breach your account agreement.
- **Blocked:** automatic sync of holdings and cash, order placement through KTrade.
- **Works without it:** everything else. That includes CSV imports, the manual-ticket order workflow (the app prepares and validates, you place the order in the KTrade app), paper trading and analytics.
- **Steps:** send the request drafted in `docs/03-browser-automation-investigation.md` §6 from your registered email to KTrade support or compliance, and forward the written reply. Each capability stays disabled until its permission reference is recorded.

### 2. Statement samples

- **Why:** parsers must be built and tested against the real formats. Guessing a format risks posting wrong numbers.
- **Blocked:** importing KTrade contract notes, ledgers and CDC statements directly, and automatic reconciliation (estimate → broker-confirmed).
- **Works without it:** generic CSV import (any spreadsheet with date, symbol, side, quantity, price).
- **Steps:** export one of each document, black out your name, CNIC, account number and address, and put the files in a local folder you tell me about. Don't paste them into chat.

### 3. Market-data vendor

- **Why:** PSX has no free official API, and scraping is excluded.
- **Options found:**
  - **Capital Stake**, which describes itself as an authorized PSX feed vendor (REST + WebSocket, quotes, intraday, EOD, corporate actions; pricing not public).
  - **PSX's own EOD product** with Deutsche Börse (subscription).
- **Recommendation:** ask Capital Stake for a personal/retail quote first. It's the only one found offering intraday plus corporate actions through an API.
- **Works without it:** simulated prices (clearly labelled), and importing EOD prices you're licensed to use (`POST /market/prices/import`), which then take priority over simulated prices.
- **Steps:** request quotes. Don't subscribe until we've compared them. Once you have a key, it's entered in Settings, never in chat.

### 4. Tax rates

- **Why:** rates change by budget and filer status. Unverified rates are deliberately not stored.
- **Blocked:** CGT and dividend-WHT estimates. Lookups report "not configured" until then.
- **Steps:** confirm the current rates with your tax advisor or FBR and NCCPL, and your Active Taxpayer (ATL) status. Enter them in Settings once that screen is built.

### 5. Hosting and domain (single secure URL)

- **Why:** a private, always-on URL needs a server and a certificate. Nothing will be purchased without your approval.
- **Works without it:** everything runs locally (`docker compose`). The production compose, Nginx, TLS and backups will be prepared and tested locally.
- **Suggested setup:** a small VPS (2 vCPU / 4 GB, about US$6–12/month), a domain (about US$10–15/year), a free TLS certificate, and access limited to you.

### 6–7. Notifications and AI provider

These will be described when those features are built, with the exact permissions requested. Email will use read-only OAuth for contract notes.
