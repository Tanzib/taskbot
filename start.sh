#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
[ -d node_modules ] || npm install
while true; do
  node index.js
  echo "Bot stopped. Restarting in 10 seconds... (Ctrl+C to quit)"
  sleep 10
done
