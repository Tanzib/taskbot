#!/bin/bash
# =====================================================================
#  Team Task Tracker — one-command installer for a free cloud server
#  (Oracle Cloud Always Free, Ubuntu 22.04/24.04). Run inside the bot folder:
#      bash install.sh
# =====================================================================
set -e
cd "$(dirname "$0")"
BOT_DIR="$(pwd)"
echo ""
echo "=== Team Task Tracker installer ==="

# 1. Time zone + small swap file (free servers have 1 GB RAM)
sudo timedatectl set-timezone Asia/Dhaka || true
if ! swapon --show | grep -q swapfile; then
  echo "→ Adding 1 GB swap…"
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 2. Node.js 22
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "→ Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
echo "→ Node $(node -v)"

# 3. Bot packages
echo "→ Installing bot packages…"
npm install --omit=dev --no-audit --no-fund >/dev/null

# 4. Settings
if [ ! -f config.json ]; then
  echo ""
  echo "Paste each value and press Enter:"
  read -rp "  1) Web app URL (ends with /exec): " SHEET_URL
  read -rp "  2) Bot connection key (from the sheet menu): " SECRET
  read -rp "  3) WhatsApp group name (exact): " GROUP_NAME
  read -rp "  4) Bot WhatsApp number, e.g. 8801XXXXXXXXX (leave empty to use a QR code): " PAIR
  SHEET_URL="$SHEET_URL" SECRET="$SECRET" GROUP_NAME="$GROUP_NAME" PAIR="$PAIR" node -e '
    const fs=require("fs");const c=JSON.parse(fs.readFileSync("config.example.json","utf8"));
    c.SHEET_URL=process.env.SHEET_URL.trim();c.SECRET=process.env.SECRET.trim();
    c.GROUP_NAME=process.env.GROUP_NAME.trim();c.PAIR_WITH_NUMBER=process.env.PAIR.replace(/\D/g,"");
    fs.writeFileSync("config.json",JSON.stringify(c,null,2));'
  echo "→ Saved config.json"
fi

# 5. Link WhatsApp (one time)
if [ ! -f .auth/creds.json ] || ! grep -q '"registered":true' .auth/creds.json 2>/dev/null; then
  echo ""
  echo "→ Linking WhatsApp. Follow the instructions that appear (code or QR)…"
  node index.js --login
fi

# 6. Run forever as a service (auto-starts on reboot, restarts on crash)
sudo tee /etc/systemd/system/taskbot.service >/dev/null <<EOF
[Unit]
Description=Team Task Tracker WhatsApp bot
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$BOT_DIR
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=10
Environment=TZ=Asia/Dhaka
Environment=NODE_OPTIONS=--max-old-space-size=384

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now taskbot >/dev/null 2>&1
sudo systemctl restart taskbot

echo ""
echo "✅ Done! The bot now runs 24/7 on this server."
echo ""
echo "   See live log:      sudo journalctl -u taskbot -f      (Ctrl+C to exit)"
echo "   Restart:           sudo systemctl restart taskbot"
echo "   Re-link WhatsApp:  bash relink.sh"
echo "   Change settings:   nano config.json   then restart"
echo ""
sleep 8
sudo journalctl -u taskbot -n 15 --no-pager
