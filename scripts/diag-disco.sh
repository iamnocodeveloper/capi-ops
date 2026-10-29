#!/bin/bash
# Diagnóstico de disco de un host con Coolify + WAHA. Solo lectura.
# Uso: bash diag-disco.sh
set -u

W="${WAHA_IMAGE:-devlikeapro/waha:latest}"
CU="/app/.sessions"

echo "=== HOST ==="
hostname
df -h / | tail -1

echo "=== DOCKER ==="
docker system df

echo "=== LOGS DE CONTENEDORES ==="
du -sc /var/lib/docker/containers/*/*-json.log 2>/dev/null | tail -1 | awk '{printf "total: %.1f MB\n", $1/1024}'

echo "=== WAHA: top 10 por /app/.sessions (MB) ==="
for c in $(docker ps --format '{{.Names}}' --filter ancestor="$W"); do
  size=$(docker exec "$c" du -sm "$CU" 2>/dev/null | awk '{print $1}')
  [ -z "$size" ] && size=0
  echo "$size|$c"
done | sort -t'|' -k1 -rn | head -10 | awk -F'|' '{printf "%6s MB  %s\n", $1, $2}'

echo "=== WAHA: total ==="
for c in $(docker ps --format '{{.Names}}' --filter ancestor="$W"); do
  docker exec "$c" du -sm "$CU" 2>/dev/null | awk '{print $1}'
done | awk '{s+=$1; n++} END {printf "%d contenedores, %d MB en .sessions\n", n, s}'

echo "=== MEDIA: ¿se persiste? ==="
for c in $(docker ps --format '{{.Names}}' --filter ancestor="$W" | head -3); do
  m=$(docker exec "$c" sh -c 'ls -d /app/.media 2>/dev/null || echo "sin /app/.media"')
  echo "$c -> $m"
done

echo "=== ENV relevantes (solo nombres) ==="
c=$(docker ps --format '{{.Names}}' --filter ancestor="$W" | head -1)
docker exec "$c" sh -c 'printenv | cut -d= -f1 | grep -Ei "FILES|MEDIA|STORE" || echo "sin FILES/MEDIA/STORE"'

echo "=== FIN ==="
