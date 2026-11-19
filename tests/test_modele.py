"""Tests de l'inventaire et de la construction de l'instantané.

Les données viennent de fixtures relevées sur un homelab puis anonymisées (``tests/fixtures``) ;
les extraits InfluxDB (``influx_extraits.csv``) sont recopiés à la main en dict.
"""

import copy
import json
import math
import os
import unittest

from abysse import inventaire
from abysse.debit import CompteurDebit
from abysse.modele import construire_instantane

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _json(nom):
    with open(os.path.join(FIXTURES, nom), encoding="utf-8") as f:
        return json.load(f)


def _texte(nom):
    with open(os.path.join(FIXTURES, nom), encoding="utf-8") as f:
        return f.read()


def _onboot():
    configs = {}
    for ligne in _texte("pve_onboot.txt").splitlines():
        if ligne.strip():
            vmid, onboot = ligne.split()
            configs[int(vmid)] = {"onboot": int(onboot), "ip": None}
    return configs


def _nut():
    valeurs = {}
    for ligne in _texte("nut_upsc.txt").splitlines():
        if ":" in ligne:
            cle, valeur = ligne.split(":", 1)
            valeurs[cle.strip()] = valeur.strip()
    return valeurs


class FauxReglages:
    """Même interface que ``reglages.Reglages``, sans base."""

    def __init__(self, noms=None, caches=None, eteints_expres=None, liens=None):
        self.noms = dict(noms or {})
        self.caches = set(caches or ())
        self.eteints_expres = set(
            {"switch-1", "switch-2", "camera"} if eteints_expres is None else eteints_expres
        )
        self.liens = list(liens or [])


def brut_reel():
    configs = _onboot()
    configs[124]["ip"] = "192.168.10.106"
    configs[143]["ip"] = "192.168.10.186"
    configs[102]["ip"] = "192.168.10.55"
    return {
        "mikrotik": {
            "interfaces": _json("mikrotik_interfaces.json"),
            "ressource": _json("mikrotik_resource.json"),
            "arp": _json("mikrotik_arp.json"),
            "hotes_pont": _json("mikrotik_bridge_hosts.json"),
            "baux": [],
            "dhcp_client": [{"interface": "ether1", "status": "bound", "address": "192.168.0.23/24"}],
        },
        "proxmox": {
            "ressources": _json("pve_cluster_resources.json"),
            "noeud": _json("pve_node_status.json"),
            "configs": configs,
        },
        "nut": _nut(),
        # Recopié à la main depuis influx_extraits.csv (dernières valeurs).
        "influx": {
            "kuma": {
                "net-box": 1,
                "host-homeassistant": 1,
                "net-switch-1": 0,
                "net-switch-2": 0,
                "net-camera": 0,
                "host-synology": 1,
                "host-pbs": 1,
                "host-pve": 1,
                "backup-hote-pve": 1,
            },
            "synology": {
                "raid_total_size": 1964250939392,
                "raid_free_size": 849346379776,
                "system_status": 1,
            },
            "pbs_pool": {"size": 15977278341120, "alloc": 2545320828928, "health": "ONLINE"},
        },
        "sites": [
            {"nom": "exemple.fr", "url": "https://exemple.fr", "amont_ip": "192.168.10.186", "amont_port": 80},
            {"nom": "site-a.exemple.fr", "url": "https://site-a.exemple.fr", "amont_ip": "192.168.10.106", "amont_port": 3000},
            {"nom": "pve.exemple.fr", "url": "https://pve.exemple.fr", "amont_ip": "192.168.10.97", "amont_port": 8006},
            {"nom": "grafana.exemple.fr", "url": "https://grafana.exemple.fr", "amont_ip": "192.168.10.55", "amont_port": 3000},
        ],
    }


def construire(brut=None, reglages=None, debits=None, t=1000.0):
    return construire_instantane(
        brut_reel() if brut is None else brut,
        FauxReglages() if reglages is None else reglages,
        CompteurDebit() if debits is None else debits,
        t,
    )


def par_id(inst):
    return {n["id"]: n for n in inst["noeuds"]}


def liens_par_id(inst):
    return {l["id"]: l for l in inst["liens"]}


def invites(inst):
    return [n for n in inst["noeuds"] if n["id"].startswith(("ct-", "vm-"))]


