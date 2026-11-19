"""Construction de l'instantané (contrat central, voir le plan « Contrat central »).

``construire_instantane`` ne fait aucune E/S : il transforme les dernières lectures
des sources (``brut``) en un dict JSON prêt à être envoyé au navigateur.

Forme attendue de ``brut`` (clé absente = source désactivée, ``None`` = source en erreur) :

- ``mikrotik`` : ``{"interfaces"}`` (lecture rapide) fusionné avec
  ``{"ressource", "arp", "baux", "hotes_pont", "dhcp_client"}`` (lecture lente, éventuellement
  absents tant qu'ils n'ont pas été lus) et ``"t"`` = heure de lecture des interfaces ;
- ``proxmox`` : ``{"ressources", "noeud", "configs": {vmid: {"onboot", "ip"}}, "t"}`` ;
- ``nut`` : ``{"battery.charge": "100", ...}`` ;
- ``influx`` : ``{"kuma": {nom: 0|1}, "synology": {...}, "pbs_pool": {...}}`` ; les sondes
  ``backup-*`` ressortent dans ``pbs.details.sauvegardes = {nom: 0|1}`` (clé absente si
  InfluxDB est en erreur) : c'est là que ``evenements.comparer`` lit les sauvegardes ratées ;
- ``truenas`` : ``{"pools": {nom: {"taille", "alloue", "etat"}}}`` ;
- ``sites`` : liste ``{"nom", "url", "amont_ip", "amont_port"}`` (``sites.py``), avec
  éventuellement ``"parent"`` déjà résolu.

``"t"`` (heure de lecture de la source) sert au calcul du débit : tant qu'il ne change pas,
le débit déjà calculé est réutilisé. Absent, on prend le ``t`` de l'instantané.

Une petite mémoire est attachée à chaque ``CompteurDebit`` (le collecteur en garde un seul
pour toute sa vie) : derniers invités Proxmox connus (pour les afficher ``inconnu`` quand
l'API ne répond plus), dernières configurations, appareils déjà vus, débits déjà calculés.
"""

from __future__ import annotations

import copy
import datetime
import math
import re
import weakref

from . import inventaire as inv
from .debit import CompteurDebit

VERSION = 1
SOURCES = ("mikrotik", "proxmox", "nut", "influx", "truenas")

# En dessous, l'onduleur est considéré sur batterie (on ne se fie pas au drapeau OL/OB).
SECTEUR_MIN_V = 180.0
# Un appareil absent de l'ARP et sans bail DHCP est oublié au bout d'un jour.
OUBLI_APPAREIL_S = 86400.0
# Proxmox ne rafraîchit netin/netout qu'environ toutes les 10 s : un compteur figé depuis
# moins longtemps que ça garde le dernier débit au lieu de tomber à 0 puis de faire un pic.
GEL_COMPTEUR_PVE_S = 20.0
ETATS = ("on", "off", "eteint", "inconnu")

_PREFIXE_INVITE = {"lxc": "ct", "qemu": "vm"}


# --------------------------------------------------------------------------- conversions

def _nombre(x: object) -> float | None:
    """Nombre fini depuis un int, un float ou une chaîne (l'API REST de RouterOS envoie tout en chaînes)."""
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)):
        n = float(x)
    elif isinstance(x, str):
        try:
            n = float(x.strip())
        except ValueError:
            return None
    else:
        return None
    return n if math.isfinite(n) else None


def _entier(x: object) -> int | None:
    n = _nombre(x)
    return None if n is None else int(n)


def _propre(n: float | None) -> int | float | None:
    """100.0 -> 100 (lisible dans le JSON), 231.4 reste 231.4."""
    if n is None:
        return None
    return int(n) if n.is_integer() else n


def _fraction(x: object) -> float | None:
    n = _nombre(x)
    if n is None:
        return None
    return min(1.0, max(0.0, n))


def _vrai(x: object) -> bool:
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return x == 1
    if isinstance(x, str):
        return x.strip().lower() in ("true", "yes", "1", "oui", "vrai")
    return False


_RE_DUREE = re.compile(r"(\d+)(ms|w|d|h|m|s)")
_RE_DATE = re.compile(r"(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)")
_RE_HMS = re.compile(r"(?:(\d+)d\s*)?(\d+):(\d\d):(\d\d)")
_UNITES = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1, "ms": 0.001}


