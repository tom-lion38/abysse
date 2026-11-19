#!/bin/bash
# Installe ou met à jour Abysse. À lancer en root DANS le CT, depuis le dossier du dépôt :
#
#   bash deploy/installer.sh              installe ou met à jour le code et le service
#   bash deploy/installer.sh --pare-feu   pareil, et applique deploy/nftables.conf
#
# Ne touche jamais à une configuration existante (/etc/abysse/abysse.env, inventaire.json,
# sites.json) : au premier passage, il copie seulement les fichiers d'exemple.
set -euo pipefail
cd "$(dirname "$0")/.."

PARE_FEU=0
[ "${1:-}" = "--pare-feu" ] && PARE_FEU=1

[ "$(id -u)" = 0 ] || { echo "À lancer en root." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 manquant : apt install python3" >&2; exit 1; }

# 1. Compte système et dossiers
id abysse >/dev/null 2>&1 || useradd --system --home /var/lib/abysse --shell /usr/sbin/nologin abysse
install -d -m 750 -o root -g abysse /etc/abysse
install -d -m 750 -o abysse -g abysse /var/lib/abysse

# 2. Code : copie neuve dans /opt/abysse, l'ancienne version gardée dans /opt/abysse.ancien
rm -rf /opt/abysse.nouveau
mkdir -p /opt/abysse.nouveau
cp -r abysse web deploy /opt/abysse.nouveau/
find /opt/abysse.nouveau -name __pycache__ -type d -prune -exec rm -rf {} +
rm -rf /opt/abysse.ancien
[ -d /opt/abysse ] && mv /opt/abysse /opt/abysse.ancien
mv /opt/abysse.nouveau /opt/abysse
chown -R root:root /opt/abysse
chmod -R a+rX /opt/abysse

# 3. Configuration (jamais écrasée)
if [ ! -f /etc/abysse/abysse.env ]; then
  install -m 600 -o abysse -g abysse deploy/abysse.env.exemple /etc/abysse/abysse.env
  echo "Configuration d'exemple copiée : à remplir dans /etc/abysse/abysse.env"
fi
if [ ! -f /etc/abysse/inventaire.json ]; then
  install -m 644 deploy/inventaire.exemple.json /etc/abysse/inventaire.json
  echo "Inventaire d'exemple copié : à adapter dans /etc/abysse/inventaire.json"
fi
[ -f /etc/abysse/sites.json ] || { echo "[]" > /etc/abysse/sites.json; chmod 644 /etc/abysse/sites.json; }

# 4. Pare-feu (facultatif)
if [ "$PARE_FEU" = 1 ]; then
  install -m 644 deploy/nftables.conf /etc/nftables.conf
  nft -c -f /etc/nftables.conf
  systemctl enable --now nftables >/dev/null
  nft -f /etc/nftables.conf
  echo "Pare-feu appliqué (vérifier les réseaux autorisés dans /etc/nftables.conf)."
fi

# 5. Service
install -m 644 deploy/abysse.service /etc/systemd/system/abysse.service
systemctl daemon-reload
systemctl enable abysse >/dev/null
systemctl restart abysse
sleep 3
systemctl is-active abysse
curl -fsS http://127.0.0.1/api/sante && echo
