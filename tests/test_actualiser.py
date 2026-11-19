"""Actualisation des sites depuis Phare et route POST /api/actualiser."""

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from abysse.collecteur import Collecteur
from abysse.config import Config
from abysse.sources import ErreurSource

SITES = [{"nom": "jellyfin.lan", "url": "https://jellyfin.lan", "amont_ip": "192.168.10.31", "amont_port": 30013}]


class _FauxPhare(BaseHTTPRequestHandler):
    reponse = json.dumps(SITES).encode()

    def do_GET(self):
        self.send_response(200 if self.path == "/api/abysse/sites" else 404)
        self.end_headers()
        self.wfile.write(self.reponse)

    def log_message(self, *a):
        pass


class TestActualiser(unittest.TestCase):
    def setUp(self):
        self.dossier = tempfile.mkdtemp()
        self.json = os.path.join(self.dossier, "sites.json")
        with open(self.json, "w", encoding="utf-8") as f:
            json.dump([{"nom": "medias.lan", "url": "https://medias.lan", "amont_ip": "192.168.10.31", "amont_port": 32400}], f)
        self.serveur = HTTPServer(("127.0.0.1", 0), _FauxPhare)
        threading.Thread(target=self.serveur.serve_forever, daemon=True).start()

    def tearDown(self):
        self.serveur.shutdown()

    def _collecteur(self, url):
        cfg = Config(sites_json=self.json, phare_url=url, base=os.path.join(self.dossier, "abysse.db"))
        return Collecteur(cfg, reglages=None, historique=None, sources={})

    def test_sites_remplaces_et_ecrits(self):
        c = self._collecteur(f"http://127.0.0.1:{self.serveur.server_port}")
        self.assertEqual(c._sites[0]["nom"], "medias.lan")
        self.assertEqual(c.actualiser_sites(), 1)
        self.assertEqual(c._sites, SITES)
        with open(os.path.join(self.dossier, "sites-phare.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), SITES)
        # un nouveau collecteur repart du cache, même si Phare ne répond plus
        self.assertEqual(self._collecteur("http://127.0.0.1:1")._sites, SITES)

    def test_phare_injoignable_garde_l_ancienne_liste(self):
        c = self._collecteur("http://127.0.0.1:1")
        with self.assertRaises(ErreurSource):
            c.actualiser_sites()
        self.assertEqual(c._sites[0]["nom"], "medias.lan")
        res = c.actualiser_tout()
        self.assertFalse(res["ok"])
        self.assertEqual(res["sites"], 1)

    def test_sans_phare_relit_le_fichier(self):
        c = self._collecteur("")
        with open(self.json, "w", encoding="utf-8") as f:
            json.dump(SITES, f)
        self.assertEqual(c.actualiser_sites(), 1)
        self.assertEqual(c._sites, SITES)


if __name__ == "__main__":
    unittest.main()
