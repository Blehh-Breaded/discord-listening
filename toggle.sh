#!/bin/sh
f="$HOME/.discord-listening-off"
if [ -f "$f" ]; then
  rm "$f"
  echo "listening presence ON"
else
  touch "$f"
  echo "listening presence OFF"
fi
pkill -USR2 -f "discord-listening/index.js" 2>/dev/null || true