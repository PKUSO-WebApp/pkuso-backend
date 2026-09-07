#!/bin/bash
# scripts/gen-types.sh
# Generate TypeScript types from Supabase
# Usage: ./scripts/gen-types.sh [dev|prod]

set -e

ENV="${1:-prod}"

case "$ENV" in
  dev)
    PROJECT_REF="qibssimzuhusvutubbey"
    ;;
  prod)
    PROJECT_REF="xkrszbmmdaorivkatvwh"
    ;;
  *)
    echo "Usage: $0 [dev|prod]"
    exit 1
    ;;
esac

echo "Generating types from $ENV ($PROJECT_REF)..."
supabase gen types typescript --project-ref "$PROJECT_REF" --schema public > types/database.types.ts
echo "✓ Types written to types/database.types.ts"
