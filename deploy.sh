#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-yandex-bot}"
IMAGE_NAME="${IMAGE_NAME:-${APP_NAME}:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-${APP_NAME}}"
ENV_FILE="${ENV_FILE:-.env}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker topilmadi. Serverga Docker o'rnating." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} topilmadi. Shu papkada .env bo'lishi kerak (BOTTOKEN va boshqalar)." >&2
  exit 1
fi

# If docker compose is available and docker-compose.yml exists, bring up DB + bot together.
if [[ -f "docker-compose.yml" ]] && docker compose version >/dev/null 2>&1; then
  echo "[1/1] docker compose up (db + bot)"
  docker compose --env-file "${ENV_FILE}" up -d --build
  echo "OK. Loglar: docker compose logs -f bot"
  exit 0
fi

echo "[1/3] Docker image build: ${IMAGE_NAME}"
docker build -t "${IMAGE_NAME}" .

echo "[2/3] Oldingi container bo'lsa to'xtatish: ${CONTAINER_NAME}"
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

PREFS_FILE="user_prefs.json"
PREFS_MOUNT=()
if [[ -f "${PREFS_FILE}" ]]; then
  PREFS_MOUNT=(-v "$(pwd)/${PREFS_FILE}:/app/${PREFS_FILE}")
fi

echo "[3/3] Container run: ${CONTAINER_NAME}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --env-file "${ENV_FILE}" \
  "${PREFS_MOUNT[@]}" \
  "${IMAGE_NAME}"

echo "OK. Loglarni ko'rish: docker logs -f ${CONTAINER_NAME}"
