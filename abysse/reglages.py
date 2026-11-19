"""Réglages du mode « modifier » (renommages, nœuds masqués, « éteint exprès », liens manuels).

Le mode « modifier » est ouvert à tous sur le LAN : toute saisie est validée strictement ici
(``ValueError`` avec un message en français, sans recopier la saisie), puis stockée dans
SQLite (table ``reglages``, une ligne JSON par clé). Les réglages sont gardés en mémoire ;
les propriétés renvoient des copies, lisibles depuis n'importe quel thread.

Forme des modifications acceptées par ``appliquer`` :

- ``{"action": "renommer", "id", "nom"}`` (``"nom": None`` rétablit le nom d'origine) ;
- ``{"action": "cacher" | "montrer", "id"}`` ;
- ``{"action": "eteint_expres", "id", "valeur": bool}`` (``valeur`` absente = ``True``) ;
- ``{"action": "ajouter_lien", "nom", "url", "parent"}`` → id ``lien-<n>`` (jamais réutilisé) ;
- ``{"action": "modifier_lien", "id", "nom"?, "url"?, "parent"?}`` : ``lien-<n>`` existant, ou
  ``site-<nom>`` pour corriger un site du Caddyfile (``None`` = valeur détectée gardée) ;
- ``{"action": "retirer_lien", "id"}`` : un ``lien-<n>`` est supprimé ; un ``site-<nom>`` perd
  sa correction et est masqué (il reste dans le Caddyfile ; « montrer » le fait revenir).
"""

from __future__ import annotations

import copy
import json
import re
import sqlite3
import threading
from contextlib import closing

from . import inventaire

ACTIONS = ("renommer", "cacher", "montrer", "eteint_expres", "ajouter_lien", "modifier_lien", "retirer_lien")
# Éteints exprès au premier lancement : liste de l'inventaire (``inventaire.ETEINTS_EXPRES``).
ETEINTS_EXPRES_DEFAUT = frozenset(inventaire.ETEINTS_EXPRES)

NOM_MAX = 40
MAX_LIENS = 200
MAX_ENTREES = 2000  # renommages / masqués / éteints exprès : borne la taille de la base

URL_RE = re.compile(r"^https?://[^\s<>\"'`]{1,200}$")
_ID_RE = re.compile(
    r"(?:ct|vm)-\d{1,9}"
    r"|app-[0-9a-fA-F]{12}"
    r"|site-[A-Za-z0-9][A-Za-z0-9.:\-]{0,199}"
    r"|lien-\d{1,9}"
)
_LIEN_RE = re.compile(r"lien-(\d{1,9})")
_CONTROLE_RE = re.compile(r"[\x00-\x1f\x7f]")


def _valider_id(id_: object, *, lien: bool = False, parent: bool = False) -> str:
    """Identifiant de nœud de la forme attendue (contrat central)."""
    if isinstance(id_, str) and (id_ in inventaire.EQUIPEMENTS or id_ == "truenas" or _ID_RE.fullmatch(id_)):
        if lien and not id_.startswith(("lien-", "site-")):
            raise ValueError("Ce nœud n'est pas un lien de site.")
        if parent and id_.startswith(("lien-", "site-")):
            raise ValueError("Un lien doit être rattaché à une machine, un CT ou une VM, pas à un site.")
        return id_
    raise ValueError("Identifiant de nœud inconnu.")


def _valider_nom(nom: object) -> str:
    if not isinstance(nom, str) or not nom.strip():
        raise ValueError("Le nom ne peut pas être vide.")
    nom = nom.strip()
    if len(nom) > NOM_MAX:
        raise ValueError(f"Le nom ne doit pas dépasser {NOM_MAX} caractères.")
    if "<" in nom or ">" in nom:
        raise ValueError("Le nom ne doit contenir ni « < » ni « > ».")
    if _CONTROLE_RE.search(nom):
        raise ValueError("Le nom contient des caractères de contrôle.")
    return nom


