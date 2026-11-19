"""Évènements : ce qui a changé entre deux instantanés, et reconstitution depuis InfluxDB.

Un évènement est un dict ``{"t", "id", "nom", "nature", "importance", "texte"}`` :

- ``nature`` ∈ ``NATURES`` ;
- ``importance`` de 1 (petit ping) à 4 (énorme) :
  1 appareil perso ou PC fixe qui arrive / part, et tout passage ``eteint`` ↔ ``on`` ;
  2 CT, site ; 3 VM, TrueNAS, PBS, Synology, box, Home Assistant, stockage qui passe
  au-dessus de 90 %, sauvegarde PBS ratée ; 4 pve, MikroTik, Internet (WAN), onduleur sur
  batterie (et retour du courant) ;
- ``texte`` en français, prêt à afficher (``textContent`` côté navigateur).

Règles d'état : ``on`` → ``off`` = panne, ``off`` → ``on`` = retour (même importance) ;
``eteint`` ↔ ``on`` = apparition / départ, importance 1 ; tout passage par ``inconnu``
(source muette) et ``off`` ↔ ``eteint`` (simple reclassement) ne disent rien. Un nœud qui
apparaît ou disparaît de l'instantané ne compte que pour les appareils (un CT créé, un nœud
masqué ou un site ajouté ne font pas de ping).

Les pourcentages et durées utilisent une espace insécable (``ESPACE``) : « 87 % ».
"""

from __future__ import annotations

import datetime
import math
import re

from . import inventaire as inv

NATURES = ("panne", "retour", "batterie", "secteur", "stockage", "sauvegarde", "apparition", "depart")
ESPACE = " "

# Même seuil que le modèle : en dessous, l'onduleur est sur batterie.
SECTEUR_MIN_V = 180.0
# Seuil d'alerte stockage (fraction utilisée), franchi vers le haut.
SEUIL_STOCKAGE = 0.9

_IMPORTANCE_4 = frozenset({"pve", "mikrotik", "internet"})
_IMPORTANCE_3 = frozenset({"truenas", "pbs", "synology", "box", "ha"})


# --------------------------------------------------------------------------- outils

def _nombre(x: object) -> float | None:
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)):
        n = float(x)
    elif isinstance(x, str):
        try:
            n = float(x.strip())
        except ValueError:
            return None
    else:
        return None
    return n if math.isfinite(n) else None


def _dict(x: object) -> dict:
    return x if isinstance(x, dict) else {}


def _pourcent(fraction: float) -> str:
    """0.87 -> « 87 % » ; une valeur qui s'arrondirait sur le seuil garde une décimale (« 90,3 % »)."""
    p = fraction * 100
    if round(p) <= SEUIL_STOCKAGE * 100 < p:
        texte = f"{p:.1f}".replace(".", ",")
    else:
        texte = str(int(round(p)))
    return f"{texte}{ESPACE}%"


def _est_ct(id_: str) -> bool:
    return id_.startswith("ct-")


def _est_vm(id_: str) -> bool:
    return id_.startswith("vm-")


def _est_appareil(n: dict) -> bool:
    """Appareil perso (``app-<mac>``) ou PC fixe : ils arrivent et partent, jamais rouges."""
    id_ = str(n.get("id", ""))
    return n.get("type") == "pc" or id_.startswith("app-")


def _nom(n: dict) -> str:
    return n["nom"] if isinstance(n.get("nom"), str) and n["nom"] else str(n.get("id", ""))


def _libelle(n: dict) -> str:
    """« CT 102 supervision », « VM 200 TrueNAS », sinon le nom du nœud."""
    id_ = str(n.get("id", ""))
    nom = _nom(n)
    if _est_ct(id_) or _est_vm(id_):
        prefixe = "CT" if _est_ct(id_) else "VM"
        vmid = _dict(n.get("details")).get("vmid")
        if not isinstance(vmid, int) or isinstance(vmid, bool):
            vmid = id_.split("-", 1)[1]
        tete = f"{prefixe} {vmid}"
        return tete if nom in (tete, id_) else f"{tete} {nom}"
    return nom


def _importance(n: dict) -> int:
    id_ = str(n.get("id", ""))
    if _est_appareil(n):
        return 1
    if id_ in _IMPORTANCE_4:
        return 4
    if _est_vm(id_) or id_ in _IMPORTANCE_3:
        return 3
    return 2  # CT, site, onduleur, switch, caméra…


