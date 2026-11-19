"""Tests du collecteur et du mode démo.

Les sources sont de fausses fonctions (périodes très courtes) qui renvoient les fixtures
réelles de ``tests/fixtures`` ou lèvent une erreur : aucune connexion réseau.
"""

import json
import logging
import os
import queue
import tempfile
import threading
import time
import unittest
from unittest import mock

from abysse import demo
from abysse.collecteur import Collecteur, assembler, reconstituer_depuis_influx
from abysse.config import Config
from abysse.historique import Historique
from abysse.modele import construire_instantane
from abysse.debit import CompteurDebit
from abysse.reglages import Reglages
from abysse.sources import ErreurSource

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _json(nom):
    with open(os.path.join(FIXTURES, nom), encoding="utf-8") as f:
        return json.load(f)


def _texte(nom):
    with open(os.path.join(FIXTURES, nom), encoding="utf-8") as f:
        return f.read()


def _mikrotik_rapide():
    return {"interfaces": _json("mikrotik_interfaces.json")}


def _mikrotik_lent():
    return {
        "ressource": _json("mikrotik_resource.json"),
        "arp": _json("mikrotik_arp.json"),
        "baux": [],
        "hotes_pont": _json("mikrotik_bridge_hosts.json"),
        "dhcp_client": [{"interface": "ether1", "status": "bound"}],
    }


def _proxmox():
    return {"ressources": _json("pve_cluster_resources.json"), "noeud": _json("pve_node_status.json")}


def _configs():
    configs = {}
    for ligne in _texte("pve_onboot.txt").splitlines():
        if ligne.strip():
            vmid, onboot = ligne.split()
            configs[int(vmid)] = {"onboot": int(onboot), "ip": None}
    return configs


def _leve():
    raise ErreurSource("Proxmox : HTTP 401 sur /cluster/resources", 401)


def _attendre(condition, delai=5.0, pas=0.02):
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        r = condition()
        if r:
            return r
        time.sleep(pas)
    return condition()


def _noeuds(inst):
    return {n["id"]: n for n in inst["noeuds"]}


class Base(unittest.TestCase):
    def setUp(self):
        self._dossier = tempfile.TemporaryDirectory()
        self.base = os.path.join(self._dossier.name, "abysse.db")
        self.reglages = Reglages(self.base)
        self.historique = Historique(self.base)
        self.cfg = Config(base=self.base)
        self.collecteurs = []

    def tearDown(self):
        for c in self.collecteurs:
            c.arreter()
        self.historique.fermer()
        self._dossier.cleanup()

    def collecteur(self, sources, **kw):
        kw.setdefault("sites", [])
        kw.setdefault("periode", 0.05)
        c = Collecteur(self.cfg, self.reglages, self.historique, sources=sources, **kw)
        self.collecteurs.append(c)
        return c


