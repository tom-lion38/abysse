#!/bin/bash
# Crée un CT Debian 13 non privilégié pour Abysse. À lancer en root sur l'hôte Proxmox.
#
# Usage :
#   CTID=150 IP=192.168.10.169/24 GW=192.168.10.198 bash creer-ct.sh
#
# Variables facultatives : DNS (défaut : la passerelle), BRIDGE (vmbr0), STOCKAGE (local-lvm),
# MODELE (dernier modèle Debian 13 trouvé dans le stockage "local").
set -euo pipefail

: "${CTID:?CTID manquant (numéro du CT à créer)}"
: "${IP:?IP manquante (par exemple 192.168.10.169/24)}"
: "${GW:?GW manquante (passerelle du réseau)}"
DNS="${DNS:-${GW}}"
BRIDGE="${BRIDGE:-vmbr0}"
STOCKAGE="${STOCKAGE:-local-lvm}"

if pct status "$CTID" >/dev/null 2>&1; then
  echo "Le CT $CTID existe déjà, rien n'est fait." >&2
  exit 1
fi

if [ -z "${MODELE:-}" ]; then
  pveam update >/dev/null
  NOM=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-13-standard' | sort -V | tail -1)
  [ -n "$NOM" ] || { echo "Aucun modèle Debian 13 disponible." >&2; exit 1; }
  pveam list local | grep -q "$NOM" || pveam download local "$NOM"
  MODELE="local:vztmpl/$NOM"
fi

pct create "$CTID" "$MODELE" --hostname abysse --cores 2 --memory 1024 --swap 512 \
  --rootfs "$STOCKAGE:8" --net0 "name=eth0,bridge=$BRIDGE,ip=$IP,gw=$GW" --nameserver "$DNS" \
  --unprivileged 1 --onboot 1 --features nesting=1 --ostype debian \
  --description "Abysse : carte vivante du homelab (LAN et VPN seulement)"
pct start "$CTID"
sleep 5
pct exec "$CTID" -- bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 nftables ca-certificates curl git'
echo "CT $CTID prêt. Suite : docs/INSTALLATION.md, étape 2."
