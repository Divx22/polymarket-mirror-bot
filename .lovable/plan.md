
User wants the secrets prompt re-shown. POLY_PRIVATE_KEY and POLY_FUNDER_ADDRESS are not in the secrets list yet. I'll re-issue the add_secret request when in default mode.

## Re-request the two secrets

In default mode I'll call `add_secret` twice to surface the input form again:

1. **`POLY_PRIVATE_KEY`** — 64-char hex private key of your Polymarket signer (from polymarket.com → Settings → Wallet → Export private key, or browser localStorage under privy/magic).
2. **`POLY_FUNDER_ADDRESS`** — your Polymarket proxy wallet address (`0x…` shown on your profile / deposit screen).

Once you submit both, I'll proceed with:
- Building the `execute-order` edge function
- Wiring auto-execute into `poll-target-wallet`
- Updating `ConfigCard` (live toggle + caps) and `PaperLedger` (status + Execute button)
