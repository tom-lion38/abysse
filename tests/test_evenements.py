"""Tests de ``abysse.evenements`` : évènements entre deux instantanés et reconstitution InfluxDB."""

import copy
import datetime
import unittest

from abysse.evenements import NATURES, comparer, depuis_influx

try:  # « python -m unittest discover -s tests » met tests/ dans sys.path
    from test_modele import FauxReglages, brut_reel, construire, par_id
except ImportError:  # « python -m unittest tests.test_evenements »
    from tests.test_modele import FauxReglages, brut_reel, construire, par_id

NBSP = " "
CLES = {"t", "id", "nom", "nature", "importance", "texte"}


def noeud(id_, etat="on", type_=None, nom=None, jauges=None, details=None):
    if type_ is None:
        type_ = {"ct": "ct", "vm": "vm", "app": "appareil", "site": "site"}.get(id_.split("-")[0], "routeur")
    if details is None:
        details = {}
        if id_.startswith(("ct-", "vm-")):
            details["vmid"] = int(id_.split("-")[1])
    return {"id": id_, "nom": nom or id_, "type": type_, "etat": etat,
            "jauges": jauges or {}, "details": details}


def inst(t, *noeuds):
    return {"t": t, "version": 1, "sources": {}, "noeuds": list(noeuds), "liens": []}


