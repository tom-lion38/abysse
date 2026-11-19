"""Tests de ``abysse.historique`` : instantanés compressés et journal d'évènements dans SQLite."""

import os
import sqlite3
import tempfile
import unittest
import zlib
from contextlib import closing

from abysse.historique import Historique

H = 3600.0
J = 86400.0
NBSP = " "


def inst(t, etat="on"):
    return {"t": t, "version": 1, "sources": {"proxmox": "ok"},
            "noeuds": [{"id": "pve", "nom": "pve", "etat": etat, "jauges": {"cpu": 0.12}, "details": {}}],
            "liens": []}


def evt(t, id_="ct-102", importance=2, nature="panne", texte="CT 102 supervision arrêté"):
    return {"t": t, "id": id_, "nom": "supervision", "nature": nature, "importance": importance, "texte": texte}


class Base(unittest.TestCase):
    def setUp(self):
        self._dossier = tempfile.TemporaryDirectory()
        self.chemin = os.path.join(self._dossier.name, "abysse.db")
        self.h = Historique(self.chemin)

    def tearDown(self):
        self.h.fermer()
        self._dossier.cleanup()  # échoue sous Windows si une connexion reste ouverte


class TestInstantanes(Base):
    def test_vide(self):
        self.assertIsNone(self.h.instant(1e9))
        self.assertEqual(self.h.bornes(), (None, None))
        self.assertEqual(self.h.evenements(0, 1e12), [])
        self.assertIsNone(self.h.trou_au_demarrage(1e9))

    def test_instant_le_plus_proche(self):
        for t in (100.0, 110.0, 120.0):
            self.h.enregistrer(inst(t, etat="on" if t != 110.0 else "off"))
        self.assertIsNone(self.h.instant(99.9))
        self.assertEqual(self.h.instant(100.0)["t"], 100.0)
        r = self.h.instant(115.0)
        self.assertEqual(r["t"], 110.0)
        self.assertEqual(r["noeuds"][0]["etat"], "off")
        self.assertEqual(self.h.instant(1e9)["t"], 120.0)
        self.assertEqual(self.h.instant(115.0), inst(110.0, "off"))  # aller-retour exact

    def test_compression(self):
        gros = inst(5.0)
        gros["noeuds"] *= 200
        self.h.enregistrer(gros)
        with closing(sqlite3.connect(self.chemin)) as c:
            (donnees,) = c.execute("SELECT donnees FROM instantanes").fetchone()
        self.assertIsInstance(donnees, bytes)
        self.assertGreater(len(zlib.decompress(donnees)), 5 * len(donnees))
        self.assertEqual(self.h.instant(5.0), gros)

    def test_meme_t_remplace(self):
        self.h.enregistrer(inst(10.0, "on"))
        self.h.enregistrer(inst(10.0, "off"))
        self.assertEqual(self.h.instant(10.0)["noeuds"][0]["etat"], "off")

    def test_persistance(self):
        self.h.enregistrer(inst(42.0))
        self.h.ajouter([evt(42.0)])
        self.h.fermer()
        self.h = Historique(self.chemin)
        self.assertEqual(self.h.instant(50.0)["t"], 42.0)
        self.assertEqual(self.h.evenements(0, 100), [evt(42.0)])

    def test_bornes(self):
        self.h.enregistrer(inst(1000.0))
        self.h.enregistrer(inst(2000.0))
        self.assertEqual(self.h.bornes(), (1000.0, 2000.0))
        # les évènements reconstitués depuis InfluxDB élargissent la frise vers le passé
        self.h.ajouter([evt(500.0)])
        self.assertEqual(self.h.bornes(), (500.0, 2000.0))


class TestEvenements(Base):
    def test_plage_et_tri(self):
        self.h.ajouter([evt(30.0), evt(10.0, id_="pve", importance=4), evt(20.0)])
        self.assertEqual([e["t"] for e in self.h.evenements(0, 100)], [10.0, 20.0, 30.0])
        self.assertEqual([e["t"] for e in self.h.evenements(10.0, 20.0)], [10.0, 20.0])  # bornes incluses
        self.assertEqual(self.h.evenements(40, 50), [])
        e = self.h.evenements(10.0, 10.0)[0]
        self.assertEqual(e, evt(10.0, id_="pve", importance=4))

    def test_doublon_ignore(self):
        self.h.ajouter([evt(10.0)])
        self.h.ajouter([evt(10.0), evt(10.0)])
        self.assertEqual(len(self.h.evenements(0, 100)), 1)

    def test_accents_conserves(self):
        texte = f"Onduleur sur batterie (87{NBSP}%)"
        self.h.ajouter([evt(1.0, id_="onduleur", importance=4, nature="batterie", texte=texte)])
        self.assertEqual(self.h.evenements(0, 2)[0]["texte"], texte)

    def test_evenement_invalide_ignore(self):
        self.h.ajouter([{"t": "hier", "id": "x"}, None, evt(5.0)])
        self.assertEqual(len(self.h.evenements(0, 10)), 1)


