"""Mode démo : fausses données réalistes, au format exact des sources réelles.

``sources_demo()`` rend le même dict que les sources du collecteur (nom → ``(fonction, période)``) ;
les fonctions renvoient les mêmes formes que ``sources/*.py`` (nombres en chaînes comme l'API
REST de RouterOS, ``{"data"}`` déjà retiré pour Proxmox, valeurs NUT en chaînes…).

Scénario en direct (temps écoulé depuis le lancement) : pointe de trafic WAN de 10 s toutes
les 90 s, un CT qui s'arrête 20 s toutes les 2 min (à partir de 40 s), coupure de courant de
25 s toutes les 5 min (à partir de 2 min 30), un appareil (console) qui part 1 min toutes les
3 min.

``remplir_historique`` simule les 24 dernières heures avec des incidents de chaque importance
(1 appareil, 2 CT, 3 VM / PBS / sauvegarde / stockage, 4 onduleur / Internet / Abysse
injoignable) et enregistre instantanés et évènements, pour que la frise ait de quoi rejouer.
"""

from __future__ import annotations

import math
import random
import time
import zlib
from collections.abc import Callable
from typing import NamedTuple

from . import evenements
from .collecteur import assembler
from .debit import CompteurDebit
from .modele import construire_instantane
from . import inventaire

H = 3600.0
MIN = 60.0
GIO = 1024 ** 3
TO = 1_000_000_000_000

PERIODES = {"mikrotik": 1, "mikrotik_lent": 15, "proxmox": 2, "proxmox_configs": 300,
            "nut": 2, "influx": 30, "truenas": 120}