class TestCollecteur(Base):
    def test_source_en_panne_inconnu(self):
        c = self.collecteur({
            "mikrotik": (_mikrotik_rapide, 0.05),
            "mikrotik_lent": (_mikrotik_lent, 0.05),
            "proxmox": (_leve, 0.05),
            "nut": (_leve, 0.05),
        })
        c.demarrer()
        inst = _attendre(lambda: (i := c.instantane())["sources"]["mikrotik"] == "ok" and i)
        self.assertTrue(inst)
        self.assertEqual(inst["sources"]["proxmox"], "erreur")
        self.assertEqual(inst["sources"]["nut"], "erreur")
        self.assertEqual(inst["sources"]["influx"], "desactivee")
        n = _noeuds(inst)
        self.assertEqual(n["mikrotik"]["etat"], "on")
        self.assertEqual(n["pve"]["etat"], "inconnu")
        self.assertEqual(n["onduleur"]["etat"], "inconnu")
        self.assertNotIn("off", {x["etat"] for x in inst["noeuds"]})

    def test_acces_refuse_attend_la_periode(self):
        # 401/403 : pas de relance rapide (TrueNAS journalise chaque échec d'authentification).
        appels = {"refus": 0, "reseau": 0}

        def refus():
            appels["refus"] += 1
            raise ErreurSource("TrueNAS : clé API refusée (AUTH_ERR)", 401)

        def reseau():
            appels["reseau"] += 1
            raise ErreurSource("NUT : délai dépassé")

        with mock.patch("abysse.collecteur.REESSAI_MAX_S", 0.02):
            c = self.collecteur({"truenas": (refus, 30.0), "nut": (reseau, 30.0)})
            c.demarrer()
            time.sleep(0.5)
        self.assertEqual(appels["refus"], 1)
        self.assertGreater(appels["reseau"], 5)

    def test_source_qui_tombe_en_cours_de_route(self):
        etat = {"ok": True}

        def proxmox():
            if not etat["ok"]:
                _leve()
            d = _proxmox()
            d["noeud"] = dict(d["noeud"])
            return d

        c = self.collecteur({
            "mikrotik": (_mikrotik_rapide, 0.05),
            "proxmox": (proxmox, 0.05),
            "proxmox_configs": (_configs, 0.05),
        })
        c.demarrer()
        self.assertTrue(_attendre(lambda: _noeuds(c.instantane()).get("ct-102", {}).get("etat") == "on"))
        etat["ok"] = False
        # plus vieux que 3 périodes -> None -> inconnu
        self.assertTrue(_attendre(lambda: _noeuds(c.instantane())["ct-102"]["etat"] == "inconnu", 3))
        inst = c.instantane()
        n = _noeuds(inst)
        invites = [x for x in inst["noeuds"] if x["id"].startswith(("ct-", "vm-"))]
        self.assertEqual(len(invites), 29)
        self.assertEqual({x["etat"] for x in invites}, {"inconnu"})
        self.assertEqual(n["pve"]["etat"], "inconnu")
        self.assertEqual(n["mikrotik"]["etat"], "on")
        self.assertNotIn("off", {x["etat"] for x in inst["noeuds"]})

    def test_premier_instantane_attend_les_premieres_lectures(self):
        # Sans attente, le premier instantané (poussé aux navigateurs qui se reconnectent après un
        # redémarrage, servi par /api/etat) partait avant toute lecture : aucun CT/VM ni appareil,
        # toutes les sources « erreur ». Le navigateur disposait alors la carte sans les invités.
        def lente(f, s=0.25):
            def g():
                time.sleep(s)
                return f()
            return g

        c = self.collecteur({
            "mikrotik": (lente(_mikrotik_rapide), 5),
            "mikrotik_lent": (lente(_mikrotik_lent), 5),
            "proxmox": (lente(_proxmox), 5),
            "nut": (_leve, 5),  # un échec termine aussi la première tentative
        }, periode=1.0)
        q = c.abonner()
        c.demarrer()
        nature, premier = q.get_nowait()
        self.assertEqual(nature, "etat")
        self.assertEqual(premier["sources"]["mikrotik"], "ok")
        self.assertEqual(premier["sources"]["proxmox"], "ok")
        self.assertEqual(premier["sources"]["nut"], "erreur")
        self.assertEqual(len([n for n in premier["noeuds"] if n["id"].startswith(("ct-", "vm-"))]), 29)
        self.assertEqual(_noeuds(premier)["pc"]["etat"], "on")  # table ARP déjà lue
        self.assertIs(c.instantane(), premier)

    def test_attente_au_demarrage_bornee(self):
        libere = threading.Event()
        self.addCleanup(libere.set)

        def bloquee():
            libere.wait(5)
            return _proxmox()

        c = self.collecteur({"proxmox": (bloquee, 5)}, periode=1.0, attente_demarrage=0.3)
        debut = time.monotonic()
        c.demarrer()
        self.assertLess(time.monotonic() - debut, 2)
        self.assertEqual(c.instantane()["sources"]["proxmox"], "erreur")
        libere.set()

    def test_premiere_lecture_d_une_source_sans_faux_evenements(self):
        # La table ARP lue pour la toute première fois (MikroTik injoignable au démarrage) révèle
        # les appareils déjà branchés : ce n'est pas une arrivée, aucun « … connecté ».
        # Une vraie arrivée ensuite donne bien son évènement.
        lent = {"ok": False, "arp": _json("mikrotik_arp.json"), "pont": _json("mikrotik_bridge_hosts.json")}
        rpi = {"address": "192.168.10.230", "mac-address": "B8:27:EB:84:22:4F", "interface": "bridge",
               "complete": "true", "status": "reachable"}
        console = {"address": "192.168.10.74", "mac-address": "02:00:00:CA:5D:72", "interface": "bridge",
                   "complete": "true", "status": "reachable"}
        lent["arp"].append(rpi)
        lent["pont"].append({"mac-address": "B8:27:EB:84:22:4F", "on-interface": "ether4", "local": "false"})

        def mikrotik_lent():
            if not lent["ok"]:
                raise ErreurSource("MikroTik : délai dépassé sur /rest/ip/arp")
            return {"arp": list(lent["arp"]), "baux": [], "hotes_pont": list(lent["pont"]),
                    "dhcp_client": [{"interface": "ether1", "status": "bound"}]}

        c = self.collecteur({"mikrotik": (_mikrotik_rapide, 0.05), "mikrotik_lent": (mikrotik_lent, 0.05)},
                            attente_demarrage=0.2)
        c.demarrer()
        time.sleep(0.3)
        lent["ok"] = True
        self.assertTrue(_attendre(lambda: "app-b827eb84224f" in _noeuds(c.instantane())))
        time.sleep(0.3)
        apparitions = [e for e in self.historique.evenements(0, time.time() + 10) if e["nature"] == "apparition"]
        self.assertEqual(apparitions, [])
        lent["arp"].append(console)
        self.assertTrue(_attendre(lambda: any(
            e["id"] == "app-020000ca5d72" and e["nature"] == "apparition"
            for e in self.historique.evenements(0, time.time() + 10))))
        ids = {e["id"] for e in self.historique.evenements(0, time.time() + 10) if e["nature"] == "apparition"}
        self.assertEqual(ids, {"app-020000ca5d72"})

    def test_echec_isole_tolere(self):
        compte = {"n": 0}

        def nut():
            compte["n"] += 1
            if compte["n"] % 2 == 0:
                raise ErreurSource("NUT : délai dépassé")
            return {"battery.charge": "100", "input.voltage": "230"}

        c = self.collecteur({"nut": (nut, 0.2)})
        c.demarrer()
        self.assertTrue(_attendre(lambda: c.instantane()["sources"]["nut"] == "ok"))
        fin = time.monotonic() + 1.0
        while time.monotonic() < fin:
            self.assertEqual(c.instantane()["sources"]["nut"], "ok")
            time.sleep(0.05)
        self.assertGreaterEqual(compte["n"], 3)

    def test_abonne_etat_puis_evenement(self):
        etat = {"statut": "running"}

        def proxmox():
            d = _proxmox()
            for r in d["ressources"]:
                if r.get("vmid") == 102:
                    r["status"] = etat["statut"]
            return d

        c = self.collecteur({"proxmox": (proxmox, 0.05), "proxmox_configs": (_configs, 0.05)})
        c.demarrer()
        self.assertTrue(_attendre(lambda: _noeuds(c.instantane()).get("ct-102", {}).get("etat") == "on"))
        q = c.abonner()
        etat["statut"] = "stopped"
        recus = []
        fin = time.monotonic() + 3
        while time.monotonic() < fin:
            try:
                recus.append(q.get(timeout=0.2))
            except queue.Empty:
                continue
            if recus[-1][0] == "evenement":
                break
        c.desabonner(q)
        natures = [r[0] for r in recus]
        self.assertIn("evenement", natures)
        evt = next(r[1] for r in recus if r[0] == "evenement")
        self.assertEqual(evt["id"], "ct-102")
        self.assertEqual(evt["nature"], "panne")
        avant = recus[natures.index("evenement") - 1]
        self.assertEqual(avant[0], "etat")
        self.assertEqual(_noeuds(avant[1])["ct-102"]["etat"], "off")
        # l'évènement est aussi gardé dans l'historique
        self.assertTrue(any(e["id"] == "ct-102" for e in self.historique.evenements(0, time.time() + 10)))

    def test_reveils_en_rafale_ne_retardent_pas_le_tour(self):
        # reveiller() est appelé après chaque POST /api/reglages : une rafale ne doit
        # pas repousser le tour régulier (sinon plus d'« etat » > 5 s = « Connexion perdue »).
        c = self.collecteur({}, periode=1.0)
        c.demarrer()
        q = c.abonner()
        for _ in range(10):
            c.reveiller()
            time.sleep(0.05)
        time.sleep(0.1)  # laisse passer le dernier tour anticipé
        while True:
            try:
                q.get_nowait()
            except queue.Empty:
                break
        debut = time.monotonic()
        recu = None
        while time.monotonic() - debut < 1.5:
            try:
                m = q.get(timeout=0.05)
            except queue.Empty:
                continue
            if m[0] == "etat":
                recu = time.monotonic() - debut
                break
        c.desabonner(q)
        self.assertIsNotNone(recu, "aucun instantané dans les 1,5 s qui suivent la rafale")

    def test_un_instantane_sur_dix(self):
        t = {"v": 1_000_000.0}

        def horloge():
            t["v"] += 1
            return t["v"]

        c = self.collecteur({}, horloge=horloge)
        enregistres = []
        with mock.patch.object(self.historique, "enregistrer", side_effect=enregistres.append):
            for _ in range(25):
                c.tour()
        self.assertEqual(len(enregistres), 2)

    def test_purge_toutes_les_heures(self):
        t = {"v": 2_000_000.0}
        c = self.collecteur({}, horloge=lambda: t["v"])
        with mock.patch.object(self.historique, "purger") as purger:
            c.tour()
            t["v"] += 60
            c.tour()
            t["v"] += 3600
            c.tour()
        self.assertEqual(purger.call_count, 2)

    def test_desabonner(self):
        c = self.collecteur({})
        q = c.abonner()
        c.desabonner(q)
        c.tour()
        self.assertTrue(q.empty())

    def test_abonne_lent_ne_bloque_pas(self):
        c = self.collecteur({})
        q = c.abonner()
        for _ in range(500):
            c.tour()
        self.assertLessEqual(q.qsize(), 100)

    def test_journal_sans_secret(self):
        def fuite():
            raise RuntimeError("jeton=PVEAPIToken-super-secret")

        c = self.collecteur({"proxmox": (fuite, 0.05)})
        with self.assertLogs("abysse", level="WARNING") as journal:
            c.demarrer()
            time.sleep(0.3)
        texte = "\n".join(journal.output)
        self.assertNotIn("super-secret", texte)
        self.assertIn("proxmox", texte)

    def test_configs_demandees_pour_les_invites_lus(self):
        cfg = Config(base=self.base, pve_url="https://192.168.10.97:8006", pve_jeton="x")
        c = Collecteur(cfg, self.reglages, self.historique, sources={"proxmox": (_proxmox, 0.05)}, sites=[])
        self.collecteurs.append(c)
        with self.assertRaises(ErreurSource):
            c.lire_configs()  # Proxmox pas encore lu
        c.demarrer()
        self.assertTrue(_attendre(lambda: c.instantane()["sources"]["proxmox"] == "ok"))
        with mock.patch("abysse.collecteur.proxmox.lire_configs", return_value={102: {"onboot": 1, "ip": None}}) as lc:
            self.assertEqual(c.lire_configs(), {102: {"onboot": 1, "ip": None}})
        demande = lc.call_args[0][1]
        self.assertEqual(len(demande), 29)
        self.assertEqual(demande[102], "lxc")
        self.assertEqual(demande[200], "qemu")

    def test_sources_par_defaut_selon_config(self):
        cfg = Config(base=self.base, mikrotik_url="http://192.168.10.198/rest", nut_hote="192.168.10.97",
                     truenas_url="https://192.168.10.31")
        c = Collecteur(cfg, self.reglages, self.historique, sites=[])
        noms = c.periodes()
        self.assertEqual(noms, {"mikrotik": 2, "mikrotik_lent": 30, "nut": 2})  # TrueNAS sans clé : désactivé