def _valider_url(url: object) -> str:
    if not isinstance(url, str) or not URL_RE.fullmatch(url):
        raise ValueError(
            "Adresse refusée : elle doit commencer par http:// ou https://, sans espace, "
            "guillemet ni chevron, et faire 200 caractères au plus après le schéma."
        )
    return url


def _ensemble(valeur: object, defaut: frozenset | set) -> set[str]:
    if isinstance(valeur, list) and all(isinstance(x, str) for x in valeur):
        return set(valeur)
    return set(defaut)


class Reglages:
    """Réglages persistants dans la base SQLite ``chemin_db`` (table ``reglages``)."""

    def __init__(self, chemin_db: str):
        self._chemin = chemin_db
        self._verrou = threading.Lock()
        with closing(sqlite3.connect(chemin_db, timeout=10)) as c, c:
            c.execute("CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
            lignes = dict(c.execute("SELECT cle, valeur FROM reglages").fetchall())
        brut: dict[str, object] = {}
        for cle, valeur in lignes.items():
            try:
                brut[cle] = json.loads(valeur)
            except (TypeError, ValueError):
                pass  # valeur abîmée : on retombe sur le défaut de cette clé
        self._etat = self._normaliser(brut)

    # ----------------------------------------------------------------- lecture

    @staticmethod
    def _normaliser(brut: dict) -> dict:
        noms = brut.get("noms")
        noms = {k: v for k, v in noms.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(noms, dict) else {}
        liens = []
        if isinstance(brut.get("liens"), list):
            for l in brut["liens"]:
                if isinstance(l, dict) and isinstance(l.get("id"), str):
                    liens.append({k: l.get(k) for k in ("id", "nom", "url", "parent")})
        prochain = brut.get("prochain_lien")
        if not isinstance(prochain, int) or isinstance(prochain, bool) or prochain < 1:
            prochain = 1
        for l in liens:  # ne jamais redonner un id déjà pris
            m = _LIEN_RE.fullmatch(l["id"])
            if m:
                prochain = max(prochain, int(m.group(1)) + 1)
        return {
            "noms": noms,
            "caches": _ensemble(brut.get("caches"), set()),
            "eteints_expres": _ensemble(brut.get("eteints_expres"), frozenset(inventaire.ETEINTS_EXPRES)),
            "liens": liens,
            "prochain_lien": prochain,
        }

    @property
    def noms(self) -> dict[str, str]:
        with self._verrou:
            return dict(self._etat["noms"])

    @property
    def caches(self) -> set[str]:
        with self._verrou:
            return set(self._etat["caches"])

    @property
    def eteints_expres(self) -> set[str]:
        with self._verrou:
            return set(self._etat["eteints_expres"])

    @property
    def liens(self) -> list[dict]:
        with self._verrou:
            return copy.deepcopy(self._etat["liens"])

    def en_dict(self) -> dict:
        """Réglages pour l'API (``GET /api/reglages``), sérialisables en JSON."""
        with self._verrou:
            e = self._etat
            return {
                "noms": dict(sorted(e["noms"].items())),
                "caches": sorted(e["caches"]),
                "eteints_expres": sorted(e["eteints_expres"]),
                "liens": copy.deepcopy(e["liens"]),
            }

    # ----------------------------------------------------------------- écriture

    def appliquer(self, modif: dict) -> None:
        """Applique une modification validée et l'enregistre ; ``ValueError`` si refusée."""
        if not isinstance(modif, dict) or modif.get("action") not in ACTIONS:
            raise ValueError("Action inconnue.")
        action = modif["action"]
        with self._verrou:
            nouvel = copy.deepcopy(self._etat)
            getattr(self, "_" + action)(nouvel, modif)
            for cle in ("noms", "caches", "eteints_expres"):
                if len(nouvel[cle]) > MAX_ENTREES:
                    raise ValueError("Trop de réglages enregistrés pour ce type de modification.")
            self._ecrire(nouvel)
            self._etat = nouvel

    def _ecrire(self, etat: dict) -> None:
        valeurs = {
            "noms": etat["noms"],
            "caches": sorted(etat["caches"]),
            "eteints_expres": sorted(etat["eteints_expres"]),
            "liens": etat["liens"],
            "prochain_lien": etat["prochain_lien"],
        }
        with closing(sqlite3.connect(self._chemin, timeout=10)) as c, c:
            c.executemany(
                "INSERT OR REPLACE INTO reglages (cle, valeur) VALUES (?, ?)",
                [(cle, json.dumps(v, ensure_ascii=False)) for cle, v in valeurs.items()],
            )

    @staticmethod
    def _renommer(etat: dict, modif: dict) -> None:
        id_ = _valider_id(modif.get("id"))
        if modif.get("nom") is None and "nom" in modif:
            etat["noms"].pop(id_, None)
        else:
            etat["noms"][id_] = _valider_nom(modif.get("nom"))

    @staticmethod
    def _cacher(etat: dict, modif: dict) -> None:
        etat["caches"].add(_valider_id(modif.get("id")))

    @staticmethod
    def _montrer(etat: dict, modif: dict) -> None:
        etat["caches"].discard(_valider_id(modif.get("id")))

    @staticmethod
    def _eteint_expres(etat: dict, modif: dict) -> None:
        id_ = _valider_id(modif.get("id"))
        valeur = modif.get("valeur", True)
        if not isinstance(valeur, bool):
            raise ValueError("« éteint exprès » attend vrai ou faux.")
        if valeur:
            etat["eteints_expres"].add(id_)
        else:
            etat["eteints_expres"].discard(id_)

    @staticmethod
    def _ajouter_lien(etat: dict, modif: dict) -> None:
        nom = _valider_nom(modif.get("nom"))
        url = _valider_url(modif.get("url"))
        parent = _valider_id(modif.get("parent"), parent=True)
        if len(etat["liens"]) >= MAX_LIENS:
            raise ValueError(f"Trop de liens manuels ({MAX_LIENS} au plus).")
        id_ = f"lien-{etat['prochain_lien']}"
        etat["prochain_lien"] += 1
        etat["liens"].append({"id": id_, "nom": nom, "url": url, "parent": parent})

    @staticmethod
    def _modifier_lien(etat: dict, modif: dict) -> None:
        id_ = _valider_id(modif.get("id"), lien=True)
        changements = {}
        if modif.get("nom") is not None:
            changements["nom"] = _valider_nom(modif["nom"])
        if modif.get("url") is not None:
            changements["url"] = _valider_url(modif["url"])
        if modif.get("parent") is not None:
            changements["parent"] = _valider_id(modif["parent"], parent=True)
        if not changements:
            raise ValueError("Rien à modifier : indiquez un nom, une adresse ou un parent.")
        existant = next((l for l in etat["liens"] if l["id"] == id_), None)
        if existant is None:
            if id_.startswith("lien-"):
                raise ValueError("Ce lien n'existe pas (ou plus).")
            if len(etat["liens"]) >= MAX_LIENS:
                raise ValueError(f"Trop de liens manuels ({MAX_LIENS} au plus).")
            existant = {"id": id_, "nom": None, "url": None, "parent": None}
            etat["liens"].append(existant)
        existant.update(changements)

    @staticmethod
    def _retirer_lien(etat: dict, modif: dict) -> None:
        id_ = _valider_id(modif.get("id"), lien=True)
        avant = len(etat["liens"])
        etat["liens"] = [l for l in etat["liens"] if l["id"] != id_]
        if id_.startswith("site-"):
            etat["caches"].add(id_)
        elif len(etat["liens"]) == avant:
            raise ValueError("Ce lien n'existe pas (ou plus).")
