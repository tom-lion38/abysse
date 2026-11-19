"""Collecteur : interroge les sources en tâche de fond et construit l'instantané chaque seconde.

Chaque source tourne dans son propre thread, à sa période, et garde sa dernière lecture
réussie avec son heure de lecture. Une lecture plus vieille que ``PERIMES`` périodes devient
``None`` (source en erreur : ses nœuds passent ``inconnu``, jamais ``off``) ; un échec isolé
ne change donc rien à l'affichage.

Au démarrage, le premier instantané attend la première tentative de chaque source (au plus
``ATTENTE_DEMARRAGE_S``) : construit avant toute lecture, il n'aurait ni CT/VM ni appareil, et
un navigateur qui se reconnecte à ce moment-là disposerait la carte sans les invités.

La boucle principale (1 s) :

1. assemble les dernières lectures au format ``brut`` attendu par ``modele`` (``assembler``) ;
2. construit l'instantané, le compare au précédent (``evenements.comparer``), sauf au tour où
   une source livre sa toute première lecture : elle ne fait que révéler l'état existant
   (appareils déjà branchés…), ce n'est pas un changement ;
3. pousse ``("etat", inst)`` puis chaque ``("evenement", e)`` aux abonnés (file bornée par
   abonné : un navigateur lent perd les plus anciens messages, il ne bloque personne) ;
4. ajoute les évènements à l'historique, y enregistre un instantané sur 10, purge toutes les
   heures.

Noms des sources (clés de ``sources``) : ``mikrotik`` (rapide), ``mikrotik_lent``, ``proxmox``,
``proxmox_configs``, ``nut``, ``influx``, ``truenas``. Les messages des erreurs sont journalisés
seulement pour ``ErreurSource`` (garantis sans secret) ; pour toute autre exception, seul
son type est écrit.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.request
from collections.abc import Callable, Iterable

from . import evenements, sites as sites_mod
from .debit import CompteurDebit
from .modele import construire_instantane
from .sources import ErreurSource, influx, mikrotik, nut, proxmox, truenas

journal = logging.getLogger("abysse.collecteur")

PERIMES = 3  # une lecture plus vieille que 3 périodes ne compte plus
ENREGISTRER_TOUS = 10  # un instantané sur 10 dans l'historique (toutes les 10 s)
PURGE_S = 3600.0
REESSAI_MAX_S = 5.0  # après un échec, nouvelle tentative au plus tard 5 s plus tard
# Premier instantané : attente maximale des premières lectures (sous les 5 s au-delà desquelles
# le navigateur affiche « Connexion perdue » ; une source plus lente part en « inconnu »).
ATTENTE_DEMARRAGE_S = 4.0
TAILLE_FILE = 64
FIN = ("fin", None)

NOMS_SOURCES = ("mikrotik", "mikrotik_lent", "proxmox", "proxmox_configs", "nut", "influx", "truenas")
_CLES_LENT = ("ressource", "arp", "baux", "hotes_pont", "dhcp_client")
# MikroTik : chaque requête REST ouvre une session, et RouterOS en garde une petite part
# (constaté sur RouterOS 7) : lecture rapide (interfaces seules) toutes les 2 s,
# lecture lente (ressources, ARP, DHCP, pont) toutes les 30 s. Voir ``sources/mikrotik.py``.
MIKROTIK_RAPIDE_S = 2.0
MIKROTIK_LENT_S = 30.0
_TYPES_INVITES = ("lxc", "qemu")


# --------------------------------------------------------------------------- assemblage

def assembler(lectures: dict[str, tuple[object, float | None]], sites: list | None) -> dict:
    """``brut`` pour ``construire_instantane`` depuis ``{nom: (données ou None, t_lecture)}``.

    Clé absente de ``lectures`` = source désactivée (clé absente de ``brut``) ; données
    ``None`` = source en erreur. La lecture lente du MikroTik et les configurations Proxmox
    complètent la lecture principale quand elles sont disponibles.
    """
    brut: dict = {"sites": list(sites or [])}

    def donnees(nom: str) -> object:
        return lectures.get(nom, (None, None))[0]

    if "mikrotik" in lectures:
        d, t = lectures["mikrotik"]
        if isinstance(d, dict):
            m = dict(d)
            lent = donnees("mikrotik_lent")
            if isinstance(lent, dict):
                for cle in _CLES_LENT:
                    if cle in lent:
                        m[cle] = lent[cle]
            if t is not None:
                m["t"] = t
            brut["mikrotik"] = m
        else:
            brut["mikrotik"] = None

    if "proxmox" in lectures:
        d, t = lectures["proxmox"]
        if isinstance(d, dict):
            p = dict(d)
            configs = donnees("proxmox_configs")
            if isinstance(configs, dict):
                p["configs"] = configs
            if t is not None:
                p["t"] = t
            brut["proxmox"] = p
        else:
            brut["proxmox"] = None

    for nom in ("nut", "influx", "truenas"):
        if nom in lectures:
            d = lectures[nom][0]
            brut[nom] = d if isinstance(d, dict) else None
    return brut


# --------------------------------------------------------------------------- InfluxDB (passé)

FLUX_UPSD = """from(bucket: "homelab")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "upsd" and r._field == "input_voltage")
  |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field"])"""

