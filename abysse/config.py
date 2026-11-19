"""Configuration d'Abysse, lue depuis l'environnement (clés ``ABYSSE_<CHAMP>``).

En production les valeurs viennent de ``/etc/abysse/abysse.env`` (chargé par systemd) ;
en développement, de simples variables d'environnement. Les secrets (``*_pass``,
``*_jeton``, ``*_cle``) ne sont jamais affichés par ``repr``/``str``.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass

PREFIXE = "ABYSSE_"
_SUFFIXES_SECRETS = ("_pass", "_jeton", "_cle")
_VRAI = {"1", "true", "vrai", "oui", "yes", "on"}
_FAUX = {"", "0", "false", "faux", "non", "no", "off"}

# Nom de source -> champ qui doit être renseigné pour qu'elle soit active.
_CHAMP_SOURCE = {
    "mikrotik": "mikrotik_url",
    "proxmox": "pve_url",
    "nut": "nut_hote",
    "influx": "influx_url",
    "truenas": "truenas_url",
}

_DOSSIER_WEB_DEFAUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


def _est_secret(nom: str) -> bool:
    return nom.endswith(_SUFFIXES_SECRETS)


@dataclass(frozen=True, repr=False)
class Config:
    mikrotik_url: str = ""
    mikrotik_user: str = ""
    mikrotik_pass: str = ""
    pve_url: str = ""
    pve_jeton: str = ""
    pve_ca: str = ""
    pve_noeud: str = "pve"
    nut_hote: str = ""
    nut_port: int = 3493
    nut_ups: str = "onduleur"
    influx_url: str = ""
    influx_jeton: str = ""
    influx_org: str = "homelab"
    truenas_url: str = ""
    truenas_utilisateur: str = "abysse"
    truenas_cle: str = ""
    truenas_ca: str = ""
    ecoute_hote: str = "0.0.0.0"
    ecoute_port: int = 80
    base: str = "/var/lib/abysse/abysse.db"
    dossier_web: str = _DOSSIER_WEB_DEFAUT
    sites_json: str = "/etc/abysse/sites.json"
    inventaire: str = ""
    phare_url: str = ""
    demo: bool = False

    def source_active(self, nom: str) -> bool:
        """Vrai si l'URL (ou l'hôte) de la source ``nom`` est renseigné."""
        try:
            champ = _CHAMP_SOURCE[nom]
        except KeyError:
            raise ValueError(f"source inconnue : {nom!r}") from None
        return bool(getattr(self, champ).strip())

    def __repr__(self) -> str:
        morceaux = []
        for f in dataclasses.fields(self):
            valeur = getattr(self, f.name)
            if _est_secret(f.name):
                affiche = "'***'" if valeur else "''"
            else:
                affiche = repr(valeur)
            morceaux.append(f"{f.name}={affiche}")
        return f"Config({', '.join(morceaux)})"

    __str__ = __repr__


def _booleen(cle: str, texte: str) -> bool:
    t = texte.strip().lower()
    if t in _VRAI:
        return True
    if t in _FAUX:
        return False
    raise ValueError(f"{cle} : valeur booléenne invalide")


def _port(cle: str, texte: str) -> int:
    try:
        n = int(texte.strip())
    except ValueError:
        raise ValueError(f"{cle} : port invalide (entier attendu)") from None
    if not 0 <= n <= 65535:
        raise ValueError(f"{cle} : port hors de 0-65535")
    return n


def charger_config(env: dict[str, str]) -> Config:
    """Construit la configuration depuis ``env`` (par exemple ``os.environ``).

    Les clés absentes prennent la valeur par défaut. Les messages d'erreur ne
    contiennent jamais la valeur fautive (elle pourrait être un secret mal placé).
    """
    valeurs: dict[str, object] = {}
    for f in dataclasses.fields(Config):
        cle = PREFIXE + f.name.upper()
        if cle not in env:
            continue
        brut = env[cle]
        if f.type in (int, "int"):
            valeurs[f.name] = _port(cle, brut)
        elif f.type in (bool, "bool"):
            valeurs[f.name] = _booleen(cle, brut)
        else:
            valeurs[f.name] = brut.strip()
    return Config(**valeurs)
