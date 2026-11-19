"""Historique : instantanés compressés et journal d'évènements dans SQLite.

Tables :

- ``instantanes (t REAL PRIMARY KEY, donnees BLOB)`` : JSON de l'instantané compressé par zlib
  (le collecteur en enregistre un toutes les 10 s) ;
- ``evenements (t, id_noeud, nom, nature, importance, texte)`` : unique sur
  ``(t, id_noeud, nature, texte)``, un évènement déjà présent est ignoré (reconstitution
  InfluxDB relancée, double envoi).

Rétention (``purger``) : tout sur 48 h, puis le premier instantané de chaque minute jusqu'à
30 jours, rien au-delà ; évènements gardés 30 jours.

Une seule connexion, protégée par un verrou : le collecteur écrit depuis son thread, le
serveur HTTP lit depuis les siens. ``fermer()`` la libère (nécessaire sous Windows pour
supprimer le fichier).
"""

from __future__ import annotations

import json
import math
import sqlite3
import threading
import zlib

from .evenements import ESPACE

H = 3600.0
J = 86400.0
TOUT_GARDER_S = 48 * H
RETENTION_S = 30 * J
PAS_ANCIEN_S = 60.0

_CHAMPS = ("t", "id", "nom", "nature", "importance", "texte")


def _duree(s: float) -> str:
    """19 min, 3 h 07, 2 j 5 h (espaces insécables)."""
    m = max(1, int(round(s / 60)))
    if m < 60:
        return f"{m}{ESPACE}min"
    if m < 24 * 60:
        return f"{m // 60}{ESPACE}h{ESPACE}{m % 60:02d}"
    h = m // 60
    return f"{h // 24}{ESPACE}j{ESPACE}{h % 24}{ESPACE}h"


def _fini(x: object) -> float | None:
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    x = float(x)
    return x if math.isfinite(x) else None