class TestInventaire(unittest.TestCase):
    def test_equipements(self):
        eq = inventaire.EQUIPEMENTS
        for cle in ("mikrotik", "box", "internet", "pve", "pbs", "synology", "pc",
                    "onduleur", "ha", "switch-1", "switch-2", "camera"):
            self.assertIn(cle, eq)
            for champ in ("nom", "type", "groupe", "parent", "ip", "url"):
                self.assertIn(champ, eq[cle], f"{cle}.{champ}")
        self.assertEqual(eq["mikrotik"]["nom"], "Routeur MikroTik")
        self.assertEqual(eq["mikrotik"]["ip"], "192.168.10.198")
        self.assertIsNone(eq["mikrotik"]["parent"])
        self.assertEqual(eq["internet"]["parent"], "box")
        self.assertIsNone(eq["internet"]["ip"])
        self.assertEqual(eq["onduleur"]["parent"], "pve")
        self.assertEqual(eq["onduleur"]["url"], "https://ups.lan")
        self.assertEqual(eq["synology"]["url"], "https://nas.lan:5001")
        self.assertEqual(eq["camera"]["groupe"], "reseau")
        self.assertEqual(eq["ha"]["parent"], "box")

    def test_constantes(self):
        self.assertEqual(inventaire.PORTS_FIXES, {"box": ["ether1"], "pve": ["ether6", "ether7"], "synology": ["ether5"]})
        self.assertEqual(inventaire.IP_VM, {210: "192.168.10.34", 200: "192.168.10.31"})
        self.assertEqual(inventaire.KUMA["switch-2"], "net-switch-2")
        self.assertEqual(inventaire.KUMA["pbs"], "host-pbs")

    def test_fabricant(self):
        self.assertEqual(inventaire.fabricant("B8:27:EB:84:22:4F"), "Raspberry Pi")
        self.assertEqual(inventaire.fabricant("b8-27-eb-84-22-4f"), "Raspberry Pi")
        self.assertIsNone(inventaire.fabricant("02:11:22:33:44:55"))
        self.assertIsNone(inventaire.fabricant(""))


