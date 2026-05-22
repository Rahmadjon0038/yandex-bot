#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
IMAGE_NAME="${IMAGE_NAME:-yandex-bot}"
CONTAINER_NAME="${CONTAINER_NAME:-yandex-bot}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker topilmadi. Serverga Docker o'rnating." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} topilmadi. Shu papkada .env bo'lishi kerak (BOTTOKEN va boshqalar)." >&2
  exit 1
fi

if [[ ! -f "Dockerfile" ]]; then
  echo "Dockerfile topilmadi. Shu papkada Dockerfile bo'lishi kerak." >&2
  exit 1
fi

mkdir -p data
touch user_prefs.json

echo "[1/3] Docker build: ${IMAGE_NAME}"
docker build -t "${IMAGE_NAME}" .

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "[2/3] Old container remove: ${CONTAINER_NAME}"
  docker rm -f "${CONTAINER_NAME}" >/dev/null
else
  echo "[2/3] Old container: yo'q (skip)"
fi

echo "[3/3] Docker run: ${CONTAINER_NAME}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --env-file "${ENV_FILE}" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/user_prefs.json:/app/user_prefs.json" \
  "${IMAGE_NAME}" >/dev/null

echo "OK: container ishga tushdi -> ${CONTAINER_NAME}"