def _uptime_s(x: object) -> int | None:
    """Uptime en secondes : nombre, ``1w2d3h4m5s`` (REST), ``1970-01-02 06:35:11`` (:serialize), ``1d06:35:11``."""
    n = _nombre(x)
    if n is not None:
        return int(n) if n >= 0 else None
    if not isinstance(x, str):
        return None
    s = x.strip()
    m = _RE_DATE.fullmatch(s)
    if m:
        try:
            d = datetime.datetime(*map(int, m.groups()), tzinfo=datetime.timezone.utc)
        except ValueError:
            return None
        return int(d.timestamp()) if d.timestamp() >= 0 else None
    m = _RE_HMS.fullmatch(s)
    if m:
        j, h, mi, se = (int(g) if g else 0 for g in m.groups())
        return j * 86400 + h * 3600 + mi * 60 + se
    if s and _RE_DUREE.sub("", s) == "":
        return int(sum(int(v) * _UNITES[u] for v, u in _RE_DUREE.findall(s)))
    return None


def _chaine(x: object) -> str | None:
    return x if isinstance(x, str) else None


def _dict(x: object) -> dict | None:
    return x if isinstance(x, dict) else None


def _liste(x: object) -> list:
    return [e for e in x if isinstance(e, dict)] if isinstance(x, list) else []


# --------------------------------------------------------------------------- mémoire

class _Memoire:
    def __init__(self) -> None:
        self.lectures: dict[str, tuple[float, float | None]] = {}  # clé -> (t_lecture, débit)
        self.gel: dict[str, dict] = {}  # clé -> {n, t_chg, v_chg, t_vu, v_vu}
        self.invites: dict[int, dict] = {}  # vmid -> dernière ressource Proxmox
        self.configs: dict[int, dict] = {}  # vmid -> {"onboot", "ip"}
        self.appareils: dict[str, dict] = {}  # MAC -> {"ip", "vu", "nom_dhcp"}


_MEMOIRES: "weakref.WeakKeyDictionary[CompteurDebit, _Memoire]" = weakref.WeakKeyDictionary()


def _memoire(debits: CompteurDebit) -> _Memoire:
    mem = _MEMOIRES.get(debits)
    if mem is None:
        mem = _MEMOIRES[debits] = _Memoire()
    return mem


def _debit(mem: _Memoire, debits: CompteurDebit, cle: str, octets: object, t_lect: float) -> float | None:
    """Débit d'un compteur temps réel ; même lecture de source = même débit."""
    deja = mem.lectures.get(cle)
    if deja is not None and deja[0] == t_lect:
        return deja[1]
    v = debits.maj(cle, octets, t_lect)
    mem.lectures[cle] = (t_lect, v)
    return v


def _debit_lent(mem: _Memoire, debits: CompteurDebit, cle: str, octets: object, t_lect: float) -> float | None:
    """Débit d'un compteur rafraîchi par paliers (Proxmox netin/netout, environ toutes les 10 s).

    La première lecture tombe en général au milieu d'une fenêtre de rafraîchissement : la
    prendre pour base diviserait le premier palier par un intervalle trop court (pic jusqu'à
    5 fois le débit réel). On attend donc le premier changement du compteur, qui sert de base
    alignée sur un rafraîchissement ; le débit n'est calculé qu'à partir du changement suivant.
    """
    n = _entier(octets)
    if n is None:
        return None
    g = mem.gel.get(cle)
    if g is None or t_lect < g["t_chg"]:
        # première lecture (ou horloge qui recule) : base pas alignée, aucun débit
        debits.oublier(cle)
        mem.gel[cle] = {"n": n, "t_chg": t_lect, "v_chg": None, "t_vu": t_lect, "v_vu": None, "aligne": False}
        return None
    if g["t_vu"] == t_lect:
        return g["v_vu"]
    if n == g["n"]:
        # compteur figé : on garde le dernier débit le temps d'un rafraîchissement, puis 0
        v = g["v_chg"] if t_lect - g["t_chg"] < GEL_COMPTEUR_PVE_S else 0.0
        g["t_vu"], g["v_vu"] = t_lect, v
        return v
    if g["aligne"]:
        v = debits.maj(cle, n, t_lect)
    else:
        debits.oublier(cle)
        debits.maj(cle, n, t_lect)  # premier changement : base alignée
        v = None
    mem.gel[cle] = {"n": n, "t_chg": t_lect, "v_chg": v, "t_vu": t_lect, "v_vu": v, "aligne": True}
    return v