# (vmid, type, nom, IP, RAM max, onboot, débit moyen descendant, montant en bit/s, charge CPU)
INVITES = [
    (120, "lxc", "ticketing", "192.168.10.102", 4 * GIO, 1, 60e3, 20e3, 0.01),
    (100, "lxc", "pihole", "192.168.10.228", 2 * GIO, 1, 900e3, 700e3, 0.03),
    (121, "lxc", "outils", "192.168.10.115", 2 * GIO, 1, 120e3, 300e3, 0.02),
    (122, "lxc", "wiki", "192.168.10.68", GIO // 2, 1, 80e3, 250e3, 0.01),
    (101, "lxc", "portail", "192.168.10.17", GIO // 2, 1, 40e3, 90e3, 0.005),
    (123, "lxc", "jeux-stats", "192.168.10.203", GIO, 1, 150e3, 600e3, 0.02),
    (124, "lxc", "site-a", "192.168.10.106", GIO, 1, 200e3, 900e3, 0.02),
    (125, "lxc", "site-b", "192.168.10.224", 4 * GIO, 1, 180e3, 700e3, 0.03),
    (210, "qemu", "telephonie", "192.168.10.34", 4 * GIO, 1, 90e3, 90e3, 0.04),
    (126, "lxc", "projet", "192.168.10.18", GIO // 2, 1, 30e3, 60e3, 0.005),
    (102, "lxc", "supervision", "192.168.10.55", 8 * GIO, 1, 3.2e6, 1.1e6, 0.09),
    (103, "lxc", "ups-web", "192.168.10.72", GIO // 2, 1, 20e3, 30e3, 0.01),
    (104, "lxc", "trafic", "192.168.10.190", GIO, 1, 400e3, 150e3, 0.03),
    (127, "lxc", "boutique", "192.168.10.144", 2 * GIO, 1, 160e3, 500e3, 0.02),
    (200, "qemu", "TrueNAS", "192.168.10.31", 32 * GIO, 1, 6e6, 14e6, 0.07),
    (220, "qemu", "windows-server", "192.168.10.128", 32 * GIO, 0, 0.0, 0.0, 0.0),
    (130, "lxc", "recettes", "192.168.10.229", GIO // 2, 1, 50e3, 180e3, 0.01),
    (131, "lxc", "sport", "192.168.10.73", GIO // 2, 1, 40e3, 120e3, 0.01),
    (132, "lxc", "notes", "192.168.10.170", GIO // 2, 1, 60e3, 220e3, 0.01),
    (128, "lxc", "site-c", "192.168.10.165", 4 * GIO, 1, 120e3, 800e3, 0.02),
    (129, "lxc", "site-d", "192.168.10.9", 4 * GIO, 1, 110e3, 700e3, 0.02),
    (105, "lxc", "OpenVPN", "192.168.10.249", 2 * GIO, 0, 0.0, 0.0, 0.0),
    (140, "lxc", "vocal", "192.168.10.93", 4 * GIO, 1, 300e3, 300e3, 0.02),
    (106, "lxc", "photos", "192.168.10.211", GIO, 1, 50e3, 80e3, 0.01),
    (141, "lxc", "assistant", "192.168.10.30", 8 * GIO, 1, 250e3, 900e3, 0.04),
    (199, "lxc", "test-web", "192.168.10.60", 4 * GIO, 1, 30e3, 60e3, 0.01),
    (142, "lxc", "budget", "192.168.10.127", 4 * GIO, 1, 300e3, 1.2e6, 0.05),
    (143, "lxc", "site-perso", "192.168.10.186", GIO // 2, 1, 200e3, 1.5e6, 0.02),
    (110, "lxc", "Caddy", "192.168.10.59", 4 * GIO, 1, 7e6, 9e6, 0.06),
]
_INVITE = {i[0]: i for i in INVITES}

# CT qui s'arrêtent tour à tour dans le scénario en direct (tous en onboot=1 : rouges).
ROTATION_ARRETS = (104, 130, 123, 129, 132)


def _site(nom: str, ip: str | None, port: int | None) -> dict:
    return {"nom": nom, "url": "https://" + nom, "amont_ip": ip, "amont_port": port}


# Même forme que ``python -m abysse.sites <Caddyfile>``.
SITES = [
    _site("exemple.fr", "192.168.10.186", 80),
    _site("pve.exemple.fr", "192.168.10.97", 8006),
    _site("ha.exemple.fr", "192.168.0.224", 8123),
    _site("nas.exemple.fr", "192.168.10.253", 5001),
    _site("outils.exemple.fr", "192.168.10.115", 80),
    _site("vocal.exemple.fr", "192.168.10.93", 80),
    _site("photos.exemple.fr", "192.168.10.211", 8000),
    _site("assistant.exemple.fr", "192.168.10.30", 80),
    _site("budget.exemple.fr", "192.168.10.127", 3000),
    _site("wiki.exemple.fr", "192.168.10.68", 80),
    _site("site-c.exemple.fr", "192.168.10.165", 80),
    _site("jeux.exemple.fr", "192.168.10.203", 5173),
    _site("site-d.exemple.fr", "192.168.10.9", 80),
    _site("site-a.exemple.fr", "192.168.10.106", 3000),
    _site("notes.exemple.fr", "192.168.10.170", 8080),
    _site("projet.exemple.fr", "192.168.10.18", 80),
    _site("grafana.exemple.fr", "192.168.10.55", 3000),
    _site("recettes.exemple.fr", "192.168.10.229", 3000),
    _site("sport.exemple.fr", "192.168.10.73", 3100),
    _site("exemple.com", "192.168.10.224", 3000),
    _site("www.exemple.com", None, None),
    _site("boutique.exemple.com", "192.168.10.144", 3000),
    _site("kuma.lan", "192.168.10.55", 3001),
    _site("ups.lan", "192.168.10.72", 8080),
    _site("pbs.lan", "192.168.10.156", 8007),
    _site("medias.lan", "192.168.10.31", 32400),
]

# Machines du LAN vues par le MikroTik : (clé, MAC, IP, port, nom DHCP ou None)
LAN = [
    ("pve", "02:00:00:03:73:22", "192.168.10.97", "ether6", None),
    ("pbs", "D8:9E:F3:F4:F8:22", "192.168.10.156", "ether3", None),
    ("synology", "00:11:32:A1:BA:F5", "192.168.10.253", "ether5", None),
    ("pc", "3C:7C:3F:09:F9:5D", "192.168.10.187", "ether2", "PC-FIXE"),
    ("rpi", "DC:A6:32:D0:B7:3E", "192.168.10.230", "ether4", "rpi-domotique"),
    ("console", "02:00:00:CA:5D:72", "192.168.10.74", "ether8", "console-salon"),
    ("imprimante", "24:62:AB:3F:11:A0", "192.168.10.171", "ether4", None),
]
_LAN = {l[0]: l for l in LAN}

_PORTS = ["ether1", "ether2", "ether3", "ether4", "ether5", "ether6", "ether7", "ether8", "sfp-sfpplus1"]


class Incident(NamedTuple):
    debut: float
    fin: float
    nature: str  # pointe_wan, wan_coupe, coupure, ct_arret, vm_arret, pbs_panne, sauvegarde_ratee, stockage, absent
    cible: object = None


class ReglagesDemo:
    """Réglages par défaut (même interface que ``reglages.Reglages``), sans base."""

    def __init__(self) -> None:
        self.noms: dict[str, str] = {}
        self.caches: set[str] = set()
        self.eteints_expres: set[str] = set(inventaire.ETEINTS_EXPRES)
        self.liens: list[dict] = []


def _uptime_routeros(s: float) -> str:
    """Secondes → ``1w2d3h4m5s`` (format de l'API REST de RouterOS)."""
    s = int(max(0, s))
    morceaux = []
    for unite, duree in (("w", 604800), ("d", 86400), ("h", 3600), ("m", 60)):
        if s >= duree:
            morceaux.append(f"{s // duree}{unite}")
            s %= duree
    morceaux.append(f"{s}s")
    return "".join(morceaux)


class Demo:
    """Homelab simulé. ``incidents=None`` : scénario en direct périodique à partir de ``t0``."""

    def __init__(self, horloge: Callable[[], float] = time.time, incidents: list[Incident] | None = None,
                 t0: float | None = None, graine: int = 116) -> None:
        self._horloge = horloge
        self._incidents = incidents
        self.t0 = horloge() if t0 is None else t0
        self._alea = random.Random(graine)
        self._cumul: dict[str, float] = {}
        self._t_cumul: dict[str, float] = {}
        self._demarrage: dict[int, float | None] = {v: self.t0 - 86400 * (3 + v % 5) - v for v in _INVITE}
        self._charge = 100.0
        self._t_charge: float | None = None
        self._boot_mikrotik = self.t0 - 110_111
        self._boot_pve = self.t0 - 112_493

    # ----------------------------------------------------------------- scénario

    def actifs(self, t: float) -> set[tuple[str, object]]:
        if self._incidents is not None:
            return {(i.nature, i.cible) for i in self._incidents if i.debut <= t < i.fin}
        e = t - self.t0
        a: set[tuple[str, object]] = set()
        if e % 90 >= 80:
            a.add(("pointe_wan", None))
        if e >= 40 and (e - 40) % 120 < 20:
            a.add(("ct_arret", ROTATION_ARRETS[int((e - 40) // 120) % len(ROTATION_ARRETS)]))
        if e >= 150 and (e - 150) % 300 < 25:
            a.add(("coupure", None))
        if e % 180 >= 120:
            a.add(("absent", "console"))
        return a

    def _bruit(self, amplitude: float = 0.15) -> float:
        return 1.0 + self._alea.uniform(-amplitude, amplitude)

    def _integrer(self, cle: str, t: float, bps: float) -> int:
        """Compteur d'octets cumulé (débit ``bps`` depuis la lecture précédente)."""
        avant = self._t_cumul.get(cle)
        if avant is None:
            self._cumul[cle] = float(zlib.crc32(cle.encode()) % 50_000_000_000)
        elif t > avant:
            self._cumul[cle] += max(0.0, bps) * (t - avant) / 8
        self._t_cumul[cle] = t
        return int(self._cumul[cle])

    def _remettre_a_zero(self, cle: str, t: float) -> None:
        self._cumul[cle] = 0.0
        self._t_cumul[cle] = t

    # ----------------------------------------------------------------- MikroTik

    def _debits_ports(self, t: float, a: set) -> dict[str, tuple[float, float, bool]]:
        """port -> (rx, tx, running) en bit/s, rx = reçu par le MikroTik."""
        vague = 1 + 0.35 * math.sin(t / 37) + 0.15 * math.sin(t / 7.3)
        wan_rx = 22e6 * vague * self._bruit()
        wan_tx = 3.5e6 * vague * self._bruit()
        if ("pointe_wan", None) in a:
            wan_rx *= 14
            wan_tx *= 4
        if ("wan_coupe", None) in a:
            wan_rx, wan_tx = 20e3, 5e3
        console = ("absent", "console") not in a
        return {
            "ether1": (wan_rx, wan_tx, True),
            "ether2": (wan_tx * 0.3 + 0.6e6, wan_rx * 0.18 + 1.2e6, ("absent", "pc") not in a),
            "ether3": (0.4e6 * self._bruit(), 1.1e6 * self._bruit(), True),
            "ether4": (0.15e6 * self._bruit(), 0.08e6 * self._bruit(), True),
            "ether5": (0.6e6 * self._bruit(), 2.4e6 * self._bruit(), True),
            "ether6": (wan_tx * 0.65 + 2.5e6, wan_rx * 0.7 + 3.1e6, True),
            "ether7": (2e3, 1e3, True),  # bond actif/secours : lien de secours presque muet
            "ether8": ((1.5e6, wan_rx * 0.12 + 4e6, True) if console else (0.0, 0.0, False)),
            "sfp-sfpplus1": (0.0, 0.0, False),
        }

    def mikrotik_rapide(self) -> dict:
        t = self._horloge()
        a = self.actifs(t)
        interfaces = []
        for n, (nom, (rx, tx, marche)) in enumerate(self._debits_ports(t, a).items(), start=2):
            interfaces.append({
                ".id": f"*{n:X}", "name": nom, "type": "ether", "running": "true" if marche else "false",
                "disabled": "false", "rx-byte": str(self._integrer(f"if:{nom}:rx", t, rx)),
                "tx-byte": str(self._integrer(f"if:{nom}:tx", t, tx)),
            })
        interfaces.append({".id": "*C", "name": "bridge", "type": "bridge", "running": "true", "disabled": "false",
                           "rx-byte": str(self._integrer("if:bridge:rx", t, 6e6)),
                           "tx-byte": str(self._integrer("if:bridge:tx", t, 30e6))})
        charge = 3 + 3 * self._alea.random() + (18 if ("pointe_wan", None) in a else 0)
        libre = 901_230_592 - int(20_000_000 * self._alea.random())
        return {
            "interfaces": interfaces,
            "ressource": {
                "board-name": "RB5009UG+S+", "cpu-count": "4", "cpu-load": str(int(charge)),
                "free-memory": str(libre), "total-memory": "1073741824",
                "uptime": _uptime_routeros(t - self._boot_mikrotik), "version": "7.23.8 (long-term)",
            },
        }

    def mikrotik_lent(self) -> dict:
        t = self._horloge()
        a = self.actifs(t)
        arp, baux, pont = [], [], []
        for cle, mac, ip, port, nom_dhcp in LAN:
            present = ("absent", cle) not in a
            if present:
                arp.append({"address": ip, "mac-address": mac, "interface": "bridge", "status": "reachable",
                            "complete": "true", "dynamic": "true"})
                pont.append({"mac-address": mac, "on-interface": port, "bridge": "bridge", "local": "false"})
            elif cle == "pc":
                arp.append({"address": ip, "mac-address": mac, "interface": "bridge", "status": "failed",
                            "complete": "false", "dynamic": "true"})
            if nom_dhcp is not None:
                baux.append({"address": ip, "mac-address": mac, "host-name": nom_dhcp,
                             "status": "bound" if present else "waiting"})
        arp.append({"address": "192.168.0.1", "mac-address": "02:00:00:D8:77:D5", "interface": "ether1",
                    "status": "reachable", "complete": "true", "dynamic": "true"})
        statut = "searching..." if ("wan_coupe", None) in a else "bound"
        return {
            "arp": arp, "baux": baux, "hotes_pont": pont,
            "dhcp_client": [{"interface": "ether1", "status": statut, "address": "192.168.0.23/24"}],
        }

    # ----------------------------------------------------------------- Proxmox

    def _arrete(self, vmid: int, a: set) -> bool:
        return _INVITE[vmid][5] == 0 or ("ct_arret", vmid) in a or ("vm_arret", vmid) in a

    def proxmox(self) -> dict:
        t = self._horloge()
        a = self.actifs(t)
        tq = math.floor(t / 10) * 10  # Proxmox ne rafraîchit netin/netout qu'environ toutes les 10 s
        pointe = 4.0 if ("pointe_wan", None) in a else 1.0
        ressources = [{"id": "node/pve", "type": "node", "node": "pve", "status": "online"}]
        cpu_total, mem_total = 0.0, 0
        for vmid, type_, nom, _ip, maxmem, _onboot, desc, mont, cpu in INVITES:
            arrete = self._arrete(vmid, a)
            r = {"id": f"{type_}/{vmid}", "type": type_, "vmid": vmid, "name": nom, "node": "pve",
                 "template": 0, "maxmem": maxmem, "maxcpu": 2 if type_ == "lxc" else 4,
                 "maxdisk": 16 * GIO, "disk": 4 * GIO}
            if arrete:
                self._demarrage[vmid] = None
                self._remettre_a_zero(f"pve:{vmid}:in", tq)
                self._remettre_a_zero(f"pve:{vmid}:out", tq)
                r.update(status="stopped", cpu=0, mem=0, uptime=0, netin=0, netout=0)
            else:
                if self._demarrage.get(vmid) is None:
                    self._demarrage[vmid] = t
                facteur = pointe if vmid in (110, 200, 102) else 1.0
                c = min(1.0, cpu * self._bruit(0.5) * (1.6 if facteur > 1 else 1))
                m = int(maxmem * (0.18 + 0.25 * ((vmid * 7919) % 100) / 100) * self._bruit(0.03))
                r.update(status="running", cpu=c, mem=m, uptime=int(t - self._demarrage[vmid]),
                         netin=self._integrer(f"pve:{vmid}:in", tq, desc * facteur * self._bruit()),
                         netout=self._integrer(f"pve:{vmid}:out", tq, mont * facteur * self._bruit()))
                cpu_total += c * r["maxcpu"]
                mem_total += m
            ressources.append(r)
        ressources.append({"id": "storage/pve/nvme-vm", "type": "storage", "storage": "nvme-vm",
                           "status": "available"})
        total = 137_438_953_472
        noeud = {
            "cpu": min(1.0, 0.02 + cpu_total / 12), "cpuinfo": {"cpus": 12, "model": "Intel(R) Xeon(R) CPU E5-2690 v4"},
            "memory": {"total": total, "used": min(total, 9 * GIO + mem_total), "free": max(0, total - 9 * GIO - mem_total)},
            "uptime": int(t - self._boot_pve), "pveversion": "pve-manager/9.2.21/7b2c1f0e9d4a3c5b",
        }
        return {"ressources": ressources, "noeud": noeud}

    def proxmox_configs(self) -> dict:
        return {vmid: {"onboot": onboot, "ip": ip if type_ == "lxc" else None}
                for vmid, type_, _n, ip, _m, onboot, *_ in INVITES}

    # ----------------------------------------------------------------- NUT

    def nut(self) -> dict:
        t = self._horloge()
        coupure = ("coupure", None) in self.actifs(t)
        if self._t_charge is not None and t > self._t_charge:
            dt = t - self._t_charge
            self._charge += (-0.35 if coupure else 0.08) * dt
            self._charge = min(100.0, max(5.0, self._charge))
        self._t_charge = t
        charge = round(self._charge)
        charge_ups = 18 + int(4 * self._alea.random())
        if coupure:
            tension, statut = 0.0, "OB DISCHRG"
            autonomie = int(3000 * self._charge / 100 * 0.9)
        else:
            tension = 231.0 + self._alea.uniform(-3, 4)
            statut = "OL" if charge >= 100 else "OL CHRG"
            autonomie = int(3000 * self._charge / 100)
        return {
            "battery.charge": str(charge), "battery.runtime": str(autonomie), "battery.voltage": "2.26",
            "device.type": "ups", "input.frequency": "50.0" if not coupure else "0.0",
            "input.voltage": f"{tension:.1f}", "output.voltage": "230.0", "ups.load": str(charge_ups),
            "ups.status": statut, "ups.temperature": "23.0",
        }

    # ----------------------------------------------------------------- InfluxDB, TrueNAS

    def influx(self) -> dict:
        t = self._horloge()
        a = self.actifs(t)
        kuma = {
            "backup-quotidien-pbs": 0 if ("sauvegarde_ratee", None) in a else 1,
            "backup-truenas": 1,
            "host-homeassistant": 1, "host-pbs": 0 if ("pbs_panne", None) in a else 1, "host-synology": 1,
            "net-switch-2": 0, "net-switch-1": 0, "net-camera": 0,
            "net-box": 1,
        }
        return {
            "kuma": dict(sorted(kuma.items())),
            "synology": {"raid_total_size": 2_990_000_000_000, "raid_free_size": 1_160_000_000_000, "system_status": 1},
            "pbs_pool": {"size": 3_840_000_000_000, "alloc": 1_420_000_000_000 + int((t - self.t0) * 1000),
                         "health": "ONLINE"},
        }

    def truenas(self) -> dict:
        t = self._horloge()
        plein = ("stockage", None) in self.actifs(t)
        alloue = 14_650_000_000_000 if plein else 2_200_000_000_000
        return {"pools": {
            "NAS": {"taille": 16 * TO, "alloue": alloue, "etat": "ONLINE"},
            "boot-pool": {"taille": 32_000_000_000, "alloue": 3_100_000_000, "etat": "ONLINE"},
        }}

    def sources(self) -> dict:
        return {
            "mikrotik": (self.mikrotik_rapide, PERIODES["mikrotik"]),
            "mikrotik_lent": (self.mikrotik_lent, PERIODES["mikrotik_lent"]),
            "proxmox": (self.proxmox, PERIODES["proxmox"]),
            "proxmox_configs": (self.proxmox_configs, PERIODES["proxmox_configs"]),
            "nut": (self.nut, PERIODES["nut"]),
            "influx": (self.influx, PERIODES["influx"]),
            "truenas": (self.truenas, PERIODES["truenas"]),
        }


def sources_demo(horloge: Callable[[], float] = time.time) -> dict:
    """Sources factices au format du collecteur : ``{nom: (fonction() -> dict, période_s)}``."""
    return Demo(horloge=horloge).sources()


# --------------------------------------------------------------------------- historique factice

def incidents_historique(maintenant: float) -> list[Incident]:
    """Incidents des 24 dernières heures (au moins un de chaque importance)."""
    d = maintenant - 24 * H

    def i(debut_h: float, duree_min: float, nature: str, cible: object = None) -> Incident:
        debut = d + debut_h * H
        return Incident(debut, debut + duree_min * MIN, nature, cible)

    return [
        i(0.3, 8 * 60, "absent", "pc"),            # PC fixe éteint la nuit (importance 1)
        i(0.0, 20 * 60, "absent", "console"),      # console branchée seulement en soirée (1)
        i(21.5, 2.5 * 60, "absent", "console"),
        i(4.0, 2, "coupure"),                      # onduleur sur batterie puis courant revenu (4)
        i(7.0, 5, "ct_arret", 104),                # CT trafic arrêté (2)
        i(10.0, 6, "wan_coupe"),                   # Internet coupé (4)
        i(11.5, 1.5, "pointe_wan"),
        i(13.0, 15, "vm_arret", 210),              # VM 210 arrêtée (3)
        i(16.0, 10, "pbs_panne"),                  # PBS injoignable (3)
        i(18.0, 3, "ct_arret", 123),               # (2)
        i(19.0, 60, "sauvegarde_ratee"),           # sauvegarde PBS ratée (3)
        i(20.5, 120, "stockage"),                  # TrueNAS au-dessus de 90 % (3)
        i(22.0, 2, "ct_arret", 130),               # (2)
        i(23.2, 1, "pointe_wan"),
    ]


def _pas_de_simulation(debut: float, fin: float, incidents: list[Incident], pas: float = 120.0,
                       fin_pas: float = 10.0, marge: float = 60.0) -> list[float]:
    """Un instant toutes les 2 min, toutes les 10 s autour de chaque début / fin d'incident."""
    instants = set()
    t = debut
    while t <= fin:
        instants.add(round(t, 3))
        t += pas
    for inc in incidents:
        for bord in (inc.debut, inc.fin):
            t = bord - marge
            while t <= bord + marge:
                if debut <= t <= fin:
                    instants.add(round(t, 3))
                t += fin_pas
    return sorted(instants)


def remplir_historique(historique, maintenant: float) -> None:
    """24 h d'historique factice (instantanés + évènements de chaque importance)."""
    incidents = incidents_historique(maintenant)
    debut = maintenant - 24 * H
    # Abysse lui-même injoignable 12 min (trou dans les instantanés, ping énorme).
    trou_debut, trou_fin = debut + 8.5 * H, debut + 8.5 * H + 12 * MIN
    horloge = {"t": debut}
    d = Demo(horloge=lambda: horloge["t"], incidents=incidents, t0=debut)
    sources = d.sources()
    debits = CompteurDebit()
    reglages = ReglagesDemo()
    precedent = None
    tous: list[dict] = []
    for t in _pas_de_simulation(debut, maintenant - 1, incidents):
        if trou_debut < t < trou_fin:
            continue
        horloge["t"] = t
        lectures = {nom: (f(), t) for nom, (f, _p) in sources.items()}
        inst = construire_instantane(assembler(lectures, SITES), reglages, debits, t)
        tous.extend(evenements.comparer(precedent, inst))
        precedent = inst
        historique.enregistrer(inst)
    tous.append({"t": trou_debut, "id": "abysse", "nom": "Abysse", "nature": "panne", "importance": 4,
                 "texte": f"Abysse injoignable 12{evenements.ESPACE}min"})
    historique.ajouter(tous)
