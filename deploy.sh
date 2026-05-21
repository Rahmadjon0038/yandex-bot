#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"

if ! command -v node >/dev/null 2>&1; then
  echo "node topilmadi. Serverga Node.js o'rnating (Node 18+ tavsiya qilinadi)." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} topilmadi. Shu papkada .env bo'lishi kerak (BOTTOKEN va boshqalar)." >&2
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm topilmadi. Node.js ni to'liq o'rnating (npm bilan birga)." >&2
    exit 1
  fi
  echo "[1/2] Dependencies: npm ci"
  npm ci
else
  echo "[1/2] Dependencies: node_modules mavjud (skip)"
fi

echo "[2/2] Bot start"
ENV_FILE="${ENV_FILE}" npm start