def _oublier(mem: _Memoire, debits: CompteurDebit, cles: list[str]) -> None:
    for cle in cles:
        debits.oublier(cle)
        mem.lectures.pop(cle, None)
        mem.gel.pop(cle, None)


# --------------------------------------------------------------------------- nœuds

def _noeud(id_: str, nom: str, type_: str, groupe: str, parent: str | None, niveau: int,
           etat: str, ip: str | None, url: str | None, jauges: dict | None = None,
           details: dict | None = None) -> dict:
    return {
        "id": id_, "nom": nom, "type": type_, "groupe": groupe, "parent": parent, "niveau": niveau,
        "etat": etat, "ip": ip, "url": url, "jauges": jauges or {}, "details": details or {},
    }


def _ram(u: object, t: object) -> dict | None:
    u, t = _entier(u), _entier(t)
    if u is None or t is None or t <= 0:
        return None
    return {"u": max(0, u), "t": t}


def _kuma(influx: dict | None, id_: str) -> str | None:
    """État d'après la sonde Uptime Kuma du nœud, ``None`` si inconnue."""
    if influx is None or id_ not in inv.KUMA:
        return None
    kuma = _dict(influx.get("kuma")) or {}
    v = _nombre(kuma.get(inv.KUMA[id_]))
    if v is None:
        return None
    return "on" if v >= 1 else "off"


class _Mikrotik:
    """Vue pratique sur la lecture MikroTik (tolère nombres et booléens en chaînes)."""

    def __init__(self, brut: dict | None, t: float) -> None:
        self.ok = brut is not None
        b = brut or {}
        self.t = _nombre(b.get("t"))
        if self.t is None:
            self.t = t
        self.interfaces = {i.get("name"): i for i in _liste(b.get("interfaces")) if isinstance(i.get("name"), str)}
        self.ressource = _dict(b.get("ressource")) or {}
        self.arp_lu = isinstance(b.get("arp"), list)
        self.present: dict[str, str] = {}  # IP -> MAC des voisins ARP joignables
        self.mac_de_ip: dict[str, str] = {}
        self.arp: list[tuple[str, str, str | None, bool]] = []  # (ip, mac, interface, présent)
        for a in _liste(b.get("arp")):
            ip = a.get("address")
            mac = inv.normaliser_mac(a.get("mac-address"))
            if not isinstance(ip, str) or mac is None:
                continue
            statut = str(a.get("status", "")).lower()
            present = statut not in ("failed", "incomplete") and ("complete" not in a or _vrai(a.get("complete")))
            self.arp.append((ip, mac, a.get("interface"), present))
            if present:
                self.present[ip] = mac
                self.mac_de_ip[ip] = mac
            else:
                self.mac_de_ip.setdefault(ip, mac)
        self.port_de_mac: dict[str, str] = {}
        for h in _liste(b.get("hotes_pont")):
            mac = inv.normaliser_mac(h.get("mac-address"))
            port = h.get("on-interface")
            if mac and isinstance(port, str) and not _vrai(h.get("local")):
                self.port_de_mac[mac] = port
        self.baux = _liste(b.get("baux"))
        self.dhcp_client = _liste(b.get("dhcp_client")) if isinstance(b.get("dhcp_client"), list) else None

    def port_running(self, nom: str) -> bool | None:
        i = self.interfaces.get(nom)
        if i is None:
            return None
        return _vrai(i.get("running")) and not _vrai(i.get("disabled"))


def _etat_wan(mk: _Mikrotik, etat_box: str) -> str:
    if not mk.ok:
        return "inconnu"
    if etat_box == "off":
        return "off"
    if mk.dhcp_client:
        clients = [c for c in mk.dhcp_client if c.get("interface") == inv.PORT_WAN] or mk.dhcp_client
        return "on" if any(str(c.get("status", "")).lower() == "bound" for c in clients) else "off"
    r = mk.port_running(inv.PORT_WAN)
    if r is None:
        return "inconnu"
    return "on" if r else "off"


