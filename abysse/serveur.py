"""Serveur HTTP d'Abysse : fichiers statiques, API JSON et flux SSE (bibliothèque standard).

Routes :

- ``GET /`` et les fichiers de ``cfg.dossier_web`` (types MIME fixés ici, jamais ceux du
  registre Windows ; tout chemin qui sort du dossier, caché ou bizarre = 404) ;
- ``GET /api/etat`` : dernier instantané ;
- ``GET /api/flux`` : SSE, ``retry: 2000``, ``event: etat`` / ``event: evenement`` avec
  ``data:`` JSON, commentaire ``: ping`` toutes les 15 s sans message ;
- ``GET /api/historique?de=&a=`` : ``{"bornes": [min, max], "evenements": [...]}`` (24 h par défaut) ;
- ``GET /api/instant?t=`` : instantané enregistré à ``t`` ou avant, 404 sinon ;
- ``GET /api/reglages``, ``POST /api/reglages`` (JSON ≤ 16 Kio, ``Content-Type: application/json``,
  400 ``{"erreur": "..."}`` en français si la modification est refusée) ;
- ``GET /api/sante`` : ``{"ok": true, "sources": {...}}``, construit à la main (``Config`` n'est
  jamais sérialisée : elle contient les secrets).

Toutes les réponses portent la CSP, ``X-Content-Type-Options: nosniff`` et
``Referrer-Policy: no-referrer``.
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

journal = logging.getLogger("abysse.http")

CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
TAILLE_MAX_POST = 16 * 1024
PING_S = 15.0
RETRY_MS = 2000
JOUR = 86400.0
FENETRE_MAX_S = 31 * JOUR

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}

_DECONNEXIONS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)


class ErreurRequete(Exception):
    """Réponse d'erreur JSON ``{"erreur": message}`` (message en français, sans donnée saisie)."""

    def __init__(self, statut: int, message: str) -> None:
        super().__init__(message)
        self.statut = statut
        self.message = message


