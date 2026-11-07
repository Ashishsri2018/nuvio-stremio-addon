#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-deploy/vercel.env}"
target="${2:-production}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI is required" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi

if [ ! -f ".vercel/project.json" ]; then
  echo "run 'vercel link' first" >&2
  exit 1
fi

applied=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  if [[ "$line" != *=* ]]; then
    echo "invalid env line: $line" >&2
    exit 1
  fi
  key="${line%%=*}"
  value="${line#*=}"
  if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "invalid env key: $key" >&2
    exit 1
  fi
  echo "set $key ($target)"
  vercel env add "$key" --environment "$target" --value "$value" --force --yes >/dev/null
  applied=$((applied + 1))
done < "$env_file"

echo "Vercel environment updated ($applied variables, $target)"
