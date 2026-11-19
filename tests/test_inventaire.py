"""Tests de ``inventaire.charger`` : inventaire décrit dans un fichier JSON."""

import copy
import json
import os
import tempfile
import unittest

from abysse import inventaire as inv

from test_modele import brut_reel, construire, par_id

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXEMPLE = os.path.join(RACINE, "deploy", "inventaire.exemple.json")
_MUTABLES = ("EQUIPEMENTS", "PORTS_FIXES", "IP_VM", "KUMA", "SUPERVISION_SEULE", "ETEINTS_EXPRES",
             "VM_SPECIALES", "URL_INVITES")
_SIMPLES = ("PORT_WAN", "IP_CADDY_PUBLIC", "PREFIXE_SAUVEGARDE", "POOL_TRUENAS")


class TestChargerInventaire(unittest.TestCase):
    def setUp(self):
        self.sauvegarde = {n: copy.deepcopy(getattr(inv, n)) for n in _MUTABLES + _SIMPLES}
        self.dossier = tempfile.TemporaryDirectory()
        self.addCleanup(self.dossier.cleanup)

    def tearDown(self):
        for n in _MUTABLES:
            cible = getattr(inv, n)
            cible.clear() if isinstance(cible, dict) else cible.clear()
            (cible.update if isinstance(cible, dict) else cible.extend)(self.sauvegarde[n])
        for n in _SIMPLES:
            setattr(inv, n, self.sauvegarde[n])

    def _ecrire(self, donnees) -> str:
        chemin = os.path.join(self.dossier.name, "inventaire.json")
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(donnees, f)
        return chemin

    def test_exemple_identique_aux_valeurs_par_defaut(self):
        avant = copy.deepcopy(inv.EQUIPEMENTS)
        inv.charger(EXEMPLE)
        self.assertEqual(inv.EQUIPEMENTS, avant)
        self.assertEqual(inv.VM_SPECIALES, self.sauvegarde["VM_SPECIALES"])
        self.assertEqual(inv.IP_VM, self.sauvegarde["IP_VM"])

    def test_remplacement_sur_place(self):
        reference = inv.EQUIPEMENTS
        inv.charger(self._ecrire({
            "equipements": {"mikrotik": {"nom": "Routeur", "type": "routeur", "groupe": "mikrotik",
                                         "parent": None, "niveau": 0, "ip": "192.168.50.1", "url": None}},
            "port_wan": "ether8", "ip_vm": {"300": "192.168.50.30"}, "eteints_expres": [],
        }))
        self.assertIs(inv.EQUIPEMENTS, reference)  # les autres modules gardent la même référence
        self.assertEqual(list(inv.EQUIPEMENTS), ["mikrotik"])
        self.assertEqual(inv.PORT_WAN, "ether8")
        self.assertEqual(inv.IP_VM, {300: "192.168.50.30"})
        self.assertEqual(inv.ETEINTS_EXPRES, [])

    def test_fichier_invalide(self):
        cas = [
            [],
            {"cle_inconnue": 1},
            {"port_wan": 5},
            {"equipements": {"pve": {"nom": "pve"}}},
            {"equipements": {"pve": {"nom": "pve", "type": "hyperviseur", "groupe": "pve", "parent": None,
                                     "niveau": 1, "ip": None, "url": None}}},  # pas de mikrotik
        ]
        for donnees in cas:
            with self.subTest(donnees=donnees), self.assertRaises(ValueError):
                inv.charger(self._ecrire(donnees))
        self.assertIn("box", inv.EQUIPEMENTS)  # un fichier refusé ne change rien

    def test_inventaire_minimal(self):
        """Seulement le routeur et l'hyperviseur : l'instantané se construit sans erreur."""
        inv.charger(self._ecrire({
            "equipements": {
                "mikrotik": {"nom": "Routeur", "type": "routeur", "groupe": "mikrotik", "parent": None,
                             "niveau": 0, "ip": "192.168.10.198", "url": None},
                "pve": {"nom": "pve", "type": "hyperviseur", "groupe": "pve", "parent": "mikrotik",
                        "niveau": 1, "ip": "192.168.10.97", "url": None},
            },
            "ports_fixes": {"pve": ["ether6", "ether7"]}, "kuma": {}, "supervision_seule": [],
            "eteints_expres": [],
        }))
        noeuds = par_id(construire(brut_reel()))
        for absent in ("box", "internet", "pbs", "synology", "onduleur", "pc", "ha"):
            self.assertNotIn(absent, noeuds)
        self.assertEqual(noeuds["mikrotik"]["etat"], "on")
        self.assertEqual(noeuds["pve"]["etat"], "on")
        self.assertIn("ct-102", noeuds)


if __name__ == "__main__":
    unittest.main()