class TestAssembler(unittest.TestCase):
    def test_fusion_mikrotik_et_proxmox(self):
        brut = assembler({
            "mikrotik": (_mikrotik_rapide(), 10.0),
            "mikrotik_lent": (_mikrotik_lent(), 5.0),
            "proxmox": (_proxmox(), 11.0),
            "proxmox_configs": (_configs(), 3.0),
            "nut": (None, None),
        }, [{"nom": "exemple.fr"}])
        self.assertEqual(brut["mikrotik"]["t"], 10.0)
        self.assertIn("arp", brut["mikrotik"])
        self.assertIn("interfaces", brut["mikrotik"])
        self.assertEqual(brut["proxmox"]["t"], 11.0)
        self.assertEqual(brut["proxmox"]["configs"][105]["onboot"], 0)
        self.assertIsNone(brut["nut"])
        self.assertNotIn("influx", brut)
        self.assertEqual(brut["sites"], [{"nom": "exemple.fr"}])

    def test_ressource_vient_de_la_lecture_lente(self):
        brut = assembler({"mikrotik": (_mikrotik_rapide(), 10.0), "mikrotik_lent": (_mikrotik_lent(), 5.0)}, [])
        self.assertEqual(brut["mikrotik"]["ressource"], _json("mikrotik_resource.json"))
        self.assertEqual(brut["mikrotik"]["t"], 10.0)  # le débit suit l'heure des interfaces

    def test_lent_absent_ou_rapide_en_erreur(self):
        brut = assembler({"mikrotik": (_mikrotik_rapide(), 1.0), "mikrotik_lent": (None, None)}, [])
        self.assertNotIn("arp", brut["mikrotik"])
        self.assertNotIn("ressource", brut["mikrotik"])
        brut = assembler({"mikrotik": (None, None), "mikrotik_lent": (_mikrotik_lent(), 1.0)}, [])
        self.assertIsNone(brut["mikrotik"])


