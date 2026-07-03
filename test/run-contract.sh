#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════
# test/run-contract.sh <odoo_version>  (ex: 17.0 | 18.0 — défaut 17.0)
# ═══════════════════════════════════════════════════════════════════════
# Monte un Odoo RÉEL éphémère (postgres + odoo, containers jetables),
# attend qu'il soit prêt, lance test/contract.test.js, détruit tout.
# Même script en local (Docker Desktop) et en CI (parité local/CI — la CI
# n'est qu'un runner de ce script, jamais une dépendance).
# ⚠️ Ports/noms fixes (8069, *-contract) : un seul run à la fois.
set -eu
V="${1:-17.0}"
NET="odoo-contract-net"
PG="pg-contract"
ODOO="odoo-contract"

cleanup() {
  docker rm -f "$ODOO" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD=odoo -e POSTGRES_DB=postgres \
  postgres:15 >/dev/null

# Init base+account+mail SANS démo (plus rapide, le test crée ses données).
# Le serveur démarre automatiquement après l'installation des modules.
docker run -d --name "$ODOO" --network "$NET" -p 8069:8069 \
  -e HOST="$PG" -e USER=odoo -e PASSWORD=odoo \
  "odoo:$V" odoo -d contract -i base,account,mail --without-demo=all >/dev/null

echo "Attente Odoo $V (init modules, jusqu'à 6 min)..."
# ⚠️ Deux conditions : HTTP up ET « Modules loaded » dans les logs — la page
# de login répond PENDANT l'installation des modules (mesuré : 5s), tester à
# ce moment-là = flake possible sur runner lent.
i=0
until curl -fsS http://localhost:8069/web/login >/dev/null 2>&1 && docker logs "$ODOO" 2>&1 | grep -q "Modules loaded"; do
  i=$((i+5))
  [ "$i" -ge 360 ] && { echo "TIMEOUT: Odoo pas prêt"; docker logs --tail 30 "$ODOO"; exit 1; }
  sleep 5
done
echo "Odoo $V prêt (${i}s). Lancement des tests de contrat."

CONTRACT_ODOO_URL="http://localhost:8069" node "$(dirname "$0")/contract.test.js"
