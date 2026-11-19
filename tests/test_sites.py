"""Tests de ``abysse.sites`` : analyse du Caddyfile et rattachement des sites."""

import json
import os
import subprocess
import sys
import unittest

from abysse import sites

ICI = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(ICI, "fixtures", "caddyfile_assaini.txt")
RACINE = os.path.dirname(ICI)


def _caddyfile_reel() -> str:
    with open(FIXTURE, encoding="utf-8") as f:
        return f.read()


def _par_nom(liste):
    return {s["nom"]: s for s in liste}


class TestCaddyfile(unittest.TestCase):
    def test_caddyfile_reel(self):
        liste = sites.analyser_caddyfile(_caddyfile_reel())
        par_nom = _par_nom(liste)
        self.assertEqual(par_nom["exemple.fr"]["amont_ip"], "192.168.10.186")  # pas le handle /etat-homelab
        self.assertEqual(par_nom["exemple.fr"]["amont_port"], 80)
        self.assertEqual(par_nom["exemple.fr"]["url"], "https://exemple.fr")
        self.assertEqual(par_nom["site-a.exemple.fr"]["amont_ip"], "192.168.10.106")
        self.assertEqual(par_nom["site-a.exemple.fr"]["amont_port"], 3000)
        self.assertEqual(par_nom["pve.lan"]["amont_ip"], "192.168.10.97")  # schéma https:// toléré
        self.assertEqual(par_nom["pve.lan"]["amont_port"], 8006)
        self.assertEqual(par_nom["grafana.exemple.fr"]["amont_ip"], "192.168.10.55")  # http:// toléré
        self.assertEqual(par_nom["grafana.exemple.fr"]["amont_port"], 3000)
        self.assertEqual(par_nom["photos.exemple.fr"]["amont_ip"], "192.168.10.211")
        self.assertEqual(par_nom["ha.lan"]["amont_ip"], "192.168.0.224")
        for s in liste:
            self.assertFalse(s["nom"].startswith("("), s["nom"])
            self.assertEqual(set(s), {"nom", "url", "amont_ip", "amont_port"})
            self.assertEqual(s["url"], "https://" + s["nom"])
        self.assertNotIn("trafic", " ".join(par_nom))
        self.assertNotIn("lan_only", " ".join(par_nom))

    def test_un_par_nom(self):
        liste = sites.analyser_caddyfile(_caddyfile_reel())
        noms = [s["nom"] for s in liste]
        self.assertEqual(len(noms), len(set(noms)))
        self.assertIn("boutique.lan", noms)  # « boutique.lan, https://192.168.10.17:8443 {»
        self.assertIn("192.168.10.17:8443", noms)
        self.assertEqual(_par_nom(liste)["192.168.10.17:8443"]["amont_ip"], "192.168.10.144")

    def test_sans_reverse_proxy(self):
        par_nom = _par_nom(sites.analyser_caddyfile(_caddyfile_reel()))
        self.assertIsNone(par_nom["ancien.exemple.fr"]["amont_ip"])  # redir seulement
        self.assertIsNone(par_nom["ancien.exemple.fr"]["amont_port"])
        # ts3 : seul reverse_proxy dans un handle conditionnel, faute de mieux on le prend
        self.assertEqual(par_nom["vocal.exemple.fr"]["amont_ip"], "192.168.10.93")

    def test_plusieurs_noms(self):
        texte = "a.lan, b.lan {\n\treverse_proxy 192.168.10.80:81\n}\nc.lan d.lan {\n  reverse_proxy 192.168.10.177\n}\n"
        par_nom = _par_nom(sites.analyser_caddyfile(texte))
        self.assertEqual(set(par_nom), {"a.lan", "b.lan", "c.lan", "d.lan"})
        self.assertEqual(par_nom["a.lan"]["amont_ip"], "192.168.10.80")
        self.assertEqual(par_nom["b.lan"]["amont_port"], 81)
        self.assertEqual(par_nom["d.lan"]["amont_ip"], "192.168.10.177")
        self.assertEqual(par_nom["d.lan"]["amont_port"], 80)

    def test_accolades_dans_les_chaines(self):
        texte = (
            "{\n\temail moi@exemple.fr\n}\n"
            "(snip) {\n\treverse_proxy 192.168.10.90:1\n}\n"
            "x.lan {\n"
            "\trespond \"texte avec { et } dedans\" 200 # commentaire {\n"
            "\theader_up X-Forwarded-For {remote_host}\n"
            "\treverse_proxy @api 192.168.10.21:9000\n"
            "\treverse_proxy 192.168.10.118:8080 {\n\t\theader_up Host {host}\n\t}\n"
            "}\n"
            "y.lan {\n\treverse_proxy [fd00::1]:8443\n}\n"
        )
        par_nom = _par_nom(sites.analyser_caddyfile(texte))
        self.assertEqual(set(par_nom), {"x.lan", "y.lan"})
        self.assertEqual(par_nom["x.lan"]["amont_ip"], "192.168.10.118")  # sans matcher d'abord
        self.assertEqual(par_nom["x.lan"]["amont_port"], 8080)
        self.assertEqual(par_nom["y.lan"]["amont_ip"], "fd00::1")
        self.assertEqual(par_nom["y.lan"]["amont_port"], 8443)

    def test_texte_vide_ou_casse(self):
        self.assertEqual(sites.analyser_caddyfile(""), [])
        # accolade jamais fermée : pas d'exception
        self.assertIsInstance(sites.analyser_caddyfile("a.lan {\n reverse_proxy 192.168.10.1\n"), list)
        self.assertIsInstance(sites.analyser_caddyfile("}\n}\nb.lan {\n}\n"), list)

    def test_cli(self):
        sortie = subprocess.run(
            [sys.executable, "-m", "abysse.sites", FIXTURE],
            cwd=RACINE, capture_output=True, timeout=30, check=True,
        )
        liste = json.loads(sortie.stdout.decode("utf-8"))
        self.assertEqual(_par_nom(liste)["site-a.exemple.fr"]["amont_ip"], "192.168.10.106")


class TestParent(unittest.TestCase):
    def test_parent(self):
        site = {"nom": "site-a.exemple.fr", "url": "https://site-a.exemple.fr", "amont_ip": "192.168.10.106", "amont_port": 3000}
        self.assertEqual(sites.parent_du_site(site, {"192.168.10.106": "ct-124"}), "ct-124")

    def test_parent_equipement(self):
        def site(ip):
            return {"nom": "x", "url": "https://x", "amont_ip": ip, "amont_port": 443}

        self.assertEqual(sites.parent_du_site(site("192.168.10.97"), {}), "pve")
        self.assertEqual(sites.parent_du_site(site("192.168.10.156"), {}), "pbs")
        self.assertEqual(sites.parent_du_site(site("192.168.10.253"), {}), "synology")
        self.assertEqual(sites.parent_du_site(site("192.168.0.224"), {}), "ha")
        self.assertEqual(sites.parent_du_site(site("192.168.10.97"), {"192.168.10.97": "pve"}), "pve")

    def test_parent_inconnu(self):
        self.assertIsNone(sites.parent_du_site({"nom": "x", "amont_ip": "10.9.9.9"}, {}))
        self.assertIsNone(sites.parent_du_site({"nom": "x", "amont_ip": None}, {}))
        self.assertIsNone(sites.parent_du_site({"nom": "x"}, {"192.168.10.106": "ct-124"}))


if __name__ == "__main__":
    unittest.main()
