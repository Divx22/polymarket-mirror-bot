# mm-bot — self-hosted market-maker

Runs the same logic as the `mm-cycle` edge function, but from a machine
**you** control — so outbound traffic to Polymarket exits from a non-US
IP and isn't geoblocked.

---

## 1. Provision the VPS (5 min)

[Hetzner Cloud](https://hetzner.com/cloud) → Create Server:

- **Location:** Frankfurt (FSN1) or Nuremberg (NBG1)
- **Image:** Ubuntu 24.04
- **Type:** CX22 (€4.51/mo) or CPX11
- Add your SSH key

Note the public IPv4. SSH in: `ssh root@YOUR_IP`

---

## 2. Install Deno (1 command)

```bash
curl -fsSL https://deno.land/install.sh | sh
ln -sf /root/.deno/bin/deno /usr/local/bin/deno
deno --version   # should print a version
```

---

## 3. Copy the bot to the VPS

From your **laptop**, in this repo's root:

```bash
scp bot/mm-bot.ts root@YOUR_IP:/opt/mm-bot.ts
```

(Or just paste the file contents into `/opt/mm-bot.ts` over SSH.)

---

## 4. Create the systemd unit

On the VPS, write `/etc/systemd/system/mm-bot.service`:

```ini
[Unit]
Description=Polymarket market-maker bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt
ExecStart=/usr/local/bin/deno run --allow-net --allow-env /opt/mm-bot.ts
Restart=always
RestartSec=5

# === FILL THESE IN ===
Environment="SUPABASE_URL=https://auqqwxxgjusuwqwxwysu.supabase.co"
Environment="SUPABASE_SERVICE_ROLE_KEY=PASTE_FROM_LOVABLE_CLOUD"
Environment="POLY_PRIVATE_KEY=PASTE_YOUR_PRIVATE_KEY"
Environment="POLY_FUNDER_ADDRESS=0x63a3431d74364f6B6aFdd437A92871c753d66385"
Environment="CYCLE_INTERVAL_SECONDS=30"

[Install]
WantedBy=multi-user.target
```

Get the values:
- `SUPABASE_SERVICE_ROLE_KEY`: Lovable → Cloud → Backend → API keys → `service_role`
- `POLY_PRIVATE_KEY`: same value you set as a Lovable secret earlier
- `POLY_FUNDER_ADDRESS`: your Polymarket proxy wallet (already filled above)

**Lock down the file** (it has secrets):
```bash
chmod 600 /etc/systemd/system/mm-bot.service
```

---

## 5. Start it

```bash
systemctl daemon-reload
systemctl enable --now mm-bot
systemctl status mm-bot
journalctl -u mm-bot -f      # live logs — Ctrl+C to exit
```

First log lines should show:
```
egress IP: 95.xxx.xxx.xxx     ← should be a German IP
mm-bot started, interval=30s
2026-04-18T... user <uuid> markets 21 placed 8 cancelled 0 fills 0 errors 0
```

If `errors 0` and you see `placed > 0` for previously-blocked markets → geoblock defeated 🎉

---

## 6. Disable the edge-function cron (avoid double-trading)

Once the VPS bot is humming, you must stop the edge function from also running, or both will fight over the same orders.

In Lovable, ask: *"disable the pg_cron schedule that calls mm-cycle every 30s"* — this requires a migration to drop the cron job.

---

## Operations cheatsheet

| What | Command |
|---|---|
| Tail logs | `journalctl -u mm-bot -f` |
| Restart | `systemctl restart mm-bot` |
| Stop | `systemctl stop mm-bot` |
| Update bot code | `scp bot/mm-bot.ts root@IP:/opt/mm-bot.ts && ssh root@IP systemctl restart mm-bot` |
| Check egress IP | `ssh root@IP curl -s https://api.ipify.org` |

---

## Cost: €4.51/month. That's it.
