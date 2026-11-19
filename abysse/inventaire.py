"""Inventaire fixe du homelab : équipements, ports du MikroTik, IP de repli, sondes Kuma.

Tout ce qui ne se découvre pas par les API (ou pas de façon fiable) est décrit ici.
Les invités Proxmox (CT/VM), les sites et les appareils sont découverts par le modèle.

Les valeurs ci-dessous sont un exemple. Pour décrire sa propre installation, on écrit un
fichier JSON (voir ``deploy/inventaire.exemple.json``) et on donne son chemin dans
``ABYSSE_INVENTAIRE`` : chaque clé présente remplace la valeur par défaut correspondante.

Identifiants reconnus par le modèle : ``mikrotik`` (centre de la carte, obligatoire),
``box``, ``internet``, ``pve``, ``pbs``, ``synology``, ``onduleur``. Tous sont facultatifs
sauf le MikroTik. Les autres équipements (domotique, switchs, caméras, PC) sont libres.
"""

from __future__ import annotations

import json

# Équipements fixes, dans l'ordre d'affichage. ``niveau`` suit le contrat de l'instantané.
EQUIPEMENTS: dict[str, dict] = {
    "mikrotik": {
        "nom": "Routeur MikroTik", "type": "routeur", "groupe": "mikrotik", "parent": None,
        "niveau": 0, "ip": "192.168.10.198", "url": "http://192.168.10.198",
    },
    "box": {
        "nom": "Box internet", "type": "box", "groupe": "internet", "parent": "mikrotik",
        "niveau": 1, "ip": "192.168.0.1", "url": "http://192.168.0.1",
    },
    "internet": {
        "nom": "Internet", "type": "internet", "groupe": "internet", "parent": "box",
        "niveau": 2, "ip": None, "url": None,
    },
    "pve": {
        "nom": "pve", "type": "hyperviseur", "groupe": "pve", "parent": "mikrotik",
        "niveau": 1, "ip": "192.168.10.97", "url": "https://pve.lan",
    },
    "pbs": {
        "nom": "PBS", "type": "sauvegarde", "groupe": "pbs", "parent": "mikrotik",
        "niveau": 1, "ip": "192.168.10.156", "url": "https://pbs.lan",
    },
    "synology": {
        "nom": "NAS Synology", "type": "nas", "groupe": "synology", "parent": "mikrotik",
        "niveau": 1, "ip": "192.168.10.253", "url": "https://nas.lan:5001",
    },
    "pc": {
        "nom": "PC fixe", "type": "pc", "groupe": "appareils", "parent": "mikrotik",
        "niveau": 1, "ip": "192.168.10.187", "url": None,
    },
    "onduleur": {
        "nom": "Onduleur", "type": "onduleur", "groupe": "onduleur", "parent": "pve",
        "niveau": 2, "ip": None, "url": "https://ups.lan",
    },
    "ha": {
        "nom": "Home Assistant", "type": "domotique", "groupe": "ha", "parent": "box",
        "niveau": 2, "ip": "192.168.0.224", "url": "https://ha.lan",
    },
    "switch-1": {
        "nom": "Switch 1", "type": "switch", "groupe": "reseau", "parent": "box",
        "niveau": 2, "ip": "192.168.0.185", "url": None,
    },
    "switch-2": {
        "nom": "Switch 2", "type": "switch", "groupe": "reseau", "parent": "box",
        "niveau": 2, "ip": "192.168.0.124", "url": None,
    },
    "camera": {
        "nom": "Caméra", "type": "appareil", "groupe": "reseau", "parent": "box",
        "niveau": 2, "ip": "192.168.0.54", "url": None,
    },
}

# Ports du MikroTik connus d'avance (pve : bond actif/secours sur deux ports).
PORTS_FIXES: dict[str, list[str]] = {"box": ["ether1"], "pve": ["ether6", "ether7"], "synology": ["ether5"]}

# Port WAN du MikroTik (vers la box) : les voisins ARP de ce côté ne sont pas des appareils.
PORT_WAN = "ether1"

# IP de repli quand la configuration Proxmox ne donne pas l'IP (VM sans ip= dans net0).
IP_VM: dict[int, str] = {210: "192.168.10.34", 200: "192.168.10.31"}

# Adresse du Caddy public. Son CT peut changer de numéro : on le retrouve par l'adresse,
# en préférant le CT en marche.
IP_CADDY_PUBLIC = "192.168.10.17"

# Nœud -> nom de la sonde Uptime Kuma (mesure InfluxDB ``monitor_status``).
KUMA: dict[str, str] = {
    "box": "net-box",
    "ha": "host-homeassistant",
    "switch-1": "net-switch-1",
    "switch-2": "net-switch-2",
    "camera": "net-camera",
    "synology": "host-synology",
    "pbs": "host-pbs",
}

