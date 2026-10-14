#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

git checkout main
git fetch origin
git reset --hard origin/main
npm ci
npm run build
sudo systemctl daemon-reload
sudo systemctl restart telecodex

echo "Update and restart complete!"