class TestReconstitution(unittest.TestCase):
    def test_depuis_influx(self):
        demandes = []

        def requete(flux):
            demandes.append(flux)
            if "upsd" in flux:
                return [
                    {"_time": "2026-10-20T10:00:00Z", "_field": "input_voltage", "_value": 231.0},
                    {"_time": "2026-10-20T10:01:00Z", "_field": "input_voltage", "_value": 0.0},
                    {"_time": "2026-10-20T10:02:00Z", "_field": "input_voltage", "_value": 229.0},
                ]
            if 'r.vmid == "102"' in flux:
                return [
                    {"_time": f"2026-10-20T11:0{i}:00Z", "_field": "uptime", "_value": v,
                     "vmid": "102", "object": "lxc", "host": "supervision"}
                    for i, v in enumerate([500, 560, 0, 0, 30])
                ]
            return []

        evts = reconstituer_depuis_influx(requete, [102, 200])
        self.assertEqual(len(demandes), 3)
        self.assertTrue(all("range(start: -30d)" in f for f in demandes))
        natures = [(e["id"], e["nature"]) for e in evts]
        self.assertEqual(natures, [("onduleur", "batterie"), ("onduleur", "secteur"),
                                   ("ct-102", "panne"), ("ct-102", "retour")])
        self.assertEqual(evts, sorted(evts, key=lambda e: e["t"]))

    def test_erreur_partielle(self):
        def requete(flux):
            if "upsd" in flux:
                raise ErreurSource("InfluxDB : délai dépassé")
            return []

        self.assertEqual(reconstituer_depuis_influx(requete, [102]), [])