class Historique:
    """Instantanés et évènements persistants dans la base SQLite ``chemin_db``."""

    def __init__(self, chemin_db: str):
        self._verrou = threading.Lock()
        self._c = sqlite3.connect(chemin_db, timeout=10, check_same_thread=False)
        with self._verrou, self._c:
            if chemin_db != ":memory:":
                self._c.execute("PRAGMA journal_mode=WAL")
            self._c.execute("PRAGMA synchronous=NORMAL")
            self._c.execute("CREATE TABLE IF NOT EXISTS instantanes (t REAL PRIMARY KEY, donnees BLOB NOT NULL)")
            self._c.execute(
                "CREATE TABLE IF NOT EXISTS evenements ("
                " t REAL NOT NULL, id_noeud TEXT NOT NULL, nom TEXT NOT NULL, nature TEXT NOT NULL,"
                " importance INTEGER NOT NULL, texte TEXT NOT NULL,"
                " UNIQUE (t, id_noeud, nature, texte))"
            )
            self._c.execute("CREATE INDEX IF NOT EXISTS evenements_t ON evenements (t)")

    def fermer(self) -> None:
        with self._verrou:
            if self._c is not None:
                self._c.close()
                self._c = None

    def __enter__(self) -> "Historique":
        return self

    def __exit__(self, *exc) -> None:
        self.fermer()

    # ----------------------------------------------------------------- écriture

    def enregistrer(self, inst: dict) -> None:
        """Enregistre un instantané (même ``t`` = remplacé)."""
        t = _fini(inst.get("t")) if isinstance(inst, dict) else None
        if t is None:
            return
        donnees = zlib.compress(json.dumps(inst, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)
        with self._verrou, self._c:
            self._c.execute("INSERT OR REPLACE INTO instantanes (t, donnees) VALUES (?, ?)", (t, donnees))

    def ajouter(self, evts: list[dict]) -> None:
        """Ajoute des évènements ; ceux qui sont mal formés ou déjà présents sont ignorés."""
        lignes = []
        for e in evts or []:
            if not isinstance(e, dict):
                continue
            t, imp = _fini(e.get("t")), e.get("importance")
            if t is None or not isinstance(imp, int) or isinstance(imp, bool):
                continue
            if not all(isinstance(e.get(k), str) for k in ("id", "nom", "nature", "texte")):
                continue
            lignes.append((t, e["id"], e["nom"], e["nature"], imp, e["texte"]))
        if not lignes:
            return
        with self._verrou, self._c:
            self._c.executemany(
                "INSERT OR IGNORE INTO evenements (t, id_noeud, nom, nature, importance, texte) VALUES (?, ?, ?, ?, ?, ?)",
                lignes,
            )

    def purger(self, maintenant: float) -> None:
        """Tout sur 48 h, un instantané par minute de 48 h à 30 jours, rien au-delà."""
        limite_tout = maintenant - TOUT_GARDER_S
        limite_retention = maintenant - RETENTION_S
        with self._verrou, self._c:
            self._c.execute("DELETE FROM instantanes WHERE t < ?", (limite_retention,))
            self._c.execute(
                "DELETE FROM instantanes WHERE t >= ?1 AND t < ?2 AND t NOT IN ("
                " SELECT MIN(t) FROM instantanes WHERE t >= ?1 AND t < ?2"
                " GROUP BY CAST(t / ?3 AS INTEGER))",
                (limite_retention, limite_tout, PAS_ANCIEN_S),
            )
            self._c.execute("DELETE FROM evenements WHERE t < ?", (limite_retention,))

    # ----------------------------------------------------------------- lecture

    def evenements(self, de: float, a: float) -> list[dict]:
        """Évènements avec ``de <= t <= a``, du plus ancien au plus récent."""
        with self._verrou:
            lignes = self._c.execute(
                "SELECT t, id_noeud, nom, nature, importance, texte FROM evenements"
                " WHERE t >= ? AND t <= ? ORDER BY t, rowid",
                (float(de), float(a)),
            ).fetchall()
        return [dict(zip(_CHAMPS, l)) for l in lignes]

    def instant(self, t: float) -> dict | None:
        """Dernier instantané enregistré à ``t`` ou avant, ``None`` s'il n'y en a pas."""
        with self._verrou:
            ligne = self._c.execute(
                "SELECT donnees FROM instantanes WHERE t <= ? ORDER BY t DESC LIMIT 1", (float(t),)
            ).fetchone()
        if ligne is None:
            return None
        try:
            return json.loads(zlib.decompress(ligne[0]).decode("utf-8"))
        except (zlib.error, UnicodeDecodeError, ValueError):
            return None

    def bornes(self) -> tuple[float | None, float | None]:
        """(plus ancien, plus récent) sur les instantanés et les évènements (reconstitués compris)."""
        with self._verrou:
            i = self._c.execute("SELECT MIN(t), MAX(t) FROM instantanes").fetchone()
            e = self._c.execute("SELECT MIN(t), MAX(t) FROM evenements").fetchone()
        mins = [x for x in (i[0], e[0]) if x is not None]
        maxs = [x for x in (i[1], e[1]) if x is not None]
        return (min(mins) if mins else None, max(maxs) if maxs else None)

    def _dernier_instantane(self) -> float | None:
        with self._verrou:
            return self._c.execute("SELECT MAX(t) FROM instantanes").fetchone()[0]

    def trou_au_demarrage(self, maintenant: float, seuil=60) -> dict | None:
        """Évènement « Abysse injoignable N min » (importance 4) si le dernier instantané a plus de ``seuil`` s.

        Le ping est placé au début du trou (heure du dernier instantané). À ajouter par
        l'appelant (``ajouter``) au démarrage.
        """
        dernier = self._dernier_instantane()
        if dernier is None:
            return None
        ecart = maintenant - dernier
        if ecart <= seuil:
            return None
        return {"t": dernier, "id": "abysse", "nom": "Abysse", "nature": "panne", "importance": 4,
                "texte": f"Abysse injoignable {_duree(ecart)}"}