def _json(objet: object) -> bytes:
    return json.dumps(objet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _evenement_sse(nature: str, donnee: object) -> bytes:
    # json.dumps n'émet jamais de saut de ligne brut : une seule ligne data: suffit.
    return b"event: " + nature.encode("ascii") + b"\ndata: " + _json(donnee) + b"\n\n"


def _nombre(requete: dict, cle: str, defaut: float | None = None) -> float | None:
    valeurs = requete.get(cle)
    if not valeurs or valeurs[-1] == "":
        if defaut is None:
            raise ErreurRequete(400, f"Paramètre « {cle} » manquant.")
        return defaut
    try:
        n = float(valeurs[-1])
    except ValueError:
        raise ErreurRequete(400, f"Paramètre « {cle} » invalide : un nombre est attendu.") from None
    if not math.isfinite(n):
        raise ErreurRequete(400, f"Paramètre « {cle} » invalide : un nombre est attendu.")
    return n


def _fichier_statique(racine: str, chemin_url: str) -> str | None:
    """Chemin réel du fichier demandé, ``None`` s'il n'existe pas ou sort de ``racine``."""
    try:
        chemin = urllib.parse.unquote(chemin_url, errors="strict")
    except UnicodeDecodeError:
        return None
    if chemin in ("", "/"):
        chemin = "/index.html"
    if not chemin.startswith("/") or chemin.startswith("//"):
        return None
    if "\\" in chemin or "\x00" in chemin or ":" in chemin:
        return None  # séparateurs et lecteurs Windows, flux NTFS
    morceaux = chemin[1:].split("/")
    if any(m in ("", ".", "..") or m.startswith(".") for m in morceaux):
        return None  # .., fichiers cachés, doubles barres
    complet = os.path.realpath(os.path.join(racine, *morceaux))
    try:
        dedans = os.path.commonpath([complet, racine]) == racine
    except ValueError:  # autre lecteur (Windows)
        return None
    if not dedans or not os.path.isfile(complet):
        return None
    return complet


class _Gestionnaire(BaseHTTPRequestHandler):
    server_version = "Abysse"
    sys_version = ""
    timeout = 30  # lecture d'une requête ; protège des clients qui n'envoient rien

    # Renseignés par creer_serveur (sous-classe).
    cfg = None
    collecteur = None
    reglages = None
    historique = None
    racine = ""

    # ----------------------------------------------------------------- outils

    def version_string(self) -> str:
        return self.server_version  # ni version de Python ni espace traînante

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - signature imposée
        journal.info("%s %s", self.address_string(), format % args)

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def _envoyer(self, statut: int, corps: bytes, type_: str, cache: str = "no-store") -> None:
        self.send_response(statut)
        self.send_header("Content-Type", type_)
        self.send_header("Content-Length", str(len(corps)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corps)

    def _envoyer_json(self, statut: int, objet: object) -> None:
        self._envoyer(statut, _json(objet), "application/json; charset=utf-8")

    def _erreur(self, statut: int, message: str) -> None:
        self._envoyer_json(statut, {"erreur": message})

    def _decouper(self) -> tuple[str, dict]:
        # Pas d'urlsplit : « //etc/passwd » y serait lu comme un nom d'hôte.
        chemin, _, requete = self.path.partition("?")
        chemin = chemin.split("#", 1)[0]
        return chemin, urllib.parse.parse_qs(requete, keep_blank_values=True)

    def _traiter(self, fonction) -> None:
        try:
            fonction()
        except ErreurRequete as e:
            self._erreur(e.statut, e.message)
        except _DECONNEXIONS:
            pass  # le navigateur est parti
        except Exception:  # noqa: BLE001
            journal.exception("erreur interne sur %s", self.command)
            try:
                self._erreur(500, "Erreur interne du serveur.")
            except _DECONNEXIONS:
                pass

    # ----------------------------------------------------------------- méthodes

    def do_GET(self) -> None:  # noqa: N802 - API http.server
        self._traiter(self._get)

    def do_HEAD(self) -> None:  # noqa: N802
        self._traiter(self._get)

    def do_POST(self) -> None:  # noqa: N802
        self._traiter(self._post)

    def _non_autorise(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD, POST")
        corps = _json({"erreur": "Méthode non autorisée."})
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _non_autorise  # noqa: N815

    # ----------------------------------------------------------------- GET

    def _get(self) -> None:
        chemin, requete = self._decouper()
        routes = {
            "/api/etat": self._etat,
            "/api/flux": self._flux,
            "/api/historique": lambda: self._historique(requete),
            "/api/instant": lambda: self._instant(requete),
            "/api/reglages": lambda: self._envoyer_json(200, self.reglages.en_dict()),
            "/api/sante": self._sante,
        }
        if chemin in routes:
            routes[chemin]()
        elif chemin.startswith("/api/"):
            raise ErreurRequete(404, "Adresse d'API inconnue.")
        else:
            self._statique(chemin)

    def _statique(self, chemin: str) -> None:
        fichier = _fichier_statique(self.racine, chemin)
        if fichier is None:
            self._envoyer(404, "Page introuvable.".encode("utf-8"), "text/plain; charset=utf-8")
            return
        type_ = TYPES.get(os.path.splitext(fichier)[1].lower(), "application/octet-stream")
        with open(fichier, "rb") as f:
            corps = f.read()
        self._envoyer(200, corps, type_, cache="no-cache")

    def _etat(self) -> None:
        self._envoyer_json(200, self.collecteur.instantane())

    def _sante(self) -> None:
        inst = self.collecteur.instantane()
        sources = inst.get("sources") if isinstance(inst, dict) else None
        self._envoyer_json(200, {"ok": True, "sources": dict(sources or {}), "t": inst.get("t")})

    def _historique(self, requete: dict) -> None:
        a = _nombre(requete, "a", time.time())
        de = _nombre(requete, "de", a - JOUR)
        if de > a:
            raise ErreurRequete(400, "« de » doit précéder « a ».")
        if a - de > FENETRE_MAX_S:
            de = a - FENETRE_MAX_S
        bornes = list(self.historique.bornes())
        self._envoyer_json(200, {"bornes": bornes, "evenements": self.historique.evenements(de, a)})

    def _instant(self, requete: dict) -> None:
        t = _nombre(requete, "t")
        inst = self.historique.instant(t)
        if inst is None:
            raise ErreurRequete(404, "Aucun instantané enregistré à cet instant.")
        self._envoyer_json(200, inst)

    def _flux(self) -> None:
        q = self.collecteur.abonner()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            if self.command == "HEAD":
                return
            self.wfile.write(f"retry: {RETRY_MS}\n\n".encode("ascii"))
            self.wfile.write(_evenement_sse("etat", self.collecteur.instantane()))
            self.wfile.flush()
            while not getattr(self.server, "arret", False):
                try:
                    nature, donnee = q.get(timeout=PING_S)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if nature == "fin":
                    break
                self.wfile.write(_evenement_sse(nature, donnee))
                self.wfile.flush()
        except (*_DECONNEXIONS, OSError):
            pass
        finally:
            self.collecteur.desabonner(q)

    # ----------------------------------------------------------------- POST

    def _post(self) -> None:
        chemin, _ = self._decouper()
        if chemin == "/api/actualiser":
            self.close_connection = True
            if self.headers.get("X-Abysse") != "1":
                raise ErreurRequete(403, "En-tête X-Abysse manquant.")
            actualiser = getattr(self.collecteur, "actualiser_tout", None)
            if not callable(actualiser):
                raise ErreurRequete(503, "Actualisation indisponible.")
            self._envoyer_json(200, actualiser())
            return
        if chemin != "/api/reglages":
            self.close_connection = True
            if chemin.startswith("/api/"):
                self._non_autorise()
            else:
                raise ErreurRequete(405, "Méthode non autorisée.")
            return
        self.close_connection = True  # corps non lu en cas de refus : ne pas réutiliser la connexion
        type_ = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if type_ != "application/json":
            raise ErreurRequete(415, "Le corps de la requête doit être du JSON (Content-Type: application/json).")
        try:
            longueur = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise ErreurRequete(411, "Longueur du corps (Content-Length) manquante ou invalide.") from None
        if longueur < 0:
            raise ErreurRequete(400, "Longueur du corps invalide.")
        if longueur > TAILLE_MAX_POST:
            raise ErreurRequete(413, "Requête trop volumineuse (16 Kio au plus).")
        brut = self.rfile.read(longueur)
        if len(brut) != longueur:
            raise ErreurRequete(400, "Corps de la requête incomplet.")
        try:
            modif = json.loads(brut.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ErreurRequete(400, "JSON invalide.") from None
        try:
            self.reglages.appliquer(modif)
        except ValueError as e:
            raise ErreurRequete(400, str(e)) from None
        reveiller = getattr(self.collecteur, "reveiller", None)
        if callable(reveiller):
            reveiller()
        self._envoyer_json(200, self.reglages.en_dict())


class _Serveur(ThreadingHTTPServer):
    daemon_threads = True
    # Sous Windows, SO_REUSEADDR laisse deux serveurs écouter le même port sans erreur.
    allow_reuse_address = os.name != "nt"
    arret = False

    def shutdown(self) -> None:
        self.arret = True
        super().shutdown()


def creer_serveur(cfg, collecteur, reglages, historique) -> ThreadingHTTPServer:
    """Serveur prêt à ``serve_forever()`` sur ``cfg.ecoute_hote:cfg.ecoute_port``."""
    racine = os.path.realpath(cfg.dossier_web)
    gestionnaire = type("Gestionnaire", (_Gestionnaire,), {
        "cfg": cfg, "collecteur": collecteur, "reglages": reglages, "historique": historique,
        "racine": racine,
    })
    return _Serveur((cfg.ecoute_hote, cfg.ecoute_port), gestionnaire)


__all__ = ["CSP", "creer_serveur"]