def _equipements(mk: _Mikrotik, prox: dict | None, nut: dict | None, influx: dict | None,
                 eteints: set[str]) -> dict[str, dict]:
    noeuds: dict[str, dict] = {}
    for id_, e in inv.EQUIPEMENTS.items():
        noeuds[id_] = _noeud(id_, e["nom"], e["type"], e["groupe"], e["parent"], e["niveau"],
                             "inconnu", e["ip"], e["url"])

    # Chaque équipement de l'inventaire est facultatif : un équipement absent reçoit un nœud
    # factice, jamais ajouté à l'instantané.
    def fixe(id_: str) -> dict:
        return noeuds.get(id_) or _noeud(id_, "", "", "", None, 0, "inconnu", None, None)

    # MikroTik
    m = fixe("mikrotik")
    if mk.ok:
        m["etat"] = "on"
        r = mk.ressource
        cpu = _nombre(r.get("cpu-load"))
        if cpu is not None:
            m["jauges"]["cpu"] = min(1.0, max(0.0, cpu / 100))
        total, libre = _entier(r.get("total-memory")), _entier(r.get("free-memory"))
        if total is not None and libre is not None:
            ram = _ram(total - libre, total)
            if ram:
                m["jauges"]["ram"] = ram
        up = _uptime_s(r.get("uptime"))
        if up is not None:
            m["details"]["uptime"] = up
        if isinstance(r.get("version"), str):
            m["details"]["version"] = r["version"]

    # Box : lien du port WAN si le MikroTik répond, sinon la sonde Kuma.
    lb = fixe("box")
    r = mk.port_running(inv.PORT_WAN) if mk.ok else None
    if r is not None:
        lb["etat"] = "on" if r else "off"
    else:
        lb["etat"] = _kuma(influx, "box") or "inconnu"

    fixe("internet")["etat"] = _etat_wan(mk, lb["etat"])

    # Hyperviseur Proxmox
    p = fixe("pve")
    if prox is not None:
        p["etat"] = "on"
        n = _dict(prox.get("noeud")) or {}
        cpu = _fraction(n.get("cpu"))
        if cpu is not None:
            p["jauges"]["cpu"] = cpu
        mem = _dict(n.get("memory")) or {}
        ram = _ram(mem.get("used"), mem.get("total"))
        if ram:
            p["jauges"]["ram"] = ram
        up = _uptime_s(n.get("uptime"))
        if up is not None:
            p["details"]["uptime"] = up
        if isinstance(n.get("pveversion"), str):
            p["details"]["version"] = "/".join(n["pveversion"].split("/")[:2])

    # PBS, Synology : sonde Kuma, sinon présence ARP (une absence ARP ne prouve pas une panne).
    for id_ in ("pbs", "synology"):
        if id_ not in noeuds:
            continue
        etat = _kuma(influx, id_)
        if etat is None and mk.ok and inv.EQUIPEMENTS[id_]["ip"] in mk.present:
            etat = "on"
        noeuds[id_]["etat"] = etat or "inconnu"
    if influx is not None:
        pbs = fixe("pbs")
        pool = _dict(influx.get("pbs_pool")) or {}
        disque = _ram(pool.get("alloc"), pool.get("size"))
        if disque:
            pbs["jauges"]["disque"] = disque
        if isinstance(pool.get("health"), str):
            pbs["details"]["sante"] = pool["health"]
        # Sondes Kuma backup-* : seules traces des sauvegardes PBS ratées dans l'instantané
        # (voir evenements.comparer). Ne changent pas l'état du PBS.
        sauvegardes = {}
        for nom, v in (_dict(influx.get("kuma")) or {}).items():
            v = _nombre(v)
            if isinstance(nom, str) and nom.startswith(inv.PREFIXE_SAUVEGARDE) and v is not None:
                sauvegardes[nom] = 1 if v >= 1 else 0
        pbs["details"]["sauvegardes"] = dict(sorted(sauvegardes.items()))
        syno = _dict(influx.get("synology")) or {}
        total, libre = _entier(syno.get("raid_total_size")), _entier(syno.get("raid_free_size"))
        if total is not None and libre is not None:
            disque = _ram(total - libre, total)
            if disque:
                fixe("synology")["jauges"]["disque"] = disque

    # Équipements suivis seulement par une sonde Kuma (côté box, par exemple).
    for id_ in inv.SUPERVISION_SEULE:
        if id_ in noeuds:
            noeuds[id_]["etat"] = _kuma(influx, id_) or "inconnu"

    # PC : il arrive et part, jamais rouge.
    for pc in noeuds.values():
        if pc["type"] == "pc" and mk.ok and mk.arp_lu:
            pc["etat"] = "on" if pc["ip"] in mk.present else "eteint"

    # Onduleur
    o = fixe("onduleur")
    if nut is not None:
        o["etat"] = "on"
        j = o["jauges"]
        batterie = _nombre(nut.get("battery.charge"))
        if batterie is not None:
            j["batterie"] = _propre(min(100.0, max(0.0, batterie)))
        autonomie = _entier(nut.get("battery.runtime"))
        if autonomie is not None and autonomie >= 0:
            j["autonomie"] = autonomie
        tension = _nombre(nut.get("input.voltage"))
        statut = nut.get("ups.status")
        if tension is not None:
            j["tension"] = _propre(tension)
            j["secteur"] = tension > SECTEUR_MIN_V
        elif isinstance(statut, str) and statut.strip():
            j["secteur"] = "OB" not in statut.split()  # repli seulement si la tension manque
        if isinstance(statut, str):
            o["details"]["statut"] = statut

    for id_, n in noeuds.items():
        if n["etat"] == "off" and id_ in eteints:
            n["etat"] = "eteint"
    return noeuds


