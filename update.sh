#!/bin/bash
# Update the WhatsApp library (use if WhatsApp changes something and the bot stops working)
cd "$(dirname "$0")"
npm install baileys@latest --omit=dev --no-audit --no-fund
sudo systemctl restart taskbot
echo "✅ Updated and restarted."
sudo journalctl -u taskbot -n 15 --no-pager