def _texte_etat(n: dict, nature: str) -> str:
    id_ = str(n.get("id", ""))
    lib = _libelle(n)
    e = "e" if _est_vm(id_) else ""  # une VM, un CT
    if _est_ct(id_) or _est_vm(id_):
        return {
            "panne": f"{lib} arrêté{e}",
            "retour": f"{lib} redémarré{e}",
            "apparition": f"{lib} démarré{e}",
            "depart": f"{lib} arrêté{e}",
        }[nature]
    if _est_appareil(n):
        return f"{lib} connecté" if nature in ("apparition", "retour") else f"{lib} déconnecté"
    if id_ == "internet":
        return "Internet coupé" if nature in ("panne", "depart") else "Internet rétabli"
    if n.get("type") == "site":
        return {
            "panne": f"Site {lib} hors ligne",
            "retour": f"Site {lib} de retour",
            "apparition": f"Site {lib} en ligne",
            "depart": f"Site {lib} arrêté",
        }[nature]
    return {
        "panne": f"{lib} hors ligne",
        "retour": f"{lib} de nouveau en ligne",
        "apparition": f"{lib} allumé",
        "depart": f"{lib} éteint",
    }[nature]


def _evt(t: float, n: dict, nature: str, importance: int, texte: str) -> dict:
    return {"t": t, "id": str(n.get("id", "")), "nom": _nom(n), "nature": nature,
            "importance": importance, "texte": texte}


# --------------------------------------------------------------------------- comparer

def _nature_etat(avant: str | None, apres: str | None) -> str | None:
    if avant == apres or "inconnu" in (avant, apres) or avant is None or apres is None:
        return None
    return {
        ("on", "off"): "panne",
        ("off", "on"): "retour",
        ("eteint", "on"): "apparition",
        ("on", "eteint"): "depart",
    }.get((avant, apres))


def _fraction_disque(n: dict) -> float | None:
    d = _dict(_dict(n.get("jauges")).get("disque"))
    u, total = _nombre(d.get("u")), _nombre(d.get("t"))
    if u is None or total is None or total <= 0:
        return None
    return u / total


def comparer(avant: dict | None, apres: dict) -> list[dict]:
    """Évènements entre deux instantanés successifs (``avant=None`` : premier, aucun évènement)."""
    if not isinstance(avant, dict) or not isinstance(apres, dict):
        return []
    t = _nombre(apres.get("t"))
    if t is None:
        return []
    av = {n["id"]: n for n in avant.get("noeuds") or [] if isinstance(n, dict) and isinstance(n.get("id"), str)}
    ap = {n["id"]: n for n in apres.get("noeuds") or [] if isinstance(n, dict) and isinstance(n.get("id"), str)}
    evts: list[dict] = []

    for id_, n in ap.items():
        a = av.get(id_)
        if a is None:
            # seul un appareil (perso ou PC fixe) « apparaît » vraiment
            if _est_appareil(n) and n.get("etat") == "on":
                evts.append(_evt(t, n, "apparition", 1, _texte_etat(n, "apparition")))
            continue

        nature = _nature_etat(a.get("etat"), n.get("etat"))
        if nature is not None:
            importance = 1 if nature in ("apparition", "depart") else _importance(n)
            evts.append(_evt(t, n, nature, importance, _texte_etat(n, nature)))

        # Onduleur : secteur ↔ batterie (d'après la tension, voir le modèle).
        sa, sp = _dict(a.get("jauges")).get("secteur"), _dict(n.get("jauges")).get("secteur")
        if isinstance(sa, bool) and isinstance(sp, bool) and sa != sp:
            if sa and not sp:
                batterie = _nombre(_dict(n.get("jauges")).get("batterie"))
                texte = "Onduleur sur batterie"
                if batterie is not None:
                    texte += f" ({int(round(batterie))}{ESPACE}%)"
                evts.append(_evt(t, n, "batterie", 4, texte))
            else:
                evts.append(_evt(t, n, "secteur", 4, "Courant revenu"))

        # Stockage qui franchit 90 % vers le haut (un seul évènement).
        fa, fp = _fraction_disque(a), _fraction_disque(n)
        if fa is not None and fp is not None and fa <= SEUIL_STOCKAGE < fp:
            evts.append(_evt(t, n, "stockage", 3, f"Stockage de {_nom(n)} à {_pourcent(fp)}"))

        # Sauvegardes PBS (sondes Kuma backup-*) : passage 1 -> 0 d'une entrée existante.
        sav_a = _dict(a.get("details")).get("sauvegardes")
        sav_p = _dict(n.get("details")).get("sauvegardes")
        if isinstance(sav_a, dict) and isinstance(sav_p, dict):
            for nom in sorted(k for k in sav_p if isinstance(k, str)):
                if _nombre(sav_a.get(nom)) == 1 and _nombre(sav_p.get(nom)) == 0:
                    evts.append(_evt(t, n, "sauvegarde", 3, f"Sauvegarde ratée : {nom}"))

    for id_, a in av.items():
        if id_ not in ap and _est_appareil(a) and a.get("etat") == "on":
            evts.append(_evt(t, a, "depart", 1, _texte_etat(a, "depart")))
    return evts