class TestModele(unittest.TestCase):
    def test_contrat(self):
        inst = construire()
        self.assertEqual(inst["version"], 1)
        self.assertEqual(inst["t"], 1000.0)
        for n in inst["noeuds"]:
            self.assertEqual(
                set(n), {"id", "nom", "type", "groupe", "parent", "niveau", "etat", "ip", "url", "jauges", "details"}, n["id"]
            )
            self.assertIn(n["etat"], {"on", "off", "eteint", "inconnu"}, n["id"])
        for l in inst["liens"]:
            self.assertEqual(set(l), {"id", "de", "vers", "type", "etat", "descendant", "montant"}, l["id"])
            self.assertEqual(l["id"], f"{l['de']}>{l['vers']}")
        json.dumps(inst, allow_nan=False)  # sérialisable, sans NaN

    def test_amont_inconnu_va_au_caddy_en_marche(self):
        # L'ancien Caddy (CT 110) est arrêté mais garde 192.168.10.17 ; le neuf est en marche.
        brut = brut_reel()
        brut["proxmox"]["configs"][110]["ip"] = "192.168.10.17"
        brut["proxmox"]["configs"][140]["ip"] = "192.168.10.17"   # le CT en marche joue le Caddy neuf
        for r in brut["proxmox"]["ressources"]:
            if r.get("vmid") == 110:
                r["status"] = "stopped"
        brut["sites"].append({"nom": "inconnu.exemple.fr", "url": "https://inconnu.exemple.fr", "amont_ip": "10.9.9.9"})
        noeuds = par_id(construire(brut))
        self.assertEqual(noeuds["site-inconnu.exemple.fr"]["parent"], "ct-140")

    def test_tous_les_invites(self):
        inst = construire()
        ids = {n["id"] for n in invites(inst)}
        self.assertEqual(len(ids), 29)
        self.assertIn("vm-220", ids)
        self.assertIn("ct-110", ids)
        noeuds = par_id(inst)
        self.assertEqual(noeuds["vm-200"]["type"], "nas-vm")
        self.assertEqual(noeuds["vm-200"]["groupe"], "truenas")
        self.assertEqual(noeuds["vm-210"]["type"], "vm")
        self.assertEqual(noeuds["ct-102"]["type"], "ct")
        self.assertEqual(noeuds["ct-102"]["nom"], "supervision")
        self.assertEqual(noeuds["ct-102"]["parent"], "pve")
        self.assertEqual(noeuds["ct-102"]["ip"], "192.168.10.55")
        self.assertEqual(noeuds["vm-210"]["ip"], "192.168.10.34")  # repli IP_VM

    def test_ct300_eteint(self):
        noeuds = par_id(construire())
        self.assertEqual(noeuds["ct-105"]["etat"], "eteint")
        self.assertEqual(noeuds["ct-102"]["etat"], "on")

    def test_ct_arrete_onboot_off(self):
        brut = brut_reel()
        for r in brut["proxmox"]["ressources"]:
            if r.get("vmid") == 102:
                r["status"] = "stopped"
        noeuds = par_id(construire(brut))
        self.assertEqual(noeuds["ct-102"]["etat"], "off")
        liens = liens_par_id(construire(brut))
        self.assertEqual(liens["pve>ct-102"]["etat"], "off")

    def test_ct_arrete_eteint_expres(self):
        brut = brut_reel()
        for r in brut["proxmox"]["ressources"]:
            if r.get("vmid") == 102:
                r["status"] = "stopped"
        reglages = FauxReglages(eteints_expres={"ct-102"})
        self.assertEqual(par_id(construire(brut, reglages))["ct-102"]["etat"], "eteint")

    def test_source_proxmox_erreur(self):
        debits = CompteurDebit()
        construire(debits=debits, t=1000.0)
        brut = brut_reel()
        brut["proxmox"] = None
        inst = construire(brut, debits=debits, t=1002.0)
        noeuds = par_id(inst)
        self.assertEqual(inst["sources"]["proxmox"], "erreur")
        self.assertEqual(len(invites(inst)), 29)  # les invités connus restent affichés
        for n in invites(inst):
            self.assertEqual(n["etat"], "inconnu", n["id"])
        self.assertEqual(noeuds["pve"]["etat"], "inconnu")
        self.assertEqual(noeuds["mikrotik"]["etat"], "on")
        self.assertEqual(noeuds["onduleur"]["etat"], "on")
        self.assertEqual(noeuds["site-site-a.exemple.fr"]["etat"], "inconnu")
        for l in inst["liens"]:
            if l["de"] == "pve" and l["vers"].startswith(("ct-", "vm-")):
                self.assertEqual(l["etat"], "inconnu")
                self.assertIsNone(l["descendant"])

    def test_source_proxmox_erreur_au_demarrage(self):
        brut = brut_reel()
        brut["proxmox"] = None
        inst = construire(brut)
        noeuds = par_id(inst)
        self.assertEqual(noeuds["pve"]["etat"], "inconnu")
        self.assertEqual(noeuds["mikrotik"]["etat"], "on")
        self.assertFalse([n for n in inst["noeuds"] if n["etat"] == "off"])

    def test_source_mikrotik_erreur(self):
        brut = brut_reel()
        brut["mikrotik"] = None
        inst = construire(brut)
        noeuds = par_id(inst)
        self.assertEqual(inst["sources"]["mikrotik"], "erreur")
        for i in ("mikrotik", "pc", "internet"):
            self.assertEqual(noeuds[i]["etat"], "inconnu", i)
        self.assertEqual(noeuds["box"]["etat"], "on")  # repli sur la sonde Kuma
        self.assertEqual(noeuds["ct-102"]["etat"], "on")
        self.assertIsNone(liens_par_id(inst)["mikrotik>box"]["montant"])

    def test_sources_statuts(self):
        brut = brut_reel()
        brut["influx"] = None
        inst = construire(brut)
        self.assertEqual(
            inst["sources"],
            {"mikrotik": "ok", "proxmox": "ok", "nut": "ok", "influx": "erreur", "truenas": "desactivee"},
        )
        noeuds = par_id(inst)
        self.assertEqual(noeuds["ha"]["etat"], "inconnu")
        self.assertEqual(noeuds["switch-1"]["etat"], "inconnu")
        self.assertNotIn("disque", noeuds["pbs"]["jauges"])

    def test_nut_muet(self):
        brut = brut_reel()
        brut["nut"] = None
        noeuds = par_id(construire(brut))
        self.assertEqual(noeuds["onduleur"]["etat"], "inconnu")
        self.assertEqual(noeuds["onduleur"]["jauges"], {})

    def test_onduleur_secteur(self):
        brut = brut_reel()
        brut["nut"]["input.voltage"] = "230"
        o = par_id(construire(brut))["onduleur"]
        self.assertIs(o["jauges"]["secteur"], True)
        self.assertEqual(o["jauges"]["batterie"], 100)
        self.assertEqual(o["jauges"]["autonomie"], 3000)
        self.assertEqual(o["jauges"]["tension"], 230.0)
        brut["nut"]["input.voltage"] = "0"  # le drapeau reste « OL » : on se fie à la tension
        o = par_id(construire(brut))["onduleur"]
        self.assertIs(o["jauges"]["secteur"], False)
        self.assertEqual(o["etat"], "on")

    def test_pve_jauges(self):
        brut = brut_reel()
        pve = par_id(construire(brut))["pve"]
        self.assertTrue(0 <= pve["jauges"]["cpu"] <= 1)
        self.assertEqual(pve["jauges"]["ram"]["t"], brut["proxmox"]["noeud"]["memory"]["total"])
        self.assertEqual(pve["jauges"]["ram"]["u"], brut["proxmox"]["noeud"]["memory"]["used"])
        self.assertEqual(pve["details"]["uptime"], 112510)
        self.assertEqual(pve["details"]["version"], "pve-manager/9.2.21")

    def test_jauges_stockage(self):
        brut = brut_reel()
        brut["truenas"] = {"pools": {"NAS": {"taille": 16_000_000_000_000, "alloue": 2_200_000_000_000, "etat": "ONLINE"}}}
        noeuds = par_id(construire(brut))
        self.assertEqual(noeuds["vm-200"]["jauges"]["disque"], {"u": 2_200_000_000_000, "t": 16_000_000_000_000})
        self.assertEqual(noeuds["pbs"]["jauges"]["disque"], {"u": 2545320828928, "t": 15977278341120})
        self.assertEqual(
            noeuds["synology"]["jauges"]["disque"],
            {"u": 1964250939392 - 849346379776, "t": 1964250939392},
        )
        ct = noeuds["ct-102"]["jauges"]
        self.assertTrue(0 <= ct["cpu"] <= 1)
        self.assertEqual(ct["ram"], {"u": 979267584, "t": 8589934592})

    def test_mikrotik_jauges_et_chaines(self):
        brut = brut_reel()
        m = par_id(construire(brut))["mikrotik"]
        self.assertAlmostEqual(m["jauges"]["cpu"], 0.04)
        self.assertEqual(m["jauges"]["ram"], {"u": 1073741824 - 901230592, "t": 1073741824})
        self.assertEqual(m["details"]["uptime"], 110111)  # « 1970-01-02 06:35:11 » de :serialize
        # L'API REST renvoie tout en chaînes et l'uptime au format 1w2d3h4m5s.
        brut = brut_reel()
        ch = brut["mikrotik"]
        ch["ressource"] = {k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in ch["ressource"].items()}
        ch["ressource"]["uptime"] = "1d6h35m11s"
        ch["interfaces"] = [
            {k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in i.items()} for i in ch["interfaces"]
        ]
        ch["arp"] = [{k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in a.items()} for a in ch["arp"]]
        inst = construire(brut)
        noeuds = par_id(inst)
        self.assertAlmostEqual(noeuds["mikrotik"]["jauges"]["cpu"], 0.04)
        self.assertEqual(noeuds["mikrotik"]["details"]["uptime"], 110111)
        self.assertEqual(noeuds["box"]["etat"], "on")
        self.assertEqual(noeuds["pc"]["etat"], "on")

    def test_lien_wan_sens(self):
        debits = CompteurDebit()
        brut = brut_reel()
        inst = construire(brut, debits=debits, t=1000.0)
        self.assertIsNone(liens_par_id(inst)["mikrotik>box"]["montant"])  # premier échantillon
        brut2 = brut_reel()
        for i in brut2["mikrotik"]["interfaces"]:
            if i["name"] == "ether1":
                i["rx-byte"] = str(i["rx-byte"] + 1_250_000)  # chaîne, comme l'API REST
        inst = construire(brut2, debits=debits, t=1001.0)
        lien = liens_par_id(inst)["mikrotik>box"]
        self.assertEqual(lien["montant"], 10_000_000.0)
        self.assertEqual(lien["descendant"], 0.0)
        self.assertEqual(lien["type"], "ethernet")
        wan = liens_par_id(inst)["box>internet"]
        self.assertEqual(wan["type"], "wan")
        self.assertEqual(wan["montant"], 10_000_000.0)

    def test_debit_heure_de_lecture(self):
        """Même lecture de source réutilisée : le débit déjà calculé est conservé."""
        debits = CompteurDebit()
        brut = brut_reel()
        brut["mikrotik"]["t"] = 50.0
        construire(brut, debits=debits, t=1000.0)
        brut2 = brut_reel()
        brut2["mikrotik"]["t"] = 51.0
        for i in brut2["mikrotik"]["interfaces"]:
            if i["name"] == "ether1":
                i["rx-byte"] += 1_250_000
        self.assertEqual(liens_par_id(construire(brut2, debits=debits, t=1001.0))["mikrotik>box"]["montant"], 10_000_000.0)
        # instantané suivant, source pas relue (même t) : même débit, pas None
        self.assertEqual(liens_par_id(construire(brut2, debits=debits, t=1002.0))["mikrotik>box"]["montant"], 10_000_000.0)

    def test_debit_invite_rafraichi_toutes_les_10_s(self):
        """Proxmox ne met netin/netout à jour qu'environ toutes les 10 s : pas de 0 puis de pic."""
        debits = CompteurDebit()

        def lecture(t, netin):
            brut = brut_reel()
            brut["proxmox"]["t"] = t
            for r in brut["proxmox"]["ressources"]:
                if r.get("vmid") == 102:
                    r["netin"] = netin
            return liens_par_id(construire(brut, debits=debits, t=t))["pve>ct-102"]["descendant"]

        base = 1_000_000
        self.assertIsNone(lecture(0.0, base))
        # premier changement vu : il sert de base alignée sur un rafraîchissement, pas encore de débit
        self.assertIsNone(lecture(10.0, base + 1_250_000))
        self.assertIsNone(lecture(12.0, base + 1_250_000))
        self.assertEqual(lecture(20.0, base + 2_500_000), 1_000_000.0)
        self.assertEqual(lecture(22.0, base + 2_500_000), 1_000_000.0)  # compteur pas encore rafraîchi
        self.assertEqual(lecture(30.0, base + 3_750_000), 1_000_000.0)
        self.assertEqual(lecture(60.0, base + 3_750_000), 0.0)  # vraiment au repos

    def test_debit_invite_premiere_lecture_au_milieu_d_une_fenetre(self):
        """Collecteur démarré entre deux rafraîchissements Proxmox : jamais de pic au départ."""
        debits = CompteurDebit()
        base = 1_000_000
        vus = {}
        t = 8.0
        while t <= 40.0:
            brut = brut_reel()
            brut["proxmox"]["t"] = t
            # 1 Mbit/s réel, compteur rafraîchi aux multiples de 10 s
            netin = base + 1_250_000 * int(t // 10)
            for r in brut["proxmox"]["ressources"]:
                if r.get("vmid") == 102:
                    r["netin"] = netin
            vus[t] = liens_par_id(construire(brut, debits=debits, t=t))["pve>ct-102"]["descendant"]
            t += 2.0
        for t, v in vus.items():
            self.assertTrue(v is None or v <= 1_000_000.0, (t, v))
        for t in (8.0, 10.0, 12.0, 14.0, 16.0, 18.0):
            self.assertIsNone(vus[t], t)
        for t in (20.0, 26.0, 30.0, 40.0):
            self.assertEqual(vus[t], 1_000_000.0, t)

    def test_debit_invite_au_repos_des_le_depart(self):
        """Compteur qui ne bouge jamais : 0 bit/s une fois la fenêtre de gel dépassée, pas None à vie."""
        debits = CompteurDebit()

        def lecture(t):
            brut = brut_reel()
            brut["proxmox"]["t"] = t
            return liens_par_id(construire(brut, debits=debits, t=t))["pve>ct-102"]["descendant"]

        self.assertIsNone(lecture(0.0))
        self.assertIsNone(lecture(10.0))
        self.assertEqual(lecture(30.0), 0.0)

    def test_compteur_qui_recule(self):
        debits = CompteurDebit()
        construire(debits=debits, t=0.0)
        brut = brut_reel()
        for i in brut["mikrotik"]["interfaces"]:
            i["rx-byte"], i["tx-byte"] = 10, 10  # redémarrage du MikroTik
        inst = construire(brut, debits=debits, t=1.0)
        for l in inst["liens"]:
            for sens in ("descendant", "montant"):
                self.assertTrue(l[sens] is None or l[sens] >= 0, l["id"])
        self.assertIsNone(liens_par_id(inst)["mikrotik>pve"]["descendant"])

    def test_liens_ports(self):
        debits = CompteurDebit()
        construire(debits=debits, t=0.0)
        brut = brut_reel()
        ports = {i["name"]: i for i in brut["mikrotik"]["interfaces"]}
        ports["ether6"]["tx-byte"] += 1_000_000
        ports["ether7"]["tx-byte"] += 250_000
        ports["ether3"]["rx-byte"] += 125_000  # PBS, trouvé par ARP puis table du pont
        ports["ether8"]["tx-byte"] += 125_000  # PC fixe
        ports["ether5"]["rx-byte"] += 12_500  # Synology (port fixe)
        liens = liens_par_id(construire(brut, debits=debits, t=1.0))
        self.assertEqual(liens["mikrotik>pve"]["descendant"], 10_000_000.0)
        self.assertEqual(liens["mikrotik>pbs"]["montant"], 1_000_000.0)
        self.assertEqual(liens["mikrotik>pc"]["descendant"], 1_000_000.0)
        self.assertEqual(liens["mikrotik>synology"]["montant"], 100_000.0)
        self.assertEqual(liens["pve>onduleur"]["type"], "usb")
        self.assertIsNone(liens["pve>onduleur"]["descendant"])
        self.assertEqual(liens["pve>ct-102"]["type"], "virtuel")
        self.assertIsNone(liens["box>ha"]["descendant"])

    def test_etats_equipements(self):
        noeuds = par_id(construire())
        for i in ("mikrotik", "box", "internet", "pve", "pbs", "synology", "pc", "onduleur", "ha"):
            self.assertEqual(noeuds[i]["etat"], "on", i)
        for i in ("switch-1", "switch-2", "camera"):  # Kuma à 0, mais éteints exprès
            self.assertEqual(noeuds[i]["etat"], "eteint", i)

    def test_panne_kuma_rouge(self):
        brut = brut_reel()
        brut["influx"]["kuma"]["host-homeassistant"] = 0
        brut["influx"]["kuma"]["net-switch-1"] = 0
        noeuds = par_id(construire(brut, FauxReglages(eteints_expres=set())))
        self.assertEqual(noeuds["ha"]["etat"], "off")
        self.assertEqual(noeuds["switch-1"]["etat"], "off")

    def test_sauvegardes_pbs(self):
        """Sondes Kuma backup-* dans l'instantané (évènement « sauvegarde PBS ratée »)."""
        pbs = par_id(construire())["pbs"]
        self.assertEqual(pbs["details"]["sauvegardes"], {"backup-hote-pve": 1})
        brut = brut_reel()
        brut["influx"]["kuma"]["backup-hote-pve"] = 0
        brut["influx"]["kuma"]["backup-truenas"] = "1"  # tolère les chaînes
        brut["influx"]["kuma"]["backup-illisible"] = "?"  # valeur illisible : ignorée
        pbs = par_id(construire(brut))["pbs"]
        self.assertEqual(pbs["details"]["sauvegardes"], {"backup-hote-pve": 0, "backup-truenas": 1})
        self.assertEqual(pbs["etat"], "on")  # une sauvegarde ratée ne met pas le PBS en panne
        brut = brut_reel()
        brut["influx"] = None  # source en erreur : pas de liste, plutôt qu'une liste vide trompeuse
        self.assertNotIn("sauvegardes", par_id(construire(brut))["pbs"]["details"])

    def test_wan_perdu(self):
        brut = brut_reel()
        brut["mikrotik"]["dhcp_client"] = [{"interface": "ether1", "status": "searching..."}]
        self.assertEqual(par_id(construire(brut))["internet"]["etat"], "off")
        brut = brut_reel()
        for i in brut["mikrotik"]["interfaces"]:
            if i["name"] == "ether1":
                i["running"] = False
        noeuds = par_id(construire(brut))
        self.assertEqual(noeuds["box"]["etat"], "off")
        self.assertEqual(liens_par_id(construire(brut))["mikrotik>box"]["etat"], "off")

    def test_reglage_nom_et_cache(self):
        reglages = FauxReglages(noms={"ct-102": "Supervision (CT 102)", "pve": "Hyperviseur"}, caches={"ct-124"})
        inst = construire(reglages=reglages)
        noeuds = par_id(inst)
        self.assertEqual(noeuds["ct-102"]["nom"], "Supervision (CT 102)")
        self.assertEqual(noeuds["pve"]["nom"], "Hyperviseur")
        self.assertNotIn("ct-124", noeuds)
        self.assertNotIn("site-site-a.exemple.fr", noeuds)  # le site du CT caché part avec lui
        for l in inst["liens"]:
            self.assertNotIn("ct-124", (l["de"], l["vers"]))
        for n in inst["noeuds"]:
            self.assertIn(n["parent"], set(noeuds) | {None}, n["id"])

    def test_liens_manuels(self):
        reglages = FauxReglages(
            liens=[
                {"id": "lien-1", "nom": "Wiki", "url": "https://wiki.lan", "parent": "ct-102"},
                {"id": "lien-2", "nom": "Orphelin", "url": "https://x.lan", "parent": "ct-424242"},
            ]
        )
        inst = construire(reglages=reglages)
        noeuds = par_id(inst)
        self.assertEqual(noeuds["lien-1"]["type"], "site")
        self.assertEqual(noeuds["lien-1"]["niveau"], 3)
        self.assertEqual(noeuds["lien-1"]["url"], "https://wiki.lan")
        self.assertEqual(noeuds["lien-1"]["etat"], "on")
        self.assertIn("ct-102>lien-1", liens_par_id(inst))
        self.assertNotIn("lien-2", noeuds)

    def test_sites(self):
        brut = brut_reel()
        for r in brut["proxmox"]["ressources"]:
            if r.get("vmid") == 124:
                r["status"] = "stopped"
        inst = construire(brut)
        noeuds = par_id(inst)
        s = noeuds["site-site-a.exemple.fr"]
        self.assertEqual(s["parent"], "ct-124")
        self.assertEqual(s["url"], "https://site-a.exemple.fr")
        self.assertEqual(s["type"], "site")
        self.assertEqual(s["etat"], "off")  # site = état de son CT
        self.assertEqual(noeuds["site-exemple.fr"]["parent"], "ct-143")
        self.assertEqual(noeuds["site-pve.exemple.fr"]["parent"], "pve")
        self.assertEqual(noeuds["site-pve.exemple.fr"]["groupe"], "pve")
        self.assertEqual(liens_par_id(inst)["ct-124>site-site-a.exemple.fr"]["type"], "site")

    def test_ids_uniques(self):
        brut = brut_reel()
        brut["sites"].append(dict(brut["sites"][0]))  # doublon dans le Caddyfile
        inst = construire(brut)
        ids = [n["id"] for n in inst["noeuds"]]
        self.assertEqual(len(ids), len(set(ids)))
        ids_liens = [l["id"] for l in inst["liens"]]
        self.assertEqual(len(ids_liens), len(set(ids_liens)))
        # chaque nœud sauf le MikroTik a exactement un lien vers son parent
        noeuds = par_id(inst)
        for n in inst["noeuds"]:
            if n["parent"] is not None:
                self.assertIn(f"{n['parent']}>{n['id']}", set(ids_liens), n["id"])
                self.assertIn(n["parent"], noeuds)

    def test_niveaux(self):
        noeuds = par_id(construire())
        self.assertEqual(noeuds["mikrotik"]["niveau"], 0)
        for i in ("box", "pve", "pbs", "synology", "pc"):
            self.assertEqual(noeuds[i]["niveau"], 1, i)
        for i in ("internet", "ha", "switch-1", "camera", "onduleur", "ct-102", "vm-200"):
            self.assertEqual(noeuds[i]["niveau"], 2, i)
        self.assertEqual(noeuds["site-pve.exemple.fr"]["niveau"], 3)
        self.assertEqual(noeuds["site-exemple.fr"]["niveau"], 3)
        for n in noeuds.values():
            if n["id"].startswith("app-"):
                self.assertEqual(n["niveau"], 1)

    def test_appareil_nom(self):
        brut = brut_reel()
        m = brut["mikrotik"]
        m["arp"] += [
            {"address": "192.168.10.230", "mac-address": "B8:27:EB:84:22:4F", "interface": "bridge", "complete": True, "status": "reachable"},
            {"address": "192.168.10.74", "mac-address": "AA:BB:CC:00:11:22", "interface": "bridge", "complete": True, "status": "stale"},
            {"address": "192.168.10.171", "mac-address": "02:11:22:33:44:55", "interface": "bridge", "complete": True, "status": "reachable"},
            {"address": "192.168.10.15", "interface": "bridge", "complete": False, "status": "failed"},
        ]
        m["hotes_pont"].append({"mac-address": "B8:27:EB:84:22:4F", "on-interface": "ether4", "local": False})
        m["baux"] = [
            {"address": "192.168.10.74", "mac-address": "AA:BB:CC:00:11:22", "host-name": "imprimante", "status": "bound"},
            {"address": "192.168.10.188", "mac-address": "DC:A6:32:01:02:03", "status": "waiting"},
        ]
        noeuds = par_id(construire(brut))
        rpi = noeuds["app-b827eb84224f"]
        self.assertEqual(rpi["nom"], "Appareil Raspberry Pi")
        self.assertEqual(rpi["type"], "appareil")
        self.assertEqual(rpi["groupe"], "appareils")
        self.assertEqual(rpi["parent"], "mikrotik")
        self.assertEqual(rpi["ip"], "192.168.10.230")
        self.assertEqual(rpi["etat"], "on")
        self.assertEqual(noeuds["app-aabbcc001122"]["nom"], "imprimante")  # bail DHCP host-name
        self.assertEqual(noeuds["app-021122334455"]["nom"], "Appareil 02:11:22:33:44:55")
        absent = noeuds["app-dca632010203"]  # bail, mais absent de l'ARP
        self.assertEqual(absent["etat"], "eteint")
        self.assertEqual(absent["nom"], "Appareil Raspberry Pi")
        # pas d'appareil pour les invités Proxmox, les équipements, le côté box
        ips_appareils = {n["ip"] for n in noeuds.values() if n["id"].startswith("app-")}
        for ip in ("192.168.10.97", "192.168.10.55", "192.168.10.156", "192.168.10.253", "192.168.10.187", "192.168.0.224", "192.168.0.88"):
            self.assertNotIn(ip, ips_appareils)

    def test_appareil_qui_part(self):
        debits = CompteurDebit()
        brut = brut_reel()
        brut["mikrotik"]["arp"].append(
            {"address": "192.168.10.230", "mac-address": "B8:27:EB:84:22:4F", "interface": "bridge", "complete": True, "status": "reachable"}
        )
        self.assertEqual(par_id(construire(brut, debits=debits, t=0.0))["app-b827eb84224f"]["etat"], "on")
        # disparu de l'ARP, sans bail : éteint, puis oublié au bout d'un jour
        self.assertEqual(par_id(construire(debits=debits, t=60.0))["app-b827eb84224f"]["etat"], "eteint")
        self.assertNotIn("app-b827eb84224f", par_id(construire(debits=debits, t=60.0 + 2 * 86400)))

    def test_pc_tom_absent(self):
        brut = brut_reel()
        brut["mikrotik"]["arp"] = [a for a in brut["mikrotik"]["arp"] if a.get("address") != "192.168.10.187"]
        self.assertEqual(par_id(construire(brut))["pc"]["etat"], "eteint")

    def test_aucun_nan(self):
        brut = brut_reel()
        brut["nut"]["battery.charge"] = "nan"
        brut["proxmox"]["noeud"]["cpu"] = float("nan")
        inst = construire(brut)
        json.dumps(inst, allow_nan=False)
        texte = json.dumps(inst)
        self.assertNotIn("NaN", texte)
        self.assertNotIn("Infinity", texte)

    def test_brut_non_modifie(self):
        brut = brut_reel()
        avant = copy.deepcopy(brut)
        construire(brut)
        self.assertEqual(brut, avant)


if __name__ == "__main__":
    unittest.main()