class TestDemo(unittest.TestCase):
    def _instantanes(self, horloge, n=3, pas=2.0):
        sources = demo.sources_demo(horloge=lambda: horloge["t"])
        debits = CompteurDebit()
        reglages = demo.ReglagesDemo()
        insts = []
        for _ in range(n):
            lectures = {nom: (f(), horloge["t"]) for nom, (f, _p) in sources.items()}
            insts.append(construire_instantane(assembler(lectures, demo.SITES), reglages, debits, horloge["t"]))
            horloge["t"] += pas
        return insts

    def test_format_des_sources(self):
        sources = demo.sources_demo()
        self.assertEqual(set(sources), {"mikrotik", "mikrotik_lent", "proxmox", "proxmox_configs",
                                        "nut", "influx", "truenas"})
        for nom, (f, periode) in sources.items():
            self.assertTrue(callable(f), nom)
            self.assertGreater(periode, 0)
            self.assertIsInstance(f(), dict, nom)
        # comme l'API REST de RouterOS : nombres en chaînes
        i = sources["mikrotik"][0]()["interfaces"][0]
        self.assertIsInstance(i["rx-byte"], str)

    def test_instantane_demo_complet(self):
        h = {"t": 1_800_000_000.0}
        insts = self._instantanes(h, n=12, pas=2.0)
        inst = insts[-1]
        n = _noeuds(inst)
        self.assertEqual(set(inst["sources"].values()), {"ok"})
        invites = [i for i in n if i.startswith(("ct-", "vm-"))]
        self.assertEqual(len(invites), 29)
        self.assertGreaterEqual(len([i for i in n if i.startswith("site-")]), 15)
        self.assertGreaterEqual(len([i for i in n if i.startswith("app-")]), 2)
        self.assertGreaterEqual(len(n), 60)
        self.assertEqual(n["ct-105"]["etat"], "eteint")
        self.assertEqual(n["switch-1"]["etat"], "eteint")
        self.assertEqual(n["onduleur"]["jauges"]["secteur"], True)
        self.assertIn("disque", n["vm-200"]["jauges"])
        self.assertEqual(n["site-site-a.exemple.fr"]["parent"], "ct-124")
        liens = {l["id"]: l for l in inst["liens"]}
        self.assertIsNotNone(liens["mikrotik>box"]["montant"])
        self.assertGreater(liens["mikrotik>box"]["montant"], 0)
        self.assertTrue(any(l["descendant"] for k, l in liens.items() if k.startswith("pve>")))

    def test_scenarios_en_direct(self):
        t0 = 1_800_000_000.0
        h = {"t": t0}
        sources = demo.sources_demo(horloge=lambda: h["t"])
        nut, prox = sources["nut"][0], sources["proxmox"][0]
        tensions, arrets = [], set()
        for s in range(0, 330, 2):
            h["t"] = t0 + s
            tensions.append(float(nut()["input.voltage"]))
            for r in prox()["ressources"]:
                if r.get("type") == "lxc" and r["vmid"] != 105 and r["status"] != "running":
                    arrets.add(r["vmid"])
        self.assertTrue(any(v < 180 for v in tensions), "coupure de courant attendue en 5 min")
        self.assertTrue(any(v > 200 for v in tensions))
        self.assertTrue(arrets, "un CT doit s'arrêter dans les 2 premières minutes")

    def test_remplir_historique(self):
        with tempfile.TemporaryDirectory() as d:
            h = Historique(os.path.join(d, "h.db"))
            try:
                maintenant = 1_800_000_000.0
                debut = time.monotonic()
                demo.remplir_historique(h, maintenant)
                duree = time.monotonic() - debut
                evts = h.evenements(maintenant - 86400 - 1, maintenant)
                self.assertEqual({e["importance"] for e in evts}, {1, 2, 3, 4})
                natures = {e["nature"] for e in evts}
                self.assertTrue({"batterie", "secteur", "panne", "retour", "stockage", "sauvegarde"} <= natures)
                self.assertTrue(any(e["texte"].startswith("Abysse injoignable") for e in evts))
                de, a = h.bornes()
                self.assertLessEqual(de, maintenant - 86400 + 300)
                coupure = next(e for e in evts if e["nature"] == "batterie")
                inst = h.instant(coupure["t"] + 1)
                self.assertIsNotNone(inst)
                self.assertFalse(_noeuds(inst)["onduleur"]["jauges"]["secteur"])
                self.assertLess(duree, 30)
            finally:
                h.fermer()


if __name__ == "__main__":
    unittest.main()
