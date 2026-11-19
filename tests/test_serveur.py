"""Tests du serveur HTTP/SSE, sur un vrai serveur local en mode démo (port 0)."""

import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest

from abysse import demo
from abysse.collecteur import Collecteur
from abysse.config import Config
from abysse.historique import Historique
from abysse.reglages import Reglages
from abysse.serveur import CSP, creer_serveur

SECRETS = {
    "pve_jeton": "abysse@pve!lecture=7d1c9e2a-SECRET-PVE-4b8f",
    "mikrotik_pass": "SECRET-MIKROTIK-mot-de-passe",
    "influx_jeton": "SECRET-INFLUX-jeton==",
    "truenas_cle": "1-SECRET-TRUENAS-cle",
}


class TestServeur(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dossier = tempfile.TemporaryDirectory()
        base = os.path.join(cls._dossier.name, "abysse.db")
        cls.cfg = Config(ecoute_hote="127.0.0.1", ecoute_port=0, base=base, demo=True, **SECRETS)
        cls.reglages = Reglages(base)
        cls.historique = Historique(base)
        cls.collecteur = Collecteur(cls.cfg, cls.reglages, cls.historique,
                                    sources=demo.sources_demo(), sites=demo.SITES)
        cls.collecteur.demarrer()
        cls.serveur = creer_serveur(cls.cfg, cls.collecteur, cls.reglages, cls.historique)
        cls.port = cls.serveur.server_address[1]
        cls._fil = threading.Thread(target=cls.serveur.serve_forever, daemon=True)
        cls._fil.start()

    @classmethod
    def tearDownClass(cls):
        cls.serveur.shutdown()
        cls.serveur.server_close()
        cls.collecteur.arreter()
        cls.historique.fermer()
        cls._dossier.cleanup()

    def requete(self, methode, chemin, corps=None, entetes=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            c.request(methode, chemin, body=corps, headers=entetes or {})
            r = c.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            c.close()

    def get_json(self, chemin):
        statut, entetes, corps = self.requete("GET", chemin)
        return statut, entetes, json.loads(corps.decode("utf-8"))

    def post_json(self, chemin, objet, type_="application/json"):
        corps = json.dumps(objet).encode("utf-8")
        statut, entetes, rep = self.requete("POST", chemin, corps, {"Content-Type": type_})
        return statut, json.loads(rep.decode("utf-8"))

    # ------------------------------------------------------------------ API

    def test_api_etat_demo(self):
        statut, entetes, inst = self.get_json("/api/etat")
        self.assertEqual(statut, 200)
        self.assertTrue(entetes["Content-Type"].startswith("application/json"))
        self.assertTrue(inst["noeuds"])
        self.assertEqual(inst["version"], 1)
        self.assertIn("liens", inst)

    def test_sante(self):
        statut, _, sante = self.get_json("/api/sante")
        self.assertEqual(statut, 200)
        self.assertIs(sante["ok"], True)
        self.assertEqual(set(sante["sources"]), {"mikrotik", "proxmox", "nut", "influx", "truenas"})

    def test_sse_recoit_etat(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            s.sendall(b"GET /api/flux HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n")
            s.settimeout(0.3)
            recu = b""
            fin = time.monotonic() + 3
            while time.monotonic() < fin:
                try:
                    morceau = s.recv(65536)
                except socket.timeout:
                    continue
                if not morceau:
                    break
                recu += morceau
        finally:
            s.close()
        texte = recu.decode("utf-8", "replace")
        tete, _, flux = texte.partition("\r\n\r\n")
        self.assertIn("200", tete.splitlines()[0])
        self.assertIn("text/event-stream", tete)
        self.assertIn("retry: 2000", flux)
        self.assertGreaterEqual(flux.count("event: etat\n"), 2)
        # chaque évènement : une ligne data: JSON valide
        bloc = flux.split("event: etat\n", 1)[1].split("\n\n", 1)[0]
        self.assertTrue(bloc.startswith("data: "))
        self.assertIn("noeuds", json.loads(bloc[len("data: "):]))

    def test_historique(self):
        t = time.time()
        self.historique.ajouter([{"t": t - 60, "id": "ct-102", "nom": "supervision", "nature": "panne",
                                  "importance": 2, "texte": "CT 102 supervision arrêté"}])
        statut, _, h = self.get_json(f"/api/historique?de={t - 3600}&a={t + 1}")
        self.assertEqual(statut, 200)
        self.assertEqual(len(h["bornes"]), 2)
        self.assertTrue(any(e["texte"] == "CT 102 supervision arrêté" for e in h["evenements"]))
        statut, _, h = self.get_json("/api/historique")
        self.assertEqual(statut, 200)
        statut, _, err = self.get_json("/api/historique?de=abc")
        self.assertEqual(statut, 400)
        self.assertTrue(err["erreur"])

    def test_instant(self):
        inst = self.collecteur.instantane()
        self.historique.enregistrer(dict(inst, t=1000.0))
        statut, _, i = self.get_json("/api/instant?t=1005")
        self.assertEqual(statut, 200)
        self.assertEqual(i["t"], 1000.0)
        statut, _, err = self.get_json("/api/instant?t=10")
        self.assertEqual(statut, 404)
        self.assertTrue(err["erreur"])
        statut, _, err = self.get_json("/api/instant?t=nan")
        self.assertEqual(statut, 400)
        statut, _, err = self.get_json("/api/instant")
        self.assertEqual(statut, 400)

    def test_reglages_get_post(self):
        statut, r = self.post_json("/api/reglages", {"action": "renommer", "id": "ct-124", "nom": "Site A"})
        self.assertEqual(statut, 200)
        self.assertEqual(r["noms"]["ct-124"], "Site A")
        statut, _, r = self.get_json("/api/reglages")
        self.assertEqual(statut, 200)
        self.assertEqual(r["noms"]["ct-124"], "Site A")
        self.assertIn("switch-1", r["eteints_expres"])

    def test_reglages_post_refus(self):
        statut, r = self.post_json("/api/reglages", {"action": "ajouter_lien", "nom": "piège",
                                                     "url": "javascript:alert(1)", "parent": "ct-124"})
        self.assertEqual(statut, 400)
        self.assertIn("refusée", r["erreur"])
        statut, r = self.post_json("/api/reglages", {"action": "renommer", "id": "ct-124", "nom": "<script>"})
        self.assertEqual(statut, 400)
        self.assertIn("« < »", r["erreur"])
        statut, r = self.post_json("/api/reglages", {"action": "renommer", "id": "ct-124", "nom": "x" * 10_000})
        self.assertEqual(statut, 400)
        self.assertIn("dépasser", r["erreur"])
        self.assertNotIn("<script>", json.dumps(self.reglages.en_dict()))

    def test_reglages_post_forme(self):
        statut, r = self.post_json("/api/reglages", {"action": "cacher", "id": "ct-124"}, type_="text/plain")
        self.assertEqual(statut, 415)
        self.assertTrue(r["erreur"])
        statut, _, corps = self.requete("POST", "/api/reglages", b"{pas du json",
                                        {"Content-Type": "application/json"})
        self.assertEqual(statut, 400)
        self.assertIn("JSON", json.loads(corps)["erreur"])
        gros = json.dumps({"action": "renommer", "id": "ct-124", "nom": "x" * 20_000}).encode()
        statut, _, corps = self.requete("POST", "/api/reglages", gros, {"Content-Type": "application/json"})
        self.assertEqual(statut, 413)
        self.assertIn("Kio", json.loads(corps)["erreur"])
        statut, _, _ = self.requete("POST", "/api/etat", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(statut, 405)

    # ------------------------------------------------------------------ fichiers

    def test_index_et_types(self):
        statut, entetes, corps = self.requete("GET", "/")
        self.assertEqual(statut, 200)
        self.assertTrue(entetes["Content-Type"].startswith("text/html"))
        self.assertIn(b"<canvas", corps)
        statut, entetes, _ = self.requete("GET", "/js/graphe.js")
        self.assertEqual(statut, 200)
        self.assertTrue(entetes["Content-Type"].startswith("text/javascript"))
        statut, entetes, _ = self.requete("GET", "/css/abysse.css")
        self.assertTrue(entetes["Content-Type"].startswith("text/css"))
        statut, _, _ = self.requete("GET", "/nexiste/pas.js")
        self.assertEqual(statut, 404)
        statut, _, _ = self.requete("GET", "/js")
        self.assertEqual(statut, 404)

    def test_chemin_traversal(self):
        for chemin in ("/../abysse/config.py", "/%2e%2e/abysse/config.py", "/js/../../abysse/config.py",
                       "/..%2fabysse%2fconfig.py", "/..\\abysse\\config.py", "/%2e%2e%5cabysse%5cconfig.py",
                       "/C:/Windows/win.ini", "//etc/passwd"):
            statut, _, corps = self.requete("GET", chemin)
            self.assertEqual(statut, 404, chemin)
            self.assertNotIn(b"charger_config", corps)

    def test_csp_presente(self):
        self.assertEqual(CSP, "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
        for chemin in ("/", "/api/etat", "/api/sante", "/nexiste-pas", "/api/instant?t=1"):
            _, entetes, _ = self.requete("GET", chemin)
            self.assertEqual(entetes.get("Content-Security-Policy"), CSP, chemin)
            self.assertEqual(entetes.get("X-Content-Type-Options"), "nosniff", chemin)
            self.assertEqual(entetes.get("Referrer-Policy"), "no-referrer", chemin)

    def test_aucun_secret_api(self):
        for chemin in ("/api/sante", "/api/etat", "/api/reglages", "/api/historique"):
            statut, entetes, corps = self.requete("GET", chemin)
            self.assertEqual(statut, 200, chemin)
            texte = corps.decode("utf-8") + json.dumps(entetes)
            for secret in SECRETS.values():
                self.assertNotIn(secret, texte, chemin)
            self.assertNotIn("SECRET", texte, chemin)


if __name__ == "__main__":
    unittest.main()