# --------------------------------------------------------------------------- InfluxDB

_RE_RFC3339 = re.compile(
    r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?", re.IGNORECASE
)


def _horodatage(x: object) -> float | None:
    """``_time`` InfluxDB (RFC 3339, fractions jusqu'à la nanoseconde) ou nombre -> secondes epoch."""
    n = _nombre(x)
    if n is not None and not isinstance(x, str):
        return n
    if isinstance(x, datetime.datetime):
        return x.timestamp()
    if not isinstance(x, str):
        return None
    m = _RE_RFC3339.fullmatch(x.strip())
    if not m:
        return None
    a, mo, j, h, mi, s, frac, tz = m.groups()
    try:
        d = datetime.datetime(int(a), int(mo), int(j), int(h), int(mi), int(s), tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    t = d.timestamp() + (float("0." + frac) if frac else 0.0)
    if tz and tz.upper() != "Z":
        signe = 1 if tz[0] == "+" else -1
        chiffres = tz[1:].replace(":", "")
        t -= signe * (int(chiffres[:2]) * 3600 + int(chiffres[2:]) * 60)
    return t


def _champ(l: dict, attendu: str) -> bool:
    champ = l.get("_field")
    return champ is None or champ == attendu


def depuis_influx(lignes_system: list[dict], lignes_upsd: list[dict]) -> list[dict]:
    """Évènements passés reconstitués depuis InfluxDB, triés par heure.

    ``lignes_system`` : bucket ``proxmox``, mesure ``system``, champ ``uptime`` (tags ``vmid``,
    ``object`` = ``lxc``/``qemu``, ``host`` = nom de l'invité) ; un passage > 0 -> 0 est une panne,
    0 -> > 0 un retour. ``lignes_upsd`` : bucket ``homelab``, mesure ``upsd``, champ
    ``input_voltage`` (sous 180 V = sur batterie). Les lignes d'un autre champ, sans heure ou
    sans valeur sont ignorées ; le premier échantillon de chaque série ne sert que de base.
    """
    evts: list[dict] = []

    series: dict[str, list[tuple[float, float, dict]]] = {}
    for l in lignes_system or []:
        if not isinstance(l, dict) or not _champ(l, "uptime"):
            continue
        t, v = _horodatage(l.get("_time")), _nombre(l.get("_value"))
        vmid = _nombre(l.get("vmid"))
        if t is None or v is None or vmid is None or not vmid.is_integer():
            continue
        prefixe = "vm" if str(l.get("object", "")).lower() == "qemu" else "ct"
        id_ = f"{prefixe}-{int(vmid)}"
        series.setdefault(id_, []).append((t, v, l))
    for id_, points in series.items():
        points.sort(key=lambda p: p[0])
        precedent = None
        for t, v, l in points:
            nom = next((l.get(k) for k in ("host", "name") if isinstance(l.get(k), str) and l.get(k)), id_)
            n = {"id": id_, "nom": nom, "type": id_[:2], "details": {"vmid": int(id_.split("-")[1])}}
            if precedent is not None:
                if precedent > 0 and v == 0:
                    evts.append(_evt(t, n, "panne", _importance(n), _texte_etat(n, "panne")))
                elif precedent == 0 and v > 0:
                    evts.append(_evt(t, n, "retour", _importance(n), _texte_etat(n, "retour")))
            precedent = v

    onduleur = {"id": "onduleur", "nom": inv.EQUIPEMENTS["onduleur"]["nom"], "type": "onduleur"}
    points_ups = []
    for l in lignes_upsd or []:
        if not isinstance(l, dict) or not _champ(l, "input_voltage"):
            continue
        t, v = _horodatage(l.get("_time")), _nombre(l.get("_value"))
        if t is not None and v is not None:
            points_ups.append((t, v))
    points_ups.sort()
    secteur = None
    for t, v in points_ups:
        maintenant = v > SECTEUR_MIN_V
        if secteur is True and not maintenant:
            evts.append(_evt(t, onduleur, "batterie", 4, "Onduleur sur batterie"))
        elif secteur is False and maintenant:
            evts.append(_evt(t, onduleur, "secteur", 4, "Courant revenu"))
        secteur = maintenant

    evts.sort(key=lambda e: e["t"])
    return evts
