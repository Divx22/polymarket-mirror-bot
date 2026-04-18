
## Live execution on Polymarket (proxy wallet, both modes, limit at target's fill, with caps)

### What I'll build

**1. DB migration — extend `config` table**
- `auto_execute boolean default false` — master live-trading switch
- `max_usdc_per_trade numeric default 5`
- `daily_usdc_limit numeric default 50`
- `usdc_spent_today numeric default 0`
- `spent_day date default current_date`

Plus on `paper_orders`: allow UPDATE for own rows (currently UPDATE is blocked) so executor can write status/tx hash, and add columns:
- `executed_tx_hash text`
- `executed_at timestamptz`
- `error text`

**2. Secrets (you add when prompted)**
- `POLY_PRIVATE_KEY` — private key of the EOA you used to sign up to Polymarket (the signer behind your email-login proxy wallet)
- `POLY_FUNDER_ADDRESS` — your Polymarket proxy wallet address (the `0x…` shown on your profile that holds USDC)

**3. New edge function `execute-order`**
- Input: `{ paper_order_id }`, requires auth (user JWT)
- Loads the paper order + config, verifies ownership and caps
- Builds a **GTC limit order at `intended_price`** for `intended_size` shares using `@polymarket/clob-client` (via `npm:` specifier) with `signatureType = 1` (POLY_PROXY) and `funderAddress = POLY_FUNDER_ADDRESS`
- Auto-derives L2 API creds (`createOrDeriveApiKey`) on first call, caches them in a new `poly_credentials` table (user_id, api_key, api_secret, api_passphrase)
- POSTs the signed order, updates `paper_orders.status` → `submitted` / `filled` / `failed`, stores `executed_tx_hash` + `error`
- On success increments `config.usdc_spent_today` (resetting if `spent_day < today`)

**4. Hook into `poll-target-wallet`**
- After inserting a `paper_orders` row, if `cfg.auto_execute` is true and within caps → invoke `execute-order` inline (fire-and-forget but awaited so status updates land)

**5. UI**
- **`ConfigCard`**: add "Live trading" switch (red warning banner when on), "Max per trade (USDC)" input, "Daily limit (USDC)" input, plus a small "Spent today: $X / $Y" readout
- **`PaperLedger`**: add status badge column (simulated / submitted / filled / failed) and an "Execute" button on `simulated` rows that calls `execute-order`. Failed rows show error tooltip; submitted/filled rows show a Polygonscan link

### Important warnings shown in UI
- Real money, real losses; slippage between target's fill and yours is unavoidable
- SELL orders only work if you already hold that outcome's shares (we'll surface the error clearly)
- Polymarket is geo-restricted in the US — using CLOB API from there violates their ToS
- Caps are your only safety net — keep them low to start

### Order of operations once approved
1. Run DB migration
2. Request the two secrets (`POLY_PRIVATE_KEY`, `POLY_FUNDER_ADDRESS`) — wait for you to add them
3. Build `execute-order` function + `poly_credentials` table
4. Wire into poll function
5. Update `ConfigCard` and `PaperLedger`
6. You test with caps set very low ($1/trade) on a single manual click first