FLUX_UPTIME = """from(bucket: "proxmox")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "system" and r._field == "uptime" and r.vmid == "%d")
  |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_field", "vmid", "object", "host"])"""


def reconstituer_depuis_influx(requete: Callable[[str], list], vmids: Iterable[int]) -> list[dict]:
    """Évènements des 30 derniers jours (pannes/retours des invités, passages sur batterie).

    Une requête par invité, pour borner la mémoire (30 j × 1 point/min par série). Une
    requête qui échoue est sautée (journalisée), les autres continuent.
    """
    evts: list[dict] = []
    try:
        evts.extend(evenements.depuis_influx([], requete(FLUX_UPSD)))
    except ErreurSource as e:
        journal.warning("reconstitution InfluxDB (onduleur) impossible : %s", e)
    for vmid in sorted({int(v) for v in vmids}):
        try:
            lignes = requete(FLUX_UPTIME % vmid)
        except ErreurSource as e:
            journal.warning("reconstitution InfluxDB (invité %d) impossible : %s", vmid, e)
            continue
        evts.extend(evenements.depuis_influx(lignes, []))
    evts.sort(key=lambda e: e["t"])
    return evts


# --------------------------------------------------------------------------- sources

class _Source:
    def __init__(self, nom: str, fonction: Callable[[], dict], periode: float) -> None:
        self.nom = nom
        self.fonction = fonction
        self.periode = float(periode)
        self.donnees: object = None
        self.t_lecture: float | None = None
        self.erreur: str | None = None
        self.reveil = threading.Event()
        self.fil: threading.Thread | None = None
        self.essayee = threading.Event()  # première tentative terminée (réussie ou non)
        self.connue = False  # une lecture réussie a déjà servi à un instantané

    def lecture(self, maintenant: float) -> tuple[object, float | None]:
        if self.donnees is None or self.t_lecture is None:
            return None, self.t_lecture
        if maintenant - self.t_lecture > PERIMES * self.periode:
            return None, self.t_lecture
        return self.donnees, self.t_lecture


def _description(e: BaseException) -> str:
    """Texte journalisable d'une erreur : message d'``ErreurSource`` (sans secret), sinon le type seul."""
    if isinstance(e, ErreurSource):
        return str(e)
    return f"erreur inattendue ({type(e).__name__})"