def heure(s):
    """Horodatage InfluxDB (RFC 3339) à partir de secondes depuis le 26/10/2026 00:00 UTC."""
    base = datetime.datetime(2026, 10, 26, tzinfo=datetime.timezone.utc)
    return (base + datetime.timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%SZ")


T0 = datetime.datetime(2026, 10, 26, tzinfo=datetime.timezone.utc).timestamp()


class TestComparer(unittest.TestCase):
    def un(self, evts):
        self.assertEqual(len(evts), 1, evts)
        e = evts[0]
        self.assertEqual(set(e), CLES)
        self.assertIn(e["nature"], NATURES)
        return e

    def test_premier_instantane(self):
        self.assertEqual(comparer(None, inst(1.0, noeud("pve"))), [])

    def test_ct_tombe_importance_2(self):
        avant = inst(10.0, noeud("ct-102", nom="supervision"))
        apres = inst(11.0, noeud("ct-102", "off", nom="supervision"))
        e = self.un(comparer(avant, apres))
        self.assertEqual((e["t"], e["id"], e["nom"], e["nature"], e["importance"]),
                         (11.0, "ct-102", "supervision", "panne", 2))
        self.assertEqual(e["texte"], "CT 102 supervision arrêté")
        r = self.un(comparer(apres, avant))
        self.assertEqual((r["nature"], r["importance"]), ("retour", 2))
        self.assertEqual(r["texte"], "CT 102 supervision redémarré")

    def test_vm_tombe_importance_3(self):
        e = self.un(comparer(inst(1, noeud("vm-200", type_="nas-vm", nom="TrueNAS")),
                             inst(2, noeud("vm-200", "off", type_="nas-vm", nom="TrueNAS"))))
        self.assertEqual((e["nature"], e["importance"], e["texte"]), ("panne", 3, "VM 200 TrueNAS arrêtée"))

    def test_pve_tombe_importance_4(self):
        for id_ in ("pve", "mikrotik", "internet"):
            e = self.un(comparer(inst(1, noeud(id_, nom="X")), inst(2, noeud(id_, "off", nom="X"))))
            self.assertEqual((e["id"], e["nature"], e["importance"]), (id_, "panne", 4))
        e = self.un(comparer(inst(1, noeud("internet", type_="internet", nom="Internet")),
                             inst(2, noeud("internet", "off", type_="internet", nom="Internet"))))
        self.assertEqual(e["texte"], "Internet coupé")

    def test_importance_3_equipements(self):
        for id_, type_ in (("pbs", "sauvegarde"), ("synology", "nas"), ("box", "box"), ("ha", "domotique")):
            e = self.un(comparer(inst(1, noeud(id_, type_=type_, nom="N")), inst(2, noeud(id_, "off", type_=type_, nom="N"))))
            self.assertEqual(e["importance"], 3, id_)
            self.assertEqual(e["texte"], "N hors ligne")

    def test_site_importance_2(self):
        e = self.un(comparer(inst(1, noeud("site-site-d.exemple.fr", nom="site-d.exemple.fr")),
                             inst(2, noeud("site-site-d.exemple.fr", "off", nom="site-d.exemple.fr"))))
        self.assertEqual((e["nature"], e["importance"]), ("panne", 2))
        self.assertEqual(e["texte"], "Site site-d.exemple.fr hors ligne")

    def test_batterie_4_et_retour(self):
        o = lambda secteur, batterie: noeud("onduleur", type_="onduleur", nom="Onduleur",
                                            jauges={"secteur": secteur, "batterie": batterie, "tension": 230 if secteur else 0})
        e = self.un(comparer(inst(1, o(True, 100)), inst(2, o(False, 87))))
        self.assertEqual((e["id"], e["nature"], e["importance"]), ("onduleur", "batterie", 4))
        self.assertEqual(e["texte"], f"Onduleur sur batterie (87{NBSP}%)")
        r = self.un(comparer(inst(2, o(False, 87)), inst(3, o(True, 86))))
        self.assertEqual((r["nature"], r["importance"], r["texte"]), ("secteur", 4, "Courant revenu"))
        # toujours sur batterie : rien
        self.assertEqual(comparer(inst(2, o(False, 87)), inst(3, o(False, 80))), [])
        # NUT muet (jauges absentes) : rien
        self.assertEqual(comparer(inst(1, o(True, 100)), inst(2, noeud("onduleur", "inconnu", type_="onduleur"))), [])

    def test_inconnu_silencieux(self):
        for a, b in (("on", "inconnu"), ("inconnu", "on"), ("off", "inconnu"), ("inconnu", "off"),
                     ("eteint", "inconnu"), ("inconnu", "eteint")):
            for id_ in ("pve", "ct-102", "app-b827eb84224f", "pc"):
                self.assertEqual(comparer(inst(1, noeud(id_, a)), inst(2, noeud(id_, b))), [], (id_, a, b))

    def test_off_eteint_silencieux(self):
        self.assertEqual(comparer(inst(1, noeud("ct-102", "off")), inst(2, noeud("ct-102", "eteint"))), [])
        self.assertEqual(comparer(inst(1, noeud("ct-102", "eteint")), inst(2, noeud("ct-102", "off"))), [])

    def test_eteint_on_importance_1(self):
        e = self.un(comparer(inst(1, noeud("ct-105", "eteint", nom="OpenVPN")), inst(2, noeud("ct-105", nom="OpenVPN"))))
        self.assertEqual((e["nature"], e["importance"], e["texte"]), ("apparition", 1, "CT 105 OpenVPN démarré"))
        e = self.un(comparer(inst(1, noeud("vm-220", nom="windows-server")), inst(2, noeud("vm-220", "eteint", nom="windows-server"))))
        self.assertEqual((e["nature"], e["importance"], e["texte"]), ("depart", 1, "VM 220 windows-server arrêtée"))

    def test_appareils_apparition_depart(self):
        a = "app-b827eb84224f"
        e = self.un(comparer(inst(1, noeud(a, "eteint", nom="raspberry")), inst(2, noeud(a, nom="raspberry"))))
        self.assertEqual((e["nature"], e["importance"], e["texte"]), ("apparition", 1, "raspberry connecté"))
        e = self.un(comparer(inst(1, noeud(a, nom="raspberry")), inst(2, noeud(a, "eteint", nom="raspberry"))))
        self.assertEqual((e["nature"], e["importance"], e["texte"]), ("depart", 1, "raspberry déconnecté"))
        # nouvel appareil présent : apparition ; appareil présent qui disparaît de la liste : départ
        e = self.un(comparer(inst(1), inst(2, noeud(a, nom="raspberry"))))
        self.assertEqual((e["nature"], e["importance"]), ("apparition", 1))
        e = self.un(comparer(inst(1, noeud(a, nom="raspberry")), inst(2)))
        self.assertEqual((e["nature"], e["importance"]), ("depart", 1))
        # nouvel appareil déjà absent, ou appareil absent oublié : rien
        self.assertEqual(comparer(inst(1), inst(2, noeud(a, "eteint"))), [])
        self.assertEqual(comparer(inst(1, noeud(a, "eteint")), inst(2)), [])
        pc = self.un(comparer(inst(1, noeud("pc", "eteint", type_="pc", nom="PC fixe")),
                              inst(2, noeud("pc", type_="pc", nom="PC fixe"))))
        self.assertEqual((pc["nature"], pc["importance"], pc["texte"]), ("apparition", 1, "PC fixe connecté"))

    def test_autres_noeuds_qui_apparaissent_silencieux(self):
        # nouveau CT, site ajouté, nœud démasqué : pas d'évènement (seuls les appareils vont et viennent)
        self.assertEqual(comparer(inst(1), inst(2, noeud("ct-120"), noeud("site-x.fr"))), [])
        self.assertEqual(comparer(inst(1, noeud("ct-120"), noeud("pve")), inst(2)), [])

    def test_stockage_franchissement_unique(self):
        def pbs(pct):
            return noeud("pbs", type_="sauvegarde", nom="PBS", jauges={"disque": {"u": pct, "t": 100}})
        evts = []
        for avant, apres in ((89, 91), (91, 92), (92, 95)):
            evts += comparer(inst(1, pbs(avant)), inst(2, pbs(apres)))
        e = self.un(evts)
        self.assertEqual((e["id"], e["nature"], e["importance"]), ("pbs", "stockage", 3))
        self.assertEqual(e["texte"], f"Stockage de PBS à 91{NBSP}%")
        # redescente, puis jauge inconnue avant : rien
        self.assertEqual(comparer(inst(1, pbs(95)), inst(2, pbs(85))), [])
        self.assertEqual(comparer(inst(1, noeud("pbs", type_="sauvegarde")), inst(2, pbs(95))), [])

    def test_stockage_sur_un_ct_importance_3(self):
        def vm(u):
            return noeud("vm-200", type_="nas-vm", nom="TrueNAS", jauges={"disque": {"u": u, "t": 16_000_000_000_000}})
        e = self.un(comparer(inst(1, vm(14_000_000_000_000)), inst(2, vm(14_450_000_000_000))))
        self.assertEqual((e["nature"], e["importance"]), ("stockage", 3))
        self.assertEqual(e["texte"], f"Stockage de TrueNAS à 90,3{NBSP}%")

    def test_sauvegarde_ratee(self):
        def pbs(s):
            return noeud("pbs", type_="sauvegarde", nom="PBS", details=None if s is None else {"sauvegardes": s})
        e = self.un(comparer(inst(1, pbs({"backup-ct": 1, "backup-vm": 1})), inst(2, pbs({"backup-ct": 0, "backup-vm": 1}))))
        self.assertEqual((e["id"], e["nature"], e["importance"]), ("pbs", "sauvegarde", 3))
        self.assertEqual(e["texte"], "Sauvegarde ratée : backup-ct")
        # entrée nouvelle à 0, clé absente (InfluxDB en erreur), retour à 1 : rien
        self.assertEqual(comparer(inst(1, pbs({})), inst(2, pbs({"backup-ct": 0}))), [])
        self.assertEqual(comparer(inst(1, pbs(None)), inst(2, pbs({"backup-ct": 0}))), [])
        self.assertEqual(comparer(inst(1, pbs({"backup-ct": 1})), inst(2, pbs(None))), [])
        self.assertEqual(comparer(inst(1, pbs({"backup-ct": 0})), inst(2, pbs({"backup-ct": 1}))), [])

    def test_avant_non_modifie(self):
        avant = inst(1, noeud("ct-102"))
        apres = inst(2, noeud("ct-102", "off"))
        copies = copy.deepcopy((avant, apres))
        comparer(avant, apres)
        self.assertEqual((avant, apres), copies)

    def test_instantanes_reels(self):
        """Deux instantanés du modèle (fixtures réelles) : CT 102 qui s'arrête, onduleur sur batterie."""
        avant = construire(t=1000.0)
        brut = brut_reel()
        for r in brut["proxmox"]["ressources"]:
            if r.get("vmid") == 102:
                r["status"] = "stopped"
        brut["nut"]["input.voltage"] = "0"
        brut["nut"]["battery.charge"] = "87"
        apres = construire(brut, t=1001.0)
        self.assertEqual(par_id(apres)["ct-102"]["etat"], "off")
        evts = comparer(avant, apres)
        textes = {e["texte"]: e for e in evts}
        self.assertIn("CT 102 supervision arrêté", textes)
        self.assertEqual(textes["CT 102 supervision arrêté"]["importance"], 2)
        self.assertIn(f"Onduleur sur batterie (87{NBSP}%)", textes)
        self.assertEqual(textes[f"Onduleur sur batterie (87{NBSP}%)"]["importance"], 4)
        # le site grafana suit son CT
        self.assertIn("Site grafana.exemple.fr hors ligne", textes)
        for e in evts:
            self.assertEqual(set(e), CLES)
            self.assertEqual(e["t"], 1001.0)

    def test_nom_par_defaut_sans_doublon(self):
        e = self.un(comparer(inst(1, noeud("ct-150", nom="CT 150")), inst(2, noeud("ct-150", "off", nom="CT 150"))))
        self.assertEqual(e["texte"], "CT 150 arrêté")


class TestDepuisInflux(unittest.TestCase):
    @staticmethod
    def systeme(vmid, objet, nom, uptimes, debut=0):
        return [
            {"_time": heure(debut + 60 * i), "_value": u, "_field": "uptime", "_measurement": "system",
             "host": nom, "nodename": "pve", "object": objet, "vmid": str(vmid)}
            for i, u in enumerate(uptimes)
        ]

    def test_depuis_influx_panne_ct(self):
        evts = depuis_influx(self.systeme(102, "lxc", "supervision", [500, 560, 0, 0, 30]), [])
        self.assertEqual(len(evts), 2, evts)
        panne, retour = evts
        self.assertEqual(set(panne), CLES)
        self.assertEqual((panne["id"], panne["nature"], panne["importance"]), ("ct-102", "panne", 2))
        self.assertEqual(panne["t"], T0 + 120)
        self.assertEqual(panne["texte"], "CT 102 supervision arrêté")
        self.assertEqual((retour["nature"], retour["importance"], retour["t"]), ("retour", 2, T0 + 240))
        self.assertEqual(retour["texte"], "CT 102 supervision redémarré")

    def test_depuis_influx_vm_et_tri(self):
        lignes = self.systeme(200, "qemu", "TrueNAS", [100, 0, 50], debut=30)
        lignes += self.systeme(102, "lxc", "supervision", [500, 0, 0], debut=0)
        lignes.reverse()  # ordre quelconque
        evts = depuis_influx(lignes, [])
        self.assertEqual([(e["id"], e["nature"], e["importance"]) for e in evts],
                         [("ct-102", "panne", 2), ("vm-200", "panne", 3), ("vm-200", "retour", 3)])
        self.assertEqual([e["t"] for e in evts], sorted(e["t"] for e in evts))

    def test_depuis_influx_premiere_valeur_nulle(self):
        # déjà arrêté au début de la fenêtre : pas de panne inventée, seulement le retour
        evts = depuis_influx(self.systeme(105, "lxc", "OpenVPN", [0, 0, 12]), [])
        self.assertEqual([(e["nature"], e["texte"]) for e in evts], [("retour", "CT 105 OpenVPN redémarré")])

    def test_depuis_influx_ignore_autres_champs(self):
        lignes = self.systeme(102, "lxc", "supervision", [500, 0, 30])
        lignes += [dict(l, _field="cpu", _value=0) for l in self.systeme(102, "lxc", "supervision", [1, 1, 1])]
        lignes += [{"_time": "pas une date", "_value": 0, "_field": "uptime", "vmid": "102", "object": "lxc"},
                   {"_time": heure(10), "_value": None, "_field": "uptime", "vmid": "102", "object": "lxc"},
                   {"_time": heure(10), "_value": 0, "_field": "uptime", "vmid": "abc", "object": "lxc"}]
        self.assertEqual(len(depuis_influx(lignes, [])), 2)

    def test_depuis_influx_batterie(self):
        upsd = [{"_time": heure(60 * i), "_value": v, "_field": "input_voltage", "_measurement": "upsd", "ups_name": "onduleur"}
                for i, v in enumerate([230.0, 231.0, 0.0, 0.0, 229.0])]
        evts = depuis_influx([], upsd)
        self.assertEqual(len(evts), 2, evts)
        b, s = evts
        self.assertEqual((b["id"], b["nature"], b["importance"], b["t"]), ("onduleur", "batterie", 4, T0 + 120))
        self.assertEqual(b["texte"], "Onduleur sur batterie")
        self.assertEqual((s["nature"], s["importance"], s["t"], s["texte"]), ("secteur", 4, T0 + 240, "Courant revenu"))

    def test_depuis_influx_heures_fractionnaires(self):
        lignes = [{"_time": "2026-10-26T00:01:00.123456789Z", "_value": 10, "_field": "uptime", "vmid": "102", "object": "lxc", "host": "s"},
                  {"_time": "2026-10-26T00:02:00.5Z", "_value": 0, "_field": "uptime", "vmid": "102", "object": "lxc", "host": "s"}]
        e, = depuis_influx(lignes, [])
        self.assertAlmostEqual(e["t"], T0 + 120.5, places=3)


if __name__ == "__main__":
    unittest.main()
