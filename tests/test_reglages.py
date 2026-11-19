"""Tests de ``abysse.reglages`` : réglages du mode « modifier », persistants et validés."""

import json
import os
import tempfile
import unittest

from abysse.reglages import Reglages


class Base(unittest.TestCase):
    def setUp(self):
        self._dossier = tempfile.TemporaryDirectory()
        self.chemin = os.path.join(self._dossier.name, "abysse.db")
        self.r = Reglages(self.chemin)

    def tearDown(self):
        self._dossier.cleanup()  # échoue sous Windows si une connexion reste ouverte


class TestReglages(Base):
    def test_defaut_eteints_expres(self):
        self.assertEqual(self.r.eteints_expres, {"switch-1", "switch-2", "camera"})
        self.assertEqual(self.r.noms, {})
        self.assertEqual(self.r.caches, set())
        self.assertEqual(self.r.liens, [])

    def test_reglages_persistants(self):
        self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "Supervision"})
        self.r.appliquer({"action": "cacher", "id": "app-bc2411aabbcc"})
        self.r.appliquer({"action": "eteint_expres", "id": "camera", "valeur": False})
        self.r.appliquer({"action": "ajouter_lien", "nom": "Wiki", "url": "https://wiki.lan", "parent": "ct-102"})
        r2 = Reglages(self.chemin)
        self.assertEqual(r2.noms, {"ct-102": "Supervision"})
        self.assertEqual(r2.caches, {"app-bc2411aabbcc"})
        self.assertEqual(r2.eteints_expres, {"switch-1", "switch-2"})
        self.assertEqual(r2.liens, [{"id": "lien-1", "nom": "Wiki", "url": "https://wiki.lan", "parent": "ct-102"}])

    def test_renommer_nettoie_et_retablit(self):
        self.r.appliquer({"action": "renommer", "id": "pve", "nom": "  Hyperviseur  "})
        self.assertEqual(self.r.noms["pve"], "Hyperviseur")
        self.r.appliquer({"action": "renommer", "id": "pve", "nom": None})  # nom d'origine
        self.assertNotIn("pve", self.r.noms)

    def test_refus_balise(self):
        for nom in ("<script>", "<b>", "a>b", "x<"):
            with self.assertRaises(ValueError):
                self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": nom})
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "ajouter_lien", "nom": "<img src=x>", "url": "https://a.lan", "parent": "pve"})
        self.assertEqual(self.r.noms, {})
        self.assertEqual(self.r.liens, [])

    def test_refus_long(self):
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "x" * 41})
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "x" * 10_000})
        self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "é" * 40})
        self.assertEqual(self.r.noms["ct-102"], "é" * 40)

    def test_refus_vide(self):
        for nom in ("", "   ", 12, ["a"]):
            with self.assertRaises(ValueError):
                self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": nom})

    def test_refus_javascript(self):
        for url in (
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "https://a.lan/\"onmouseover=alert(1)",
            "https://a.lan/'x",
            "https://a.lan/`x",
            "https://a.lan/<x>",
            "https://a b.lan",
            "https://a.lan\n",
            "https://",
            "ftp://a.lan",
            "https://" + "a" * 201,
            "",
            None,
        ):
            with self.assertRaises(ValueError, msg=repr(url)):
                self.r.appliquer({"action": "ajouter_lien", "nom": "Lien", "url": url, "parent": "ct-102"})
        self.assertEqual(self.r.liens, [])
        self.r.appliquer({"action": "ajouter_lien", "nom": "Site D", "url": "https://site-d.exemple.fr", "parent": "ct-129"})
        self.r.appliquer({"action": "ajouter_lien", "nom": "Kuma", "url": "http://192.168.10.55:3001/", "parent": "ct-102"})
        self.assertEqual(len(self.r.liens), 2)

    def test_messages_en_francais(self):
        with self.assertRaises(ValueError) as ctx:
            self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "x" * 41})
        self.assertIn("caractères", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            self.r.appliquer({"action": "ajouter_lien", "nom": "a", "url": "javascript:alert(1)", "parent": "pve"})
        self.assertIn("https://", str(ctx.exception))
        self.assertNotIn("alert", str(ctx.exception))  # la saisie n'est pas renvoyée

    def test_id_inconnu(self):
        for id_ in ("", "inconnu", "ct-", "ct-abc", "app-zz", "<script>", "lien-x", None, 5, "site-<x>", "site-"):
            with self.assertRaises(ValueError, msg=repr(id_)):
                self.r.appliquer({"action": "cacher", "id": id_})
        for id_ in ("mikrotik", "truenas", "ct-102", "vm-200", "app-bc2411aabbcc", "site-exemple.fr", "lien-3"):
            self.r.appliquer({"action": "cacher", "id": id_})
        with self.assertRaises(ValueError):  # un parent de lien ne peut pas être un site
            self.r.appliquer({"action": "ajouter_lien", "nom": "a", "url": "https://a.lan", "parent": "site-exemple.fr"})

    def test_action_inconnue(self):
        for modif in ({"action": "supprimer_tout"}, {}, None, "renommer", []):
            with self.assertRaises(ValueError):
                self.r.appliquer(modif)

    def test_cacher_montrer(self):
        self.r.appliquer({"action": "cacher", "id": "ct-124"})
        self.r.appliquer({"action": "cacher", "id": "ct-124"})
        self.assertEqual(self.r.caches, {"ct-124"})
        self.r.appliquer({"action": "montrer", "id": "ct-124"})
        self.assertEqual(self.r.caches, set())
        self.r.appliquer({"action": "montrer", "id": "ct-124"})  # déjà visible : sans effet

    def test_eteint_expres(self):
        self.r.appliquer({"action": "eteint_expres", "id": "ct-105"})
        self.assertIn("ct-105", self.r.eteints_expres)
        self.r.appliquer({"action": "eteint_expres", "id": "ct-105", "valeur": False})
        self.assertNotIn("ct-105", self.r.eteints_expres)
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "eteint_expres", "id": "ct-105", "valeur": "oui"})

    def test_liens_ajouter_modifier_retirer(self):
        self.r.appliquer({"action": "ajouter_lien", "nom": "A", "url": "https://a.lan", "parent": "ct-102"})
        self.r.appliquer({"action": "ajouter_lien", "nom": "B", "url": "https://b.lan", "parent": "pve"})
        self.assertEqual([l["id"] for l in self.r.liens], ["lien-1", "lien-2"])
        self.r.appliquer({"action": "modifier_lien", "id": "lien-1", "url": "https://a2.lan"})
        self.assertEqual(self.r.liens[0], {"id": "lien-1", "nom": "A", "url": "https://a2.lan", "parent": "ct-102"})
        self.r.appliquer({"action": "retirer_lien", "id": "lien-1"})
        self.r.appliquer({"action": "ajouter_lien", "nom": "C", "url": "https://c.lan", "parent": "pve"})
        self.assertEqual([l["id"] for l in self.r.liens], ["lien-2", "lien-3"])  # jamais réutilisé
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "modifier_lien", "id": "lien-1", "nom": "Fantôme"})
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "retirer_lien", "id": "lien-99"})
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "modifier_lien", "id": "lien-2", "url": "javascript:alert(1)"})
        self.assertEqual(self.r.liens[0]["url"], "https://b.lan")

    def test_corriger_site_detecte(self):
        self.r.appliquer({"action": "modifier_lien", "id": "site-exemple.fr", "url": "https://www.exemple.fr"})
        self.assertEqual(self.r.liens, [{"id": "site-exemple.fr", "nom": None, "url": "https://www.exemple.fr", "parent": None}])
        self.r.appliquer({"action": "modifier_lien", "id": "site-exemple.fr", "parent": "ct-143"})
        self.assertEqual(self.r.liens[0]["parent"], "ct-143")
        self.assertEqual(self.r.liens[0]["url"], "https://www.exemple.fr")
        self.r.appliquer({"action": "retirer_lien", "id": "site-exemple.fr"})
        self.assertEqual(self.r.liens, [])
        self.assertIn("site-exemple.fr", self.r.caches)  # un site du Caddyfile retiré est masqué

    def test_limite_liens(self):
        for i in range(200):
            self.r.appliquer({"action": "ajouter_lien", "nom": f"L{i}", "url": f"https://l{i}.lan", "parent": "pve"})
        with self.assertRaises(ValueError):
            self.r.appliquer({"action": "ajouter_lien", "nom": "trop", "url": "https://trop.lan", "parent": "pve"})
        self.assertEqual(len(Reglages(self.chemin).liens), 200)

    def test_copies_defensives(self):
        self.r.noms["pve"] = "pirate"
        self.r.caches.add("pve")
        self.r.liens.append({"id": "lien-9"})
        self.assertEqual(self.r.noms, {})
        self.assertEqual(self.r.caches, set())
        self.assertEqual(self.r.liens, [])

    def test_en_dict(self):
        self.r.appliquer({"action": "renommer", "id": "ct-102", "nom": "Supervision"})
        self.r.appliquer({"action": "cacher", "id": "ct-124"})
        d = self.r.en_dict()
        self.assertEqual(json.loads(json.dumps(d)), d)
        self.assertEqual(d["noms"], {"ct-102": "Supervision"})
        self.assertEqual(d["caches"], ["ct-124"])
        self.assertEqual(d["eteints_expres"], ["camera", "switch-1", "switch-2"])
        self.assertEqual(d["liens"], [])

    def test_base_corrompue(self):
        import sqlite3
        from contextlib import closing

        with closing(sqlite3.connect(self.chemin)) as c, c:
            c.execute("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('eteints_expres', '{pas du json')")
            c.execute("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('noms', '[1, 2]')")
        r2 = Reglages(self.chemin)
        self.assertEqual(r2.eteints_expres, {"switch-1", "switch-2", "camera"})
        self.assertEqual(r2.noms, {})


if __name__ == "__main__":
    unittest.main()