class Collecteur:
    """Lit les sources en tâche de fond et publie un instantané par seconde.

    ``sources`` : ``{nom: (fonction() -> dict, periode_s)}`` ; par défaut, les sources
    actives de ``cfg``. ``sites`` : liste issue de ``sites.json`` (par défaut lue depuis
    ``cfg.sites_json``). ``periode``, ``horloge`` et ``attente_demarrage`` servent aux tests.
    """

    def __init__(self, cfg, reglages, historique, sources: dict | None = None, *,
                 sites: list | None = None, periode: float = 1.0,
                 horloge: Callable[[], float] = time.time,
                 attente_demarrage: float = ATTENTE_DEMARRAGE_S) -> None:
        self.cfg = cfg
        self.reglages = reglages
        self.historique = historique
        self._defaut = sources is None
        self._periode = float(periode)
        self._horloge = horloge
        self._attente_demarrage = max(0.0, float(attente_demarrage))
        self._sites = list(sites) if sites is not None else (
            sites_mod.charger_sites(self._cache_sites()) or sites_mod.charger_sites(cfg.sites_json))
        self._debits = CompteurDebit()
        self._verrou = threading.Lock()
        self._verrou_tour = threading.Lock()
        self._arret = threading.Event()
        self._reveil_tour = threading.Event()
        self._abonnes: list[queue.Queue] = []
        self._inst: dict | None = None
        self._precedent: dict | None = None
        self._tours = 0
        self._derniere_purge: float | None = None
        self._vmids_demandes: set[int] = set()
        self._fils: list[threading.Thread] = []
        self._demarre = False
        if sources is None:
            sources = self._sources_par_defaut()
        self._sources: dict[str, _Source] = {}
        for nom, (fonction, per) in sources.items():
            if per is None or float(per) <= 0:
                raise ValueError(f"période invalide pour la source {nom!r}")
            self._sources[nom] = _Source(nom, fonction, per)

    # ----------------------------------------------------------------- sources par défaut

    def _sources_par_defaut(self) -> dict:
        cfg = self.cfg
        s: dict = {}
        if cfg.source_active("mikrotik"):
            s["mikrotik"] = (lambda: mikrotik.lire_rapide(cfg), MIKROTIK_RAPIDE_S)
            s["mikrotik_lent"] = (lambda: mikrotik.lire_lent(cfg), MIKROTIK_LENT_S)
        if cfg.source_active("proxmox"):
            s["proxmox"] = (lambda: proxmox.lire(cfg), 2)
            s["proxmox_configs"] = (self.lire_configs, 300)
        if cfg.source_active("nut"):
            s["nut"] = (lambda: nut.lire(cfg.nut_hote, cfg.nut_port, cfg.nut_ups), 2)
        if cfg.source_active("influx"):
            s["influx"] = (lambda: influx.lire(cfg), 30)
        # TrueNAS sans clé API : rien à lire. Toutes les 2 min : chaque lecture ouvre une
        # session (SCRAM) que TrueNAS journalise, et les pools changent lentement.
        if cfg.source_active("truenas") and cfg.truenas_cle.strip():
            s["truenas"] = (lambda: truenas.lire(cfg), 120)
        return s

    def periodes(self) -> dict[str, float]:
        """``{nom: période}`` des sources lues (pour le journal de démarrage et les tests)."""
        return {nom: s.periode for nom, s in self._sources.items()}

    def _invites_lus(self) -> dict[int, str]:
        """``{vmid: "lxc" | "qemu"}`` d'après la dernière lecture Proxmox (même périmée)."""
        s = self._sources.get("proxmox")
        with self._verrou:
            d = s.donnees if s is not None else None
        invites: dict[int, str] = {}
        if isinstance(d, dict) and isinstance(d.get("ressources"), list):
            for r in d["ressources"]:
                if not isinstance(r, dict) or r.get("type") not in _TYPES_INVITES:
                    continue
                if str(r.get("template", 0)) in ("1", "True", "true"):
                    continue
                try:
                    invites[int(r.get("vmid"))] = r["type"]
                except (TypeError, ValueError):
                    continue
        return invites

    def lire_configs(self) -> dict:
        """Configurations (``onboot``, IP) des invités vus par la dernière lecture Proxmox."""
        invites = self._invites_lus()
        if not invites:
            raise ErreurSource("Proxmox : invités pas encore lus")
        with self._verrou:
            self._vmids_demandes = set(invites)
        return proxmox.lire_configs(self.cfg, invites)

    # ----------------------------------------------------------------- cycle de vie

    def demarrer(self) -> None:
        """Lance un thread par source et la boucle d'une seconde.

        Le premier instantané est construit dès que chaque source a fini sa première tentative
        (réussie ou non), au plus ``attente_demarrage`` secondes après le lancement.
        """
        if self._demarre:
            return
        self._demarre = True
        self._arret.clear()
        maintenant = self._horloge()
        reconstituer = False
        try:
            trou = self.historique.trou_au_demarrage(maintenant)
            if trou is not None:
                self.historique.ajouter([trou])
                journal.warning("%s (trou dans l'historique)", trou["texte"])
            reconstituer = self._defaut and "influx" in self._sources and self.historique.bornes() == (None, None)
        except Exception as e:  # noqa: BLE001 - l'historique ne doit pas empêcher de démarrer
            journal.error("historique illisible au démarrage : %s", type(e).__name__)
        for s in self._sources.values():
            s.fil = threading.Thread(target=self._boucle_source, args=(s,), name=f"abysse-{s.nom}", daemon=True)
            self._fils.append(s.fil)
            s.fil.start()
        self._attendre_premieres_lectures()
        self.tour()
        f = threading.Thread(target=self._boucle, name="abysse-collecteur", daemon=True)
        self._fils.append(f)
        f.start()
        if self._defaut and (getattr(self.cfg, "phare_url", "") or "").strip():
            def premiere_puis_boucle():
                try:
                    self.actualiser_sites()
                except ErreurSource as e:
                    journal.warning("%s", e)
                self._boucle_sites()
            f = threading.Thread(target=premiere_puis_boucle, name="abysse-sites", daemon=True)
            self._fils.append(f)
            f.start()
        if reconstituer:
            f = threading.Thread(target=self._reconstituer, name="abysse-reconstitution", daemon=True)
            self._fils.append(f)
            f.start()

    def arreter(self) -> None:
        """Arrête les threads et prévient les abonnés (``("fin", None)``)."""
        self._arret.set()
        self._reveil_tour.set()
        for s in self._sources.values():
            s.reveil.set()
        for f in self._fils:
            if f is not threading.current_thread():
                f.join(timeout=2)
        self._fils = []
        self._demarre = False
        with self._verrou:
            abonnes = list(self._abonnes)
        for q in abonnes:
            self._pousser(q, FIN)

    # ----------------------------------------------------------------- actualisation

    PERIODE_SITES_S = 600

    def _cache_sites(self) -> str:
        """Dernière liste reçue de Phare, à côté de la base (``/etc/abysse`` est en lecture seule)."""
        if not (getattr(self.cfg, "phare_url", "") or "").strip():
            return ""
        return os.path.join(os.path.dirname(self.cfg.base) or ".", "sites-phare.json")

    def actualiser_sites(self) -> int:
        """Relit la liste des sites auprès de Phare, qui lit le Caddyfile en direct.

        La liste reçue remplace celle en mémoire et est gardée dans ``sites-phare.json`` (à côté
        de la base) pour survivre à un redémarrage. Sans ``phare_url`` : relit simplement ``sites.json``.
        Renvoie le nombre de sites ; lève ``ErreurSource`` si Phare est injoignable.
        """
        url = (getattr(self.cfg, "phare_url", "") or "").strip().rstrip("/")
        if not url:
            self._sites = sites_mod.charger_sites(self.cfg.sites_json)
            return len(self._sites)
        try:
            with urllib.request.urlopen(url + "/api/abysse/sites", timeout=8) as r:
                donnees = json.loads(r.read(2_000_000).decode("utf-8"))
        except (OSError, ValueError) as e:
            raise ErreurSource(f"Phare injoignable ({type(e).__name__})") from None
        if not isinstance(donnees, list):
            raise ErreurSource("Phare : réponse inattendue")
        sites = [x for x in donnees if isinstance(x, dict) and isinstance(x.get("nom"), str)]
        if not sites:
            raise ErreurSource("Phare : liste de sites vide, ancienne liste gardée")
        self._sites = sites
        try:
            cache = self._cache_sites()
            with open(cache + ".tmp", "w", encoding="utf-8") as f:
                json.dump(sites, f, ensure_ascii=False, indent=2)
            os.replace(cache + ".tmp", cache)
        except OSError as e:
            journal.warning("cache des sites non écrit : %s", type(e).__name__)
        return len(sites)

    def actualiser_tout(self) -> dict:
        """Bouton « Actualiser » : sites relus, toutes les sources relancées tout de suite."""
        res: dict = {"ok": True}
        try:
            res["sites"] = self.actualiser_sites()
        except ErreurSource as e:
            res.update(ok=False, erreur=str(e), sites=len(self._sites))
        for src in self._sources.values():
            src.reveil.set()
        self.reveiller()
        return res

    def _boucle_sites(self) -> None:
        while not self._arret.wait(self.PERIODE_SITES_S):
            try:
                self.actualiser_sites()
            except ErreurSource as e:
                journal.warning("%s", e)

    def reveiller(self) -> None:
        """Avance le prochain instantané (après un changement de réglages, par exemple)."""
        self._reveil_tour.set()

    def _attendre_premieres_lectures(self) -> None:
        """Attend la fin de la première tentative de chaque source, au plus ``attente_demarrage`` s."""
        fin = time.monotonic() + self._attente_demarrage
        for s in self._sources.values():
            reste = fin - time.monotonic()
            if reste <= 0 or self._arret.is_set():
                return
            s.essayee.wait(reste)

    # ----------------------------------------------------------------- threads

    def _boucle_source(self, s: _Source) -> None:
        while not self._arret.is_set():
            debut = time.monotonic()
            try:
                d = s.fonction()
                if not isinstance(d, dict):
                    raise ErreurSource(f"{s.nom} : réponse inattendue")
            except Exception as e:  # noqa: BLE001 - une source ne doit jamais tuer son thread
                texte = _description(e)
                with self._verrou:
                    nouveau = texte != s.erreur
                    s.erreur = texte
                if nouveau:
                    journal.warning("source %s en erreur : %s", s.nom, texte)
                # Accès refusé : réessayer vite ne changera rien et remplirait le journal
                # d'audit de la cible (TrueNAS journalise chaque échec d'authentification).
                refus = isinstance(e, ErreurSource) and e.statut in (401, 403)
                attente = s.periode if refus else min(s.periode, REESSAI_MAX_S)
            else:
                t = self._horloge()
                with self._verrou:
                    revenue = s.erreur is not None
                    s.donnees, s.t_lecture, s.erreur = d, t, None
                if revenue:
                    journal.info("source %s de nouveau joignable", s.nom)
                attente = s.periode
            s.essayee.set()
            reste = attente - (time.monotonic() - debut)
            if reste > 0:
                s.reveil.wait(reste)
            s.reveil.clear()

    def _boucle(self) -> None:
        prochain = time.monotonic() + self._periode
        while not self._arret.is_set():
            reste = prochain - time.monotonic()
            if reste > 0:
                self._reveil_tour.wait(reste)
            self._reveil_tour.clear()
            if self._arret.is_set():
                break
            maintenant = time.monotonic()
            if maintenant >= prochain:
                # tour régulier : seul lui avance l'échéance ; un réveil anticipé
                # (reveiller()) ne doit pas repousser le prochain tour régulier.
                prochain = max(prochain + self._periode, maintenant + self._periode / 10)
            try:
                self.tour()
            except Exception:  # noqa: BLE001 - la boucle doit survivre à un bug du modèle
                journal.exception("échec de construction de l'instantané")

    def _reconstituer(self) -> None:
        """Premier démarrage (base vide) : évènements des 30 derniers jours depuis InfluxDB."""
        vmids: dict[int, str] = {}
        if "proxmox" in self._sources:
            fin = time.monotonic() + 60
            while not self._arret.is_set() and time.monotonic() < fin:
                vmids = self._invites_lus()
                if vmids:
                    break
                self._arret.wait(1)
        if self._arret.is_set():
            return
        cfg = self.cfg
        evts = reconstituer_depuis_influx(lambda flux: influx.requete(cfg, flux), vmids)
        try:
            self.historique.ajouter(evts)
        except Exception as e:  # noqa: BLE001
            journal.error("reconstitution non enregistrée : %s", type(e).__name__)
            return
        journal.info("historique reconstitué depuis InfluxDB : %d évènements", len(evts))

    # ----------------------------------------------------------------- instantané

    def tour(self) -> dict:
        """Construit et publie un instantané (appelé chaque seconde par la boucle)."""
        with self._verrou_tour:
            t = self._horloge()
            with self._verrou:
                lectures = {nom: s.lecture(t) for nom, s in self._sources.items()}
                # toute première lecture réussie d'une source : elle révèle l'état existant
                # (appareils déjà branchés, invités…), ce n'est pas un changement à signaler
                revelation = False
                for nom, s in self._sources.items():
                    if not s.connue and lectures[nom][0] is not None:
                        s.connue = revelation = True
            brut = assembler(lectures, self._sites)
            inst = construire_instantane(brut, self.reglages, self._debits, t)
            evts = [] if revelation else evenements.comparer(self._precedent, inst)
            self._precedent = inst
            with self._verrou:
                self._inst = inst
                abonnes = list(self._abonnes)
            for q in abonnes:
                self._pousser(q, ("etat", inst))
                for e in evts:
                    self._pousser(q, ("evenement", e))
            self._tours += 1
            try:
                if evts:
                    self.historique.ajouter(evts)
                if self._tours % ENREGISTRER_TOUS == 0:
                    self.historique.enregistrer(inst)
                if self._derniere_purge is None or t - self._derniere_purge >= PURGE_S:
                    self._derniere_purge = t
                    self.historique.purger(t)
            except Exception as e:  # noqa: BLE001 - disque plein, base verrouillée… on continue
                journal.error("historique : écriture impossible (%s)", type(e).__name__)
            self._nouveaux_invites(lectures)
            return inst

    def _nouveaux_invites(self, lectures: dict) -> None:
        """Un invité inconnu des configurations : relire les configurations sans attendre 5 min."""
        s = self._sources.get("proxmox_configs")
        if s is None or s.fonction != self.lire_configs:
            return
        prox = lectures.get("proxmox", (None, None))[0]
        if not isinstance(prox, dict):
            return
        vus = set(self._invites_lus())
        with self._verrou:
            manquants = vus - self._vmids_demandes
        if manquants and self._vmids_demandes:
            with self._verrou:
                self._vmids_demandes |= manquants  # une seule relance par nouvel invité
            s.reveil.set()

    def instantane(self) -> dict:
        """Dernier instantané (construit sur-le-champ s'il n'y en a pas encore)."""
        with self._verrou:
            inst = self._inst
        return inst if inst is not None else self.tour()

    # ----------------------------------------------------------------- abonnés

    def abonner(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=TAILLE_FILE)
        with self._verrou:
            self._abonnes.append(q)
        return q

    def desabonner(self, q: queue.Queue) -> None:
        with self._verrou:
            if q in self._abonnes:
                self._abonnes.remove(q)

    @staticmethod
    def _pousser(q: queue.Queue, message: tuple) -> None:
        """Ajoute sans bloquer ; file pleine = on jette le plus ancien message."""
        while True:
            try:
                q.put_nowait(message)
                return
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