def _invites(prox: dict | None, mem: _Memoire, debits: CompteurDebit, eteints: set[str],
             truenas: dict | None, t: float) -> tuple[list[dict], list[tuple]]:
    """Nœuds CT/VM et leurs liens ``pve>…`` (débit netin/netout)."""
    if prox is not None:
        t_lect = _nombre(prox.get("t"))
        if t_lect is None:
            t_lect = t
        actuels: dict[int, dict] = {}
        for r in _liste(prox.get("ressources")):
            if r.get("type") not in _PREFIXE_INVITE or _vrai(r.get("template")):
                continue
            vmid = _entier(r.get("vmid"))
            if vmid is None:
                continue
            actuels[vmid] = copy.deepcopy(r)
        for vmid in set(mem.invites) - set(actuels):  # invité supprimé de Proxmox
            _oublier(mem, debits, [f"pve:{vmid}:in", f"pve:{vmid}:out"])
            mem.configs.pop(vmid, None)
        mem.invites = actuels
        configs = _dict(prox.get("configs"))
        if configs is not None:
            for cle, c in configs.items():
                vmid = _entier(cle)
                if vmid is not None and isinstance(c, dict):
                    mem.configs[vmid] = {"onboot": _entier(c.get("onboot")), "ip": c.get("ip")}
    else:
        t_lect = t

    pool = None
    if truenas is not None:
        pools = _dict(truenas.get("pools")) or {}
        pool = _dict(pools.get(inv.POOL_TRUENAS))
        if pool is None and len(pools) == 1:
            pool = _dict(next(iter(pools.values())))

    noeuds, liens = [], []
    for vmid in sorted(mem.invites):
        r = mem.invites[vmid]
        prefixe = _PREFIXE_INVITE[r.get("type")]
        id_ = f"{prefixe}-{vmid}"
        type_, groupe = inv.VM_SPECIALES.get(vmid, (prefixe, "pve")) if prefixe == "vm" else ("ct", "pve")
        conf = mem.configs.get(vmid, {})
        ip = conf.get("ip") if isinstance(conf.get("ip"), str) and conf.get("ip") else inv.IP_VM.get(vmid)
        nom = r.get("name") if isinstance(r.get("name"), str) and r.get("name") else f"{prefixe.upper()} {vmid}"
        jauges, details = {}, {"vmid": vmid}
        desc = mont = None
        if prox is None:
            etat = "inconnu"
        else:
            if str(r.get("status", "")).lower() == "running":
                etat = "on"
            elif id_ in eteints or conf.get("onboot") == 0:
                etat = "eteint"
            elif conf.get("onboot") == 1:
                etat = "off"
            else:
                etat = "eteint"  # onboot pas encore lu : pas de rouge sans certitude
            cpu = _fraction(r.get("cpu"))
            if cpu is not None:
                jauges["cpu"] = cpu
            ram = _ram(r.get("mem"), r.get("maxmem"))
            if ram:
                jauges["ram"] = ram
            up = _uptime_s(r.get("uptime"))
            if up is not None:
                details["uptime"] = up
            desc = _debit_lent(mem, debits, f"pve:{vmid}:in", r.get("netin"), t_lect)
            mont = _debit_lent(mem, debits, f"pve:{vmid}:out", r.get("netout"), t_lect)
        if groupe == "truenas" and pool is not None:
            disque = _ram(pool.get("alloue"), pool.get("taille"))
            if disque:
                jauges["disque"] = disque
            if isinstance(pool.get("etat"), str):
                details["pool"] = pool["etat"]
        noeuds.append(_noeud(id_, nom, type_, groupe, "pve", 2, etat, ip, inv.URL_INVITES.get(vmid), jauges, details))
        liens.append(("pve", id_, "virtuel", desc, mont))
    return noeuds, liens


