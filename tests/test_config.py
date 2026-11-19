import dataclasses
import unittest

from abysse.config import Config, charger_config


class TestConfig(unittest.TestCase):
    def test_defauts(self):
        cfg = charger_config({})
        self.assertIsInstance(cfg, Config)
        self.assertEqual(cfg.ecoute_port, 80)
        self.assertEqual(cfg.nut_port, 3493)
        self.assertEqual(cfg.nut_ups, "onduleur")
        self.assertIs(cfg.demo, False)
        self.assertIs(cfg.source_active("mikrotik"), False)
        for nom in ("proxmox", "nut", "influx", "truenas"):
            self.assertIs(cfg.source_active(nom), False, nom)

    def test_repr_masque(self):
        self.assertNotIn("secret", repr(charger_config({"ABYSSE_PVE_JETON": "secret"})))

    def test_repr_masque_tous_les_secrets(self):
        cfg = charger_config({
            "ABYSSE_MIKROTIK_PASS": "motdepasse-mk",
            "ABYSSE_PVE_JETON": "jeton-pve",
            "ABYSSE_INFLUX_JETON": "jeton-influx",
            "ABYSSE_TRUENAS_CLE": "cle-truenas",
            "ABYSSE_MIKROTIK_USER": "abysse",
        })
        texte = repr(cfg) + str(cfg)
        for secret in ("motdepasse-mk", "jeton-pve", "jeton-influx", "cle-truenas"):
            self.assertNotIn(secret, texte)
        # les champs non secrets restent visibles
        self.assertIn("abysse", texte)
        # la valeur reste accessible au code
        self.assertEqual(cfg.pve_jeton, "jeton-pve")

    def test_lecture_des_cles(self):
        cfg = charger_config({
            "ABYSSE_MIKROTIK_URL": "http://192.168.10.198",
            "ABYSSE_PVE_URL": "https://192.168.10.97:8006",
            "ABYSSE_NUT_HOTE": "192.168.10.97",
            "ABYSSE_NUT_PORT": "3494",
            "ABYSSE_ECOUTE_PORT": "8080",
            "ABYSSE_ECOUTE_HOTE": "127.0.0.1",
            "ABYSSE_DEMO": "1",
            "ABYSSE_BASE": "/tmp/a.db",
            "AUTRE_CHOSE": "ignoree",
        })
        self.assertEqual(cfg.mikrotik_url, "http://192.168.10.198")
        self.assertEqual(cfg.nut_port, 3494)
        self.assertEqual(cfg.ecoute_port, 8080)
        self.assertEqual(cfg.ecoute_hote, "127.0.0.1")
        self.assertIs(cfg.demo, True)
        self.assertEqual(cfg.base, "/tmp/a.db")
        self.assertIs(cfg.source_active("mikrotik"), True)
        self.assertIs(cfg.source_active("proxmox"), True)
        self.assertIs(cfg.source_active("nut"), True)
        self.assertIs(cfg.source_active("influx"), False)
        self.assertIs(cfg.source_active("truenas"), False)

    def test_demo_booleen(self):
        for v in ("0", "false", "non", "", "no", "off"):
            self.assertIs(charger_config({"ABYSSE_DEMO": v}).demo, False, v)
        for v in ("1", "true", "TRUE", "oui", "yes", "on"):
            self.assertIs(charger_config({"ABYSSE_DEMO": v}).demo, True, v)

    def test_port_invalide(self):
        with self.assertRaises(ValueError):
            charger_config({"ABYSSE_ECOUTE_PORT": "quatre-vingts"})
        with self.assertRaises(ValueError):
            charger_config({"ABYSSE_NUT_PORT": "70000"})

    def test_source_inconnue(self):
        with self.assertRaises(ValueError):
            charger_config({}).source_active("inexistante")

    def test_gelee(self):
        cfg = charger_config({})
        with self.assertRaises(dataclasses.FrozenInstanceError):
            cfg.demo = True  # type: ignore[misc]

    def test_champs_du_contrat(self):
        attendus = {
            "mikrotik_url", "mikrotik_user", "mikrotik_pass", "pve_url", "pve_jeton", "pve_ca", "pve_noeud",
            "nut_hote", "nut_port", "nut_ups", "influx_url", "influx_jeton", "influx_org",
            "truenas_url", "truenas_utilisateur", "truenas_cle", "truenas_ca", "ecoute_hote", "ecoute_port", "base",
            "dossier_web", "sites_json", "inventaire", "phare_url", "demo",
        }
        self.assertEqual({f.name for f in dataclasses.fields(Config)}, attendus)


if __name__ == "__main__":
    unittest.main()
