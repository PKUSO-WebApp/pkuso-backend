#!/bin/bash
# scripts/pull-types.sh
# Pull latest database.types.ts from pkuso-backend
# Usage: ./scripts/pull-types.sh
#
# Requires pkuso-backend to be at ../pkuso-backend relative to this project,
# or set PKUSO_BACKEND_PATH environment variable.

set -e

BACKEND_PATH="${PKUSO_BACKEND_PATH:-../pkuso-backend}"
SOURCE="$BACKEND_PATH/types/database.types.ts"
DEST="src/types/database.types.ts"

if [ ! -f "$SOURCE" ]; then
  echo "Error: database.types.ts not found at $SOURCE"
  echo ""
  echo "Please ensure pkuso-backend is cloned at:"
  echo "  $BACKEND_PATH"
  echo ""
  echo "Or set PKUSO_BACKEND_PATH to the correct location."
  exit 1
fi

cp "$SOURCE" "$DEST"
echo "✓ Types updated from pkuso-backend ($BACKEND_PATH)"