# Équipements dont l'état vient seulement de leur sonde Kuma (le MikroTik ne les voit pas).
SUPERVISION_SEULE: list[str] = ["ha", "switch-1", "switch-2", "camera"]

# Équipements « éteints exprès » au premier lancement (gris au lieu de rouge s'ils ne répondent pas).
ETEINTS_EXPRES: list[str] = ["switch-1", "switch-2", "camera"]

# Préfixe des sondes Kuma « push » des sauvegardes PBS (1 = dernière sauvegarde réussie).
PREFIXE_SAUVEGARDE = "backup-"

# VM au rôle particulier : (type, groupe).
VM_SPECIALES: dict[int, tuple[str, str]] = {200: ("nas-vm", "truenas")}

# URL d'interface pour certains invités (la VM TrueNAS a sa propre interface web).
URL_INVITES: dict[int, str] = {200: "https://truenas.lan"}

# Pool TrueNAS affiché en jauge sur la VM TrueNAS.
POOL_TRUENAS = "NAS"

# Préfixe MAC des cartes virtuelles Proxmox : jamais un appareil physique.
OUI_PROXMOX = "BC:24:11"

# Petite base OUI (préfixe MAC -> fabricant) pour nommer les appareils inconnus.
_OUI_PAR_FABRICANT: dict[str, tuple[str, ...]] = {
    "Raspberry Pi": ("B8:27:EB", "DC:A6:32", "D8:3A:DD", "E4:5F:01", "2C:CF:67", "28:CD:C1"),
    "Synology": ("00:11:32", "90:09:D0"),
    "Proxmox (virtuel)": (OUI_PROXMOX,),
    "Netgear": ("9C:C9:EB", "A0:40:A0", "20:E5:2A", "C0:3F:0E", "E0:91:F5", "28:C6:8E", "44:94:FC"),
    "MikroTik": ("4C:5E:0C", "64:D1:54", "6C:3B:6B", "B8:69:F4", "CC:2D:E0", "D4:CA:6D",
                 "E4:8D:8C", "48:8F:5A", "2C:C8:1B", "DC:2C:6E", "74:4D:28", "18:FD:74"),
    "Ubiquiti": ("24:A4:3C", "44:D9:E7", "68:72:51", "74:83:C2", "78:8A:20", "80:2A:A8",
                 "B4:FB:E4", "DC:9F:DB", "F0:9F:C2", "FC:EC:DA", "E0:63:DA", "18:E8:29",
                 "24:5A:4C", "70:A7:41"),
    "TP-Link": ("50:C7:BF", "14:CC:20", "98:DA:C4", "C0:25:E9", "EC:08:6B", "F4:F2:6D",
                "60:32:B1", "A4:2B:B0", "3C:84:6A", "B0:BE:76", "54:AF:97", "1C:61:B4"),
    "Espressif": ("24:0A:C4", "30:AE:A4", "84:CC:A8", "A4:CF:12", "BC:DD:C2", "CC:50:E3",
                  "EC:FA:BC", "24:6F:28", "3C:61:05", "7C:9E:BD", "8C:AA:B5", "C8:2B:96",
                  "24:62:AB", "10:52:1C", "08:3A:F2", "34:94:54", "48:3F:DA", "58:BF:25",
                  "94:B9:7E", "E8:DB:84"),
    "Apple": ("A4:5E:60", "3C:22:FB", "F0:18:98", "00:1B:63", "28:CF:E9", "AC:BC:32",
              "8C:85:90", "F4:0F:24", "D0:81:7A", "78:7B:8A"),
    "ASUSTek": ("3C:7C:3F", "04:92:26", "08:60:6E", "2C:56:DC", "1C:87:2C", "50:46:5D",
                "AC:22:0B", "F0:79:59", "00:1A:92", "10:BF:48", "30:5A:3A", "40:16:7E",
                "60:45:CB", "74:D0:2B", "9C:5C:8E", "D8:50:E6", "E0:3F:49"),
    "Dell": ("D8:9E:F3", "54:BF:64", "F8:BC:12", "18:66:DA", "14:18:77", "B0:83:FE",
             "98:90:96", "F0:1F:AF", "34:17:EB", "00:14:22"),
    "Realtek": ("00:E0:4C",),
    "Hikvision": ("44:19:B6", "C0:56:E3", "BC:AD:28", "28:57:BE", "4C:BD:8F", "54:C4:15",
                  "A4:14:37", "C4:2F:90", "E0:50:8B"),
    "Amazon": ("F0:27:2D", "74:C2:46", "FC:65:DE", "44:65:0D", "68:54:FD"),
    "Google": ("F4:F5:D8", "54:60:09", "3C:5A:B4", "F4:F5:E8", "48:D6:D5", "1C:F2:9A"),
    "Philips Hue": ("00:17:88", "EC:B5:FA"),
    "Sonos": ("00:0E:58", "5C:AA:FD", "94:9F:3E", "B8:E9:37", "48:A6:B8", "34:7E:5C"),
}