def _appareils(mk: _Mikrotik, mem: _Memoire, exclues_ip: set[str], exclues_mac: set[str],
               ports_pve: set[str], t: float) -> list[dict]:
    def exclu(ip: object, mac: str) -> bool:
        return (
            mac.startswith(inv.OUI_PROXMOX)
            or mac in exclues_mac
            or ip in exclues_ip
            or mk.port_de_mac.get(mac) in ports_pve
        )

    presents: set[str] = set()
    if mk.ok and mk.arp_lu:
        for ip, mac, interface, present in mk.arp:
            if interface == inv.PORT_WAN or not present or exclu(ip, mac):
                continue
            presents.add(mac)
            a = mem.appareils.setdefault(mac, {"ip": ip, "vu": t, "nom_dhcp": None})
            a["ip"], a["vu"] = ip, t
        baux: set[str] = set()
        for b in mk.baux:
            mac = inv.normaliser_mac(b.get("mac-address"))
            ip = b.get("address")
            if mac is None or exclu(ip, mac):
                continue
            baux.add(mac)
            a = mem.appareils.setdefault(mac, {"ip": ip if isinstance(ip, str) else None, "vu": None, "nom_dhcp": None})
            if isinstance(b.get("host-name"), str) and b["host-name"].strip():
                a["nom_dhcp"] = b["host-name"].strip()
            if a["ip"] is None and isinstance(ip, str):
                a["ip"] = ip
        for mac in list(mem.appareils):
            a = mem.appareils[mac]
            if mac in presents or mac in baux:
                continue
            if exclu(a["ip"], mac) or a["vu"] is None or t - a["vu"] > OUBLI_APPAREIL_S:
                del mem.appareils[mac]

    noeuds = []
    for mac in sorted(mem.appareils):
        a = mem.appareils[mac]
        fab = inv.fabricant(mac)
        nom = a["nom_dhcp"] or f"Appareil {fab or mac}"
        if not (mk.ok and mk.arp_lu):
            etat = "inconnu"
        else:
            etat = "on" if mac in presents else "eteint"
        details = {"mac": mac}
        if fab:
            details["fabricant"] = fab
        if mk.port_de_mac.get(mac):
            details["port"] = mk.port_de_mac[mac]
        noeuds.append(_noeud("app-" + mac.replace(":", "").lower(), nom, "appareil", "appareils",
                             "mikrotik", 1, etat, a["ip"], None, {}, details))
    return noeuds


def _debit_ports(mk: _Mikrotik, mem: _Memoire, debits: CompteurDebit, ports: list[str]) -> tuple:
    """(descendant, montant) en bits/s sur des ports du MikroTik : tx = vers l'équipement."""
    if not mk.ok or not ports:
        return None, None
    total = []
    for sens, champ in (("tx", "tx-byte"), ("rx", "rx-byte")):
        # chaque port est échantillonné, même si un autre n'a pas encore de débit
        valeurs = []
        for p in ports:
            i = mk.interfaces.get(p)
            valeurs.append(None if i is None else _debit(mem, debits, f"if:{p}:{sens}", i.get(champ), mk.t))
        total.append(None if any(v is None for v in valeurs) else float(sum(valeurs)))
    return total[0], total[1]