class TestPurge(Base):
    def test_purge_sous_echantillonne(self):
        maintenant = 1_800_000_000.0
        debut = maintenant - 72 * H
        t = debut
        while t <= maintenant:
            self.h.enregistrer(inst(t))
            t += 10.0
        self.h.purger(maintenant)
        with closing(sqlite3.connect(self.chemin)) as c:
            ts = [r[0] for r in c.execute("SELECT t FROM instantanes ORDER BY t")]
        limite = maintenant - 48 * H
        anciens = [x for x in ts if x < limite]
        recents = [x for x in ts if x >= limite]
        # tout est gardé sur 48 h
        self.assertEqual(len(recents), int(48 * H / 10) + 1)
        # au-delà : au plus un par minute, mais chaque minute garde son instantané
        minutes = [int(x // 60) for x in anciens]
        self.assertEqual(len(minutes), len(set(minutes)))
        self.assertGreaterEqual(len(anciens), int(24 * H / 60) - 1)
        self.assertLessEqual(len(anciens), int(24 * H / 60) + 1)
        # le rejeu reste possible dans la partie sous-échantillonnée
        self.assertLessEqual(maintenant - 60 * H - self.h.instant(maintenant - 60 * H)["t"], 60.0)
        # une deuxième purge ne change rien
        self.h.purger(maintenant)
        with closing(sqlite3.connect(self.chemin)) as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM instantanes").fetchone()[0], len(ts))

    def test_purge_30_jours(self):
        maintenant = 1_800_000_000.0
        for age in (31 * J, 29 * J, 1 * H):
            self.h.enregistrer(inst(maintenant - age))
        self.h.ajouter([evt(maintenant - 31 * J), evt(maintenant - 29 * J), evt(maintenant - H)])
        self.h.purger(maintenant)
        self.assertEqual(self.h.bornes(), (maintenant - 29 * J, maintenant - H))
        self.assertIsNone(self.h.instant(maintenant - 30 * J))
        self.assertEqual([e["t"] for e in self.h.evenements(0, maintenant)], [maintenant - 29 * J, maintenant - H])


class TestTrou(Base):
    def test_trou_au_demarrage(self):
        self.h.enregistrer(inst(1000.0))
        self.assertIsNone(self.h.trou_au_demarrage(1050.0))
        self.assertIsNone(self.h.trou_au_demarrage(1060.0))
        e = self.h.trou_au_demarrage(1000.0 + 19 * 60)
        self.assertEqual(set(e), {"t", "id", "nom", "nature", "importance", "texte"})
        self.assertEqual((e["importance"], e["nature"], e["id"]), (4, "panne", "abysse"))
        self.assertEqual(e["t"], 1000.0)  # le ping marque le début du trou
        self.assertEqual(e["texte"], f"Abysse injoignable 19{NBSP}min")
        self.assertIsNotNone(self.h.trou_au_demarrage(1100.0, seuil=30))

    def test_trou_long(self):
        self.h.enregistrer(inst(0.0))
        self.assertEqual(self.h.trou_au_demarrage(3 * H + 7 * 60)["texte"], f"Abysse injoignable 3{NBSP}h{NBSP}07")
        self.assertEqual(self.h.trou_au_demarrage(2 * J + 5 * H)["texte"], f"Abysse injoignable 2{NBSP}j{NBSP}5{NBSP}h")


class TestConcurrence(Base):
    def test_plusieurs_threads(self):
        import threading
        erreurs = []

        def ecrire(depart):
            try:
                for i in range(200):
                    self.h.enregistrer(inst(depart + i))
                    self.h.ajouter([evt(depart + i)])
            except Exception as e:  # pragma: no cover - remonté par l'assertion
                erreurs.append(e)

        def lire():
            try:
                for _ in range(200):
                    self.h.instant(1e9)
                    self.h.evenements(0, 1e9)
                    self.h.bornes()
            except Exception as e:  # pragma: no cover
                erreurs.append(e)

        fils = [threading.Thread(target=ecrire, args=(k * 1000.0,)) for k in range(2)]
        fils += [threading.Thread(target=lire) for _ in range(2)]
        for f in fils:
            f.start()
        for f in fils:
            f.join()
        self.assertEqual(erreurs, [])
        self.assertEqual(len(self.h.evenements(0, 1e9)), 400)


if __name__ == "__main__":
    unittest.main()
