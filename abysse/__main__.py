"""Lancement : ``python -m abysse [--demo] [--port N] [--hote H]``.

La configuration vient de l'environnement (``ABYSSE_*``, voir ``config.py``) ; les options de
la ligne de commande la complètent. En démo sans ``ABYSSE_BASE``, la base SQLite est un fichier
temporaire supprimé à l'arrêt, et le serveur n'écoute que sur 127.0.0.1 sauf ``--hote``.
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
import os
import signal
import sys
import tempfile
import threading
import time

from . import __version__, demo, inventaire
from .collecteur import Collecteur
from .config import PREFIXE, Config, charger_config
from .historique import Historique
from .reglages import Reglages
from .serveur import creer_serveur

journal = logging.getLogger("abysse")


def _cles_inconnues(env: dict[str, str]) -> list[str]:
    connues = {PREFIXE + f.name.upper() for f in dataclasses.fields(Config)}
    return sorted(k for k in env if k.startswith(PREFIXE) and k not in connues)


def _supprimer_base(chemin: str) -> None:
    for suffixe in ("", "-wal", "-shm", "-journal"):
        try:
            os.remove(chemin + suffixe)
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m abysse", description="Abysse : carte vivante du homelab.")
    parser.add_argument("--demo", action="store_true", help="fausses données réalistes, sans toucher à l'infra")
    parser.add_argument("--port", type=int, help="port d'écoute (défaut : ABYSSE_ECOUTE_PORT ou 80)")
    parser.add_argument("--hote", help="adresse d'écoute (défaut : ABYSSE_ECOUTE_HOTE ou 0.0.0.0)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")
    env = dict(os.environ)
    for cle in _cles_inconnues(env):
        journal.warning("clé de configuration inconnue ignorée : %s", cle)  # le nom seul, jamais la valeur
    try:
        cfg = charger_config(env)
    except ValueError as e:
        print(f"Configuration invalide : {e}", file=sys.stderr)
        return 2

    changements: dict[str, object] = {}
    if args.demo:
        changements["demo"] = True
    if args.port is not None:
        if not 0 <= args.port <= 65535:
            parser.error("port hors de 0-65535")
        changements["ecoute_port"] = args.port
    if args.hote is not None:
        changements["ecoute_hote"] = args.hote
    cfg = dataclasses.replace(cfg, **changements)

    if cfg.inventaire and not cfg.demo:
        try:
            inventaire.charger(cfg.inventaire)
        except (OSError, ValueError) as e:
            print(f"Inventaire invalide ({cfg.inventaire}) : {e}", file=sys.stderr)
            return 2

    base_temporaire = None
    if cfg.demo:
        if PREFIXE + "BASE" not in env:
            fd, base_temporaire = tempfile.mkstemp(prefix="abysse-demo-", suffix=".db")
            os.close(fd)
            cfg = dataclasses.replace(cfg, base=base_temporaire)
        if args.hote is None and PREFIXE + "ECOUTE_HOTE" not in env:
            cfg = dataclasses.replace(cfg, ecoute_hote="127.0.0.1")

    reglages = Reglages(cfg.base)
    historique = Historique(cfg.base)
    collecteur = serveur = None
    try:
        if cfg.demo:
            if historique.bornes() == (None, None):
                debut = time.monotonic()
                demo.remplir_historique(historique, time.time())
                journal.info("historique de démo rempli en %.1f s", time.monotonic() - debut)
            collecteur = Collecteur(cfg, reglages, historique, sources=demo.sources_demo(), sites=demo.SITES)
        else:
            collecteur = Collecteur(cfg, reglages, historique)
        sources = ", ".join(f"{nom} ({p:g} s)" for nom, p in collecteur.periodes().items()) or "aucune"
        journal.info("Abysse %s%s, sources : %s", __version__, " (démo)" if cfg.demo else "", sources)
        serveur = creer_serveur(cfg, collecteur, reglages, historique)
        collecteur.demarrer()

        def terminer(*_):
            threading.Thread(target=serveur.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, terminer)
        hote, port = serveur.server_address[:2]
        journal.info("en écoute sur http://%s:%d", "localhost" if hote in ("127.0.0.1", "0.0.0.0") else hote, port)
        try:
            serveur.serve_forever()
        except KeyboardInterrupt:
            pass
    except OSError as e:
        journal.error("démarrage impossible : %s", e.strerror or type(e).__name__)
        return 1
    finally:
        if collecteur is not None:
            collecteur.arreter()
        if serveur is not None:
            serveur.server_close()
        historique.fermer()
        if base_temporaire:
            _supprimer_base(base_temporaire)
    return 0


if __name__ == "__main__":
    sys.exit(main())
