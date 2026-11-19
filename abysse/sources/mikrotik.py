"""API REST de RouterOS (MikroTik), lecture seule, authentification Basic.

L'API REST renvoie tous les nombres et booléens en chaînes (``"rx-byte": "91682063614"``,
``"running": "true"``) : les données sont rendues telles quelles, ``modele`` et
``CompteurDebit`` acceptent les deux formes.

Sobriété : RouterOS 7 garde une petite part des sessions REST ouvertes (fuite
côté routeur, une centaine par jour avec l'ancien rythme). La lecture rapide ne demande donc
plus que les interfaces (débit des câbles), et les ressources du routeur passent à la lecture
lente : 1 requête toutes les 2 s et 5 toutes les 30 s, contre 2 par seconde et 4 toutes les
15 s avant (environ 57 600 requêtes par jour au lieu de 195 840).
"""

from __future__ import annotations

import base64

from . import ErreurSource
from .http import requete_json

NOM = "MikroTik"


def _base(cfg) -> str:
    base = cfg.mikrotik_url.strip().rstrip("/")
    if not base.endswith("/rest"):
        base += "/rest"
    return base


def _entetes(cfg) -> dict:
    jeton = base64.b64encode(f"{cfg.mikrotik_user}:{cfg.mikrotik_pass}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {jeton}", "Accept": "application/json"}


def _lire(cfg, chemin: str, attendu: type) -> object:
    try:
        r = requete_json(_base(cfg) + chemin, _entetes(cfg))
    except ErreurSource as e:
        raise e.prefixee(NOM) from None
    if not isinstance(r, attendu):
        raise ErreurSource(f"{NOM} : réponse inattendue sur /rest{chemin}")
    return r


def lire_rapide(cfg) -> dict:
    """Compteurs des interfaces (débit des câbles), une seule requête (toutes les 2 s)."""
    return {"interfaces": _lire(cfg, "/interface", list)}


def lire_lent(cfg) -> dict:
    """Ressources du routeur, ARP, baux DHCP, table du pont et client DHCP du WAN (toutes les 30 s)."""
    return {
        "ressource": _lire(cfg, "/system/resource", dict),
        "arp": _lire(cfg, "/ip/arp", list),
        "baux": _lire(cfg, "/ip/dhcp-server/lease", list),
        "hotes_pont": _lire(cfg, "/interface/bridge/host", list),
        "dhcp_client": _lire(cfg, "/ip/dhcp-client", list),
    }
