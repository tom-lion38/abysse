"""InfluxDB 2, lecture seule par jeton : requêtes Flux, CSV annoté.

``requete`` envoie une requête Flux (``POST /api/v2/query?org=``) en demandant le CSV
annoté (``#datatype``, ``#group``, ``#default``) et rend une ligne par enregistrement,
toutes tables confondues (les tables sont séparées par des lignes vides et peuvent avoir
des colonnes différentes). Les valeurs sont converties selon ``#datatype``.
"""

from __future__ import annotations

import csv
import io
import json
import urllib.parse

from . import ErreurSource
from .http import requete as requete_http

NOM = "InfluxDB"
BUCKET = "homelab"

# Dernières valeurs sur 15 min : sondes Uptime Kuma, Synology (DSM), pool ZFS du PBS.
FLUX_LIRE = """from(bucket: "%s")
  |> range(start: -15m)
  |> filter(fn: (r) =>
      r._measurement == "monitor_status"
      or (r._measurement == "synology"
          and (r._field == "raid_total_size" or r._field == "raid_free_size" or r._field == "system_status"))
      or (r._measurement == "zfs_pool_etat" and r.host == "pbs"
          and (r._field == "size" or r._field == "alloc" or r._field == "health")))
  |> last()""" % BUCKET

_ENTIERS = ("long", "unsignedLong")


def _convertir(valeur: str, type_: str | None) -> object:
    if type_ in _ENTIERS:
        if valeur == "":
            return None
        try:
            return int(valeur)
        except ValueError:
            return valeur
    if type_ == "double":
        if valeur == "":
            return None
        try:
            return float(valeur)
        except ValueError:
            return valeur
    if type_ == "boolean":
        if valeur == "":
            return None
        return valeur.strip().lower() == "true"
    return valeur


def analyser_csv(texte: str) -> list[dict]:
    """Analyse un CSV annoté InfluxDB (une ou plusieurs tables) en liste de dicts.

    La première colonne (celle des annotations, sans nom) est retirée. Une valeur vide
    prend la valeur de ``#default`` si elle existe. Lève ``ErreurSource`` si la réponse est
    une table d'erreur (colonnes ``error``, ``reference``).
    """
    lignes: list[dict] = []
    entete: list[str] | None = None
    types: list[str] | None = None
    defauts: list[str] | None = None
    for rang in csv.reader(io.StringIO(texte, newline="")):
        if not rang or all(c == "" for c in rang):
            entete = types = defauts = None  # nouvelle table
            continue
        premier = rang[0]
        if premier.startswith("#"):
            if entete is not None:
                # Annotations sans ligne vide avant : nouvelle table.
                entete = None
                types = defauts = None
            if premier == "#datatype":
                types = rang
            elif premier == "#default":
                defauts = rang
            continue
        if entete is None:
            entete = rang
            if "error" in entete[1:] and "reference" in entete[1:]:
                raise ErreurSource(f"{NOM} : la requête a échoué")
            continue
        enreg: dict = {}
        for i, nom in enumerate(entete):
            if i == 0 and nom == "":
                continue  # colonne des annotations
            valeur = rang[i] if i < len(rang) else ""
            if valeur == "" and defauts is not None and i < len(defauts):
                valeur = defauts[i]
            enreg[nom] = _convertir(valeur, types[i] if types is not None and i < len(types) else None)
        lignes.append(enreg)
    return lignes


def requete(cfg, flux: str) -> list[dict]:
    """Exécute la requête Flux ``flux`` et rend ses enregistrements (toutes tables)."""
    url = cfg.influx_url.strip().rstrip("/") + "/api/v2/query?" + urllib.parse.urlencode({"org": cfg.influx_org})
    corps = json.dumps({
        "query": flux,
        "type": "flux",
        "dialect": {"header": True, "delimiter": ",", "annotations": ["datatype", "group", "default"]},
    }).encode("utf-8")
    entetes = {
        "Authorization": f"Token {cfg.influx_jeton}",
        "Accept": "application/csv",
        "Content-Type": "application/json",
    }
    try:
        brut = requete_http(url, entetes, methode="POST", corps=corps)
    except ErreurSource as e:
        raise e.prefixee(NOM) from None
    try:
        texte = brut.decode("utf-8")
    except UnicodeDecodeError:
        raise ErreurSource(f"{NOM} : réponse illisible") from None
    try:
        return analyser_csv(texte)
    except csv.Error:
        raise ErreurSource(f"{NOM} : CSV invalide") from None


def _entier(x: object) -> int | None:
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return int(x)
    if isinstance(x, str):
        try:
            return int(float(x))
        except ValueError:
            return None
    return None


def lire(cfg) -> dict:
    """``{"kuma": {nom: 0|1}, "synology": {...}, "pbs_pool": {"size", "alloc", "health"}}``.

    Kuma : 0 = sonde en panne, 1 sinon (en attente, maintenance et en ligne ne sont pas
    des pannes). Synology : tailles additionnées sur les volumes. Pool du PBS :
    ``backup-pool`` de préférence, sinon le premier pool vu.
    """
    kuma: dict[str, int] = {}
    synology: dict[str, int] = {}
    pools: dict[str, dict] = {}
    for l in requete(cfg, FLUX_LIRE):
        mesure = l.get("_measurement")
        champ = l.get("_field")
        valeur = l.get("_value")
        if mesure == "monitor_status":
            nom = l.get("monitor_name")
            n = _entier(valeur)
            if isinstance(nom, str) and nom and n is not None:
                etat = 0 if n == 0 else 1
                kuma[nom] = min(kuma.get(nom, 1), etat)
        elif mesure == "synology" and champ in ("raid_total_size", "raid_free_size"):
            n = _entier(valeur)
            if n is not None:
                synology[champ] = synology.get(champ, 0) + n
        elif mesure == "synology" and champ == "system_status":
            n = _entier(valeur)
            if n is not None:
                synology[champ] = n
        elif mesure == "zfs_pool_etat" and l.get("host") == "pbs" and champ in ("size", "alloc", "health"):
            pool = pools.setdefault(str(l.get("pool") or ""), {})
            if champ == "health":
                if isinstance(valeur, str):
                    pool["health"] = valeur
            else:
                n = _entier(valeur)
                if n is not None:
                    pool[champ] = n
    if "backup-pool" in pools:
        pbs_pool = pools["backup-pool"]
    else:
        pbs_pool = next(iter(pools.values()), {})
    return {"kuma": dict(sorted(kuma.items())), "synology": synology, "pbs_pool": pbs_pool}
