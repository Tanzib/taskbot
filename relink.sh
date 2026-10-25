#!/bin/bash
# Re-link the bot's WhatsApp (use if the bot phone was logged out)
cd "$(dirname "$0")"
sudo systemctl stop taskbot 2>/dev/null
rm -rf .auth
node index.js --login
sudo systemctl start taskbot
echo "✅ Re-linked. Bot restarted."
