"""API Proxmox VE, lecture seule par jeton (par exemple ``abysse@pve!lecture``, rôle PVEAuditor).

PVE est appelé par IP (``https://192.168.10.97:8006``) : son certificat est vérifié contre sa
CA (``cfg.pve_ca``), sans contrôle du nom d'hôte. Les réponses sont enveloppées dans
``{"data": ...}``. Le nom du nœud lu vient de ``cfg.pve_noeud`` (``pve`` par défaut).
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable, Mapping

from . import ErreurSource
from .http import requete_json

NOM = "Proxmox"
NOEUD = "pve"  # valeur par défaut si la configuration n'a pas de ``pve_noeud``


def _noeud(cfg) -> str:
    return (getattr(cfg, "pve_noeud", "") or NOEUD).strip()

_RE_IP = re.compile(r"(?:^|,)ip=([^,/\s]+)")
_RE_NET = re.compile(r"^(?:net|ipconfig)(\d+)$")


def _base(cfg) -> str:
    base = cfg.pve_url.strip().rstrip("/")
    if not base.endswith("/api2/json"):
        base += "/api2/json"
    return base


def _get(cfg, chemin: str) -> object:
    entetes = {"Authorization": f"PVEAPIToken={cfg.pve_jeton}", "Accept": "application/json"}
    try:
        r = requete_json(_base(cfg) + chemin, entetes, ca=cfg.pve_ca or None)
    except ErreurSource as e:
        raise e.prefixee(NOM) from None
    if not isinstance(r, dict) or "data" not in r:
        raise ErreurSource(f"{NOM} : réponse inattendue sur {chemin}")
    return r["data"]


def lire(cfg) -> dict:
    """Ressources du cluster (invités, état, CPU, RAM, compteurs réseau) et état du nœud."""
    ressources = _get(cfg, "/cluster/resources")
    noeud = _get(cfg, f"/nodes/{_noeud(cfg)}/status")
    if not isinstance(ressources, list) or not isinstance(noeud, dict):
        raise ErreurSource(f"{NOM} : réponse inattendue")
    return {"ressources": ressources, "noeud": noeud}


def ip_depuis_config(config: dict) -> str | None:
    """Première IPv4 fixe des interfaces : ``net0`` (CT, ``ip=192.168.10.186/24``) ou ``ipconfig0`` (VM cloud-init)."""
    cles = sorted(
        (k for k in config if isinstance(k, str) and _RE_NET.match(k)),
        key=lambda k: (int(_RE_NET.match(k).group(1)), k),
    )
    for k in cles:
        v = config.get(k)
        if not isinstance(v, str):
            continue
        m = _RE_IP.search(v)
        if not m:
            continue
        try:
            ip = ipaddress.ip_address(m.group(1))  # « dhcp », « manual »… ne sont pas des IP
        except ValueError:
            continue
        if ip.version == 4:
            return str(ip)
    return None


def _onboot(config: dict) -> int:
    v = config.get("onboot", 0)  # absent = 0 (valeur par défaut de Proxmox)
    try:
        return 1 if int(str(v).strip()) == 1 else 0
    except ValueError:
        return 0


def lire_configs(cfg, vmids: Iterable[int] | Mapping[int, str]) -> dict:
    """``{vmid: {"onboot": 0|1, "ip": str | None}}`` depuis la configuration de chaque invité.

    ``vmids`` : identifiants seuls (on essaie ``lxc`` puis ``qemu``) ou dict
    ``{vmid: "lxc" | "qemu"}``. Un invité dont la configuration est introuvable est omis ;
    une erreur réseau ou d'authentification (401/403) fait échouer toute la lecture.
    """
    if isinstance(vmids, Mapping):
        demandes = [(int(v), (t,)) for v, t in vmids.items()]
    else:
        demandes = [(int(v), ("lxc", "qemu")) for v in vmids]
    resultat: dict[int, dict] = {}
    for vmid, types in demandes:
        for type_ in types:
            if type_ not in ("lxc", "qemu"):
                raise ValueError(f"type d'invité inconnu : {type_!r}")
            try:
                config = _get(cfg, f"/nodes/{_noeud(cfg)}/{type_}/{vmid}/config")
            except ErreurSource as e:
                if e.statut is None or e.statut in (401, 403):
                    raise
                continue  # 500 « does not exist » : pas ce type, ou invité disparu
            if isinstance(config, dict):
                resultat[vmid] = {"onboot": _onboot(config), "ip": ip_depuis_config(config)}
            break
    return resultat
