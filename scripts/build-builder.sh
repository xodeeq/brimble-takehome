#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Building brimble-builder:latest..."
docker build "$REPO_ROOT/apps/builder" -t brimble-builder:latest
echo "Done. The API will use this image to run builds."