OUI: dict[str, str] = {p: f for f, prefixes in _OUI_PAR_FABRICANT.items() for p in prefixes}

# Clés acceptées dans le fichier d'inventaire, avec leur type attendu.
_CLES_FICHIER = {
    "equipements": dict, "ports_fixes": dict, "port_wan": str, "ip_vm": dict,
    "ip_caddy_public": str, "kuma": dict, "supervision_seule": list, "eteints_expres": list,
    "prefixe_sauvegarde": str, "vm_speciales": dict, "url_invites": dict, "pool_truenas": str,
}
_CHAMPS_EQUIPEMENT = ("nom", "type", "groupe", "parent", "niveau", "ip", "url")


def charger(chemin: str) -> None:
    """Remplace l'inventaire par défaut par celui du fichier JSON ``chemin``.

    Les dictionnaires et listes sont modifiés sur place (les autres modules gardent la même
    référence). Lève ``ValueError`` avec un message en français si le fichier est invalide.
    """
    global PORT_WAN, IP_CADDY_PUBLIC, PREFIXE_SAUVEGARDE, POOL_TRUENAS
    with open(chemin, encoding="utf-8") as f:
        donnees = json.load(f)
    if not isinstance(donnees, dict):
        raise ValueError("inventaire : un objet JSON est attendu")
    for cle, valeur in donnees.items():
        if cle.startswith("_"):
            continue  # commentaire
        if cle not in _CLES_FICHIER:
            raise ValueError(f"inventaire : clé inconnue {cle!r}")
        if not isinstance(valeur, _CLES_FICHIER[cle]):
            raise ValueError(f"inventaire : type invalide pour {cle!r}")
    if "equipements" in donnees:
        equipements = {}
        for id_, e in donnees["equipements"].items():
            if not isinstance(e, dict) or any(c not in e for c in _CHAMPS_EQUIPEMENT):
                raise ValueError(f"inventaire : équipement {id_!r} incomplet ({', '.join(_CHAMPS_EQUIPEMENT)})")
            equipements[id_] = {c: e[c] for c in _CHAMPS_EQUIPEMENT}
        if "mikrotik" not in equipements:
            raise ValueError("inventaire : l'équipement 'mikrotik' est obligatoire")
        EQUIPEMENTS.clear()
        EQUIPEMENTS.update(equipements)
    for cle, cible in (("ports_fixes", PORTS_FIXES), ("kuma", KUMA)):
        if cle in donnees:
            cible.clear()
            cible.update(donnees[cle])
    for cle, cible in (("ip_vm", IP_VM), ("url_invites", URL_INVITES)):
        if cle in donnees:
            cible.clear()
            cible.update({int(k): v for k, v in donnees[cle].items()})
    if "vm_speciales" in donnees:
        VM_SPECIALES.clear()
        VM_SPECIALES.update({int(k): (v[0], v[1]) for k, v in donnees["vm_speciales"].items()})
    for cle, cible in (("supervision_seule", SUPERVISION_SEULE), ("eteints_expres", ETEINTS_EXPRES)):
        if cle in donnees:
            cible[:] = [str(x) for x in donnees[cle]]
    PORT_WAN = donnees.get("port_wan", PORT_WAN)
    IP_CADDY_PUBLIC = donnees.get("ip_caddy_public", IP_CADDY_PUBLIC)
    PREFIXE_SAUVEGARDE = donnees.get("prefixe_sauvegarde", PREFIXE_SAUVEGARDE)
    POOL_TRUENAS = donnees.get("pool_truenas", POOL_TRUENAS)


def normaliser_mac(mac: object) -> str | None:
    """``b8-27-eb-12-34-56`` -> ``B8:27:EB:12:34:56`` ; ``None`` si illisible."""
    if not isinstance(mac, str):
        return None
    hexa = "".join(c for c in mac if c not in ":-. ").upper()
    if len(hexa) != 12 or any(c not in "0123456789ABCDEF" for c in hexa):
        return None
    return ":".join(hexa[i:i + 2] for i in range(0, 12, 2))


def fabricant(mac: object) -> str | None:
    """Fabricant d'après le préfixe OUI, ``None`` s'il est inconnu."""
    m = normaliser_mac(mac)
    if m is None:
        return None
    return OUI.get(m[:8])
