#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

git pull
npm run build
sudo systemctl daemon-reload
sudo systemctl restart telecodex

echo "Update and restart complete!"