# --------------------------------------------------------------------------- instantané

def construire_instantane(brut: dict, reglages: "Reglages", debits: CompteurDebit, t: float) -> dict:
    """Instantané complet (contrat central) à partir des dernières lectures des sources."""
    brut = brut or {}
    mem = _memoire(debits)
    sources = {}
    for s in SOURCES:
        if s not in brut:
            sources[s] = "desactivee"
        else:
            sources[s] = "ok" if isinstance(brut[s], dict) else "erreur"

    def source(nom: str) -> dict | None:
        return brut[nom] if sources[nom] == "ok" else None

    mk = _Mikrotik(source("mikrotik"), t)
    prox, nut, influx, truenas = source("proxmox"), source("nut"), source("influx"), source("truenas")

    noms = getattr(reglages, "noms", None) or {}
    caches = set(getattr(reglages, "caches", None) or ())
    eteints = set(getattr(reglages, "eteints_expres", None) or ())
    liens_manuels = getattr(reglages, "liens", None) or []

    noeuds: dict[str, dict] = {}
    liens: list[tuple] = []  # (de, vers, type, descendant, montant)

    # Équipements fixes
    noeuds.update(_equipements(mk, prox, nut, influx, eteints))
    for id_, e in inv.EQUIPEMENTS.items():
        if e["parent"] is not None:
            type_lien = {"internet": "wan", "onduleur": "usb"}.get(id_, "ethernet")
            liens.append([e["parent"], id_, type_lien, None, None])

    # Invités Proxmox
    n_invites, l_invites = _invites(prox, mem, debits, eteints, truenas, t)
    for n in n_invites:
        noeuds[n["id"]] = n
    liens.extend(list(l) for l in l_invites)

    # IP connues (invités puis équipements) pour les sites et le filtrage des appareils
    # Les invités en marche passent d'abord : un CT arrêté peut garder l'adresse de celui qui l'a
    # remplacé (un ancien CT Caddy arrêté qui garde encore l'adresse du nouveau, par exemple).
    ip_vers_id: dict[str, str] = {}
    for n in sorted(noeuds.values(), key=lambda n: n.get("etat") != "on"):
        if isinstance(n["ip"], str) and n["ip"]:
            ip_vers_id.setdefault(n["ip"], n["id"])
    for vmid, ip in inv.IP_VM.items():
        for pref in ("vm", "ct"):
            if f"{pref}-{vmid}" in noeuds:
                ip_vers_id.setdefault(ip, f"{pref}-{vmid}")

    # Appareils (côté LAN du MikroTik)
    ips_equipements = {e["ip"] for e in inv.EQUIPEMENTS.values() if e["ip"]}
    macs_equipements = {mk.mac_de_ip[ip] for ip in ips_equipements if ip in mk.mac_de_ip}
    ports_pve = set(inv.PORTS_FIXES.get("pve", ()))
    for n in _appareils(mk, mem, set(ip_vers_id) | ips_equipements, macs_equipements, ports_pve, t):
        noeuds[n["id"]] = n

    # Débit des ports du MikroTik : ports fixes, sinon ARP (IP -> MAC) puis table du pont.
    ports: dict[str, list[str]] = {}
    proprietaire: dict[str, str] = {}  # port -> premier nœud qui l'utilise (équipement d'abord)
    for id_, ps in inv.PORTS_FIXES.items():
        ports[id_] = list(ps)
        for p in ps:
            proprietaire.setdefault(p, id_)
    for id_, n in noeuds.items():
        if id_ in ports or n["parent"] != "mikrotik":
            continue
        mac = mk.mac_de_ip.get(n["ip"]) if n["ip"] else None
        if id_.startswith("app-"):
            mac = n["details"].get("mac")
        p = mk.port_de_mac.get(mac) if mac else None
        if p and p in mk.interfaces and p != "bridge":
            if proprietaire.setdefault(p, id_) == id_:
                ports[id_] = [p]
    for id_ in noeuds:
        if noeuds[id_]["parent"] == "mikrotik" and not any(l[1] == id_ for l in liens):
            liens.append(["mikrotik", id_, "ethernet", None, None])
    for l in liens:
        if l[0] == "mikrotik" and l[1] in ports:
            l[3], l[4] = _debit_ports(mk, mem, debits, ports[l[1]])
        elif l[1] == "internet":
            l[3], l[4] = _debit_ports(mk, mem, debits, ports.get("box", [inv.PORT_WAN]))

    # Sites (Caddyfile) puis liens manuels du mode « modifier »
    def ajouter_site(id_: str, nom: str, url: str | None, parent: str, details: dict | None = None) -> None:
        p = noeuds[parent]
        noeuds[id_] = _noeud(id_, nom, "site", p["groupe"], parent, 3, "inconnu", None, url, {}, details)
        liens.append([parent, id_, "site", None, None])

    for s in brut.get("sites") or []:
        if not isinstance(s, dict) or not isinstance(s.get("nom"), str) or not s["nom"].strip():
            continue
        nom = s["nom"].strip()
        id_ = "site-" + nom
        if id_ in noeuds:
            continue
        parent = s.get("parent") if _chaine(s.get("parent")) in noeuds else ip_vers_id.get(_chaine(s.get("amont_ip")))
        if parent is None:   # amont inconnu : rattaché au CT du Caddy public qui le sert
            parent = ip_vers_id.get(inv.IP_CADDY_PUBLIC)
        if parent is None:
            continue
        url = s.get("url") if isinstance(s.get("url"), str) and s.get("url") else "https://" + nom
        details = {}
        if isinstance(s.get("amont_ip"), str):
            details["amont"] = s["amont_ip"] + (f":{s['amont_port']}" if s.get("amont_port") else "")
        ajouter_site(id_, nom, url, parent, details)

    for lm in liens_manuels:
        if not isinstance(lm, dict) or not isinstance(lm.get("id"), str):
            continue
        id_ = lm["id"]
        parent = _chaine(lm.get("parent"))
        existant = noeuds.get(id_)
        if existant is not None:
            if existant["type"] != "site":
                continue
            if isinstance(lm.get("nom"), str) and lm["nom"]:
                existant["nom"] = lm["nom"]
            if isinstance(lm.get("url"), str) and lm["url"]:
                existant["url"] = lm["url"]
            if parent in noeuds and parent != existant["parent"] and parent != id_:
                liens = [l for l in liens if l[1] != id_]
                existant["parent"], existant["groupe"] = parent, noeuds[parent]["groupe"]
                liens.append([parent, id_, "site", None, None])
            continue
        if parent not in noeuds:
            continue
        nom = lm.get("nom") if isinstance(lm.get("nom"), str) and lm.get("nom") else id_
        ajouter_site(id_, nom, lm.get("url") if isinstance(lm.get("url"), str) else None, parent)

    # Un site (ou lien manuel) prend l'état de son parent.
    for n in noeuds.values():
        if n["type"] == "site":
            n["etat"] = noeuds[n["parent"]]["etat"]

    # Nœuds cachés (et tout ce qui en descend), noms personnalisés
    caches_tous: set[str] = set()

    def cache(id_: str, vus: tuple = ()) -> bool:
        if id_ in caches_tous:
            return True
        n = noeuds.get(id_)
        if n is None or id_ in vus:
            return True
        if id_ in caches or (n["parent"] is not None and cache(n["parent"], vus + (id_,))):
            caches_tous.add(id_)
            return True
        return False

    emis = []
    for id_, n in noeuds.items():
        if cache(id_):
            continue
        nom = noms.get(id_)
        if isinstance(nom, str) and nom.strip():
            n["nom"] = nom
        emis.append(n)
    ids_emis = {n["id"] for n in emis}

    liens_emis, vus = [], set()
    for de, vers, type_, desc, mont in liens:
        if de not in ids_emis or vers not in ids_emis or (de, vers) in vus:
            continue
        vus.add((de, vers))
        etat = noeuds[vers]["etat"]
        if etat == "inconnu":
            desc = mont = None
        liens_emis.append({
            "id": f"{de}>{vers}", "de": de, "vers": vers, "type": type_, "etat": etat,
            "descendant": desc, "montant": mont,
        })

    return {"t": t, "version": VERSION, "sources": sources, "noeuds": emis, "liens": liens_emis}
