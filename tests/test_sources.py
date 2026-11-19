"""Tests des sources contre de faux serveurs locaux (port 0, 127.0.0.1).

Les réponses viennent des fixtures capturées sur le vrai homelab (``tests/fixtures``).
Aucun accès réseau réel : tout passe par la boucle locale.
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from abysse.config import charger_config
from abysse.debit import CompteurDebit
from abysse.sources import ErreurSource
from abysse.sources import http as shttp
from abysse.sources import influx, mikrotik, nut, proxmox, truenas

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
_PBKDF2 = hashlib.pbkdf2_hmac  # pris avant tout mock : le faux serveur garde le vrai


def _b64(octets):
    return base64.b64encode(octets).decode("ascii")


JETON_PVE = "abysse@pve!lecture=6f1c2d3e-aaaa-bbbb-cccc-0123456789ab"
PASS_MK = "motdepasse-tres-secret-42"
JETON_INFLUX = "influx-jeton-secret-XYZ=="
CLE_TRUENAS = "1-CleTrueNASsecreteAbcdef0123"


def _json(nom):
    with open(os.path.join(FIXTURES, nom), encoding="utf-8") as f:
        return json.load(f)


def _octets(nom):
    with open(os.path.join(FIXTURES, nom), "rb") as f:
        return f.read()


def _en_chaines(x):
    """Reproduit l'API REST de RouterOS : nombres et booléens en chaînes."""
    if isinstance(x, list):
        return [_en_chaines(v) for v in x]
    if isinstance(x, dict):
        return {k: _en_chaines(v) for k, v in x.items()}
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        return str(x)
    return x


# --------------------------------------------------------------------------- faux serveurs

class FauxHTTP:
    """Petit serveur HTTP local : ``routes[(méthode, chemin_sans_requête)] = (statut, corps, type, entêtes)``."""

    def __init__(self, routes):
        self.routes = routes
        self.requetes = []
        parent = self

        class Gestionnaire(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _servir(self):
                longueur = int(self.headers.get("Content-Length") or 0)
                corps = self.rfile.read(longueur) if longueur else b""
                chemin = self.path.split("?", 1)[0]
                parent.requetes.append(
                    {"methode": self.command, "chemin": self.path, "entetes": dict(self.headers.items()), "corps": corps}
                )
                route = parent.routes.get((self.command, chemin))
                if route is None:
                    statut, donnees, type_, entetes = 404, b'{"message":"introuvable"}', "application/json", {}
                else:
                    statut, donnees, type_ = route[:3]
                    entetes = route[3] if len(route) > 3 else {}
                if isinstance(donnees, (dict, list)):
                    donnees = json.dumps(donnees).encode()
                elif isinstance(donnees, str):
                    donnees = donnees.encode()
                self.send_response(statut)
                self.send_header("Content-Type", type_)
                self.send_header("Content-Length", str(len(donnees)))
                for k, v in entetes.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(donnees)

            do_GET = _servir
            do_POST = _servir

        self.serveur = ThreadingHTTPServer(("127.0.0.1", 0), Gestionnaire)
        self.url = f"http://127.0.0.1:{self.serveur.server_address[1]}"
        self.fil = threading.Thread(target=self.serveur.serve_forever, daemon=True)
        self.fil.start()

    def fermer(self):
        self.serveur.shutdown()
        self.serveur.server_close()


class FauxMuet:
    """Accepte les connexions TCP puis ne répond jamais."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.clients = []
        self.fini = False
        threading.Thread(target=self._boucle, daemon=True).start()

    def _boucle(self):
        while not self.fini:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.clients.append(c)

    def fermer(self):
        self.fini = True
        for c in self.clients:
            c.close()
        self.sock.close()


class FauxNUT:
    """Faux upsd : répond à ``LIST VAR <ups>`` avec ``nut_upsc.txt`` reformaté."""

    def __init__(self, valeurs, ups="onduleur"):
        self.valeurs = valeurs
        self.ups = ups
        self.commandes = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._boucle, daemon=True).start()

    def _boucle(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, c):
        f = c.makefile("rwb")
        try:
            for ligne in f:
                cmd = ligne.decode().strip()
                self.commandes.append(cmd)
                if cmd == f"LIST VAR {self.ups}":
                    f.write(f"BEGIN LIST VAR {self.ups}\n".encode())
                    for k, v in self.valeurs.items():
                        v = v.replace("\\", "\\\\").replace('"', '\\"')
                        f.write(f'VAR {self.ups} {k} "{v}"\n'.encode())
                    f.write(f"END LIST VAR {self.ups}\n".encode())
                elif cmd.startswith("LIST VAR"):
                    f.write(b"ERR UNKNOWN-UPS\n")
                elif cmd == "LOGOUT":
                    f.write(b"OK Goodbye\n")
                    f.flush()
                    break
                f.flush()
        except OSError:
            pass
        finally:
            c.close()

    def fermer(self):
        self.sock.close()


_GUID_WS = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _lire_exact(c, n):
    donnees = b""
    while len(donnees) < n:
        morceau = c.recv(n - len(donnees))
        if not morceau:
            raise ConnectionError("fermé")
        donnees += morceau
    return donnees


def _trame_serveur(opcode, charge, fin=True):
    tete = bytes([(0x80 if fin else 0) | opcode])
    n = len(charge)
    if n < 126:
        tete += bytes([n])
    elif n < 65536:
        tete += bytes([126]) + struct.pack("!H", n)
    else:
        tete += bytes([127]) + struct.pack("!Q", n)
    return tete + charge


class FauxTrueNAS:
    """Faux TrueNAS 27 : JSON-RPC 2.0 en WebSocket sur ``/api/current`` (trames client masquées
    obligatoires), authentification SCRAM-SHA-512 vérifiée côté serveur comme le middleware
    (nom ``<utilisateur>:<id de clé>``, preuve, signature finale), puis ``pool.query`` réservé
    aux sessions authentifiées. ``tls=(certificat, clé privée)`` : écoute en TLS et exige la
    liaison de canal ``tls-server-end-point`` (certificat d'essai signé en SHA-256)."""

    def __init__(self, pools, cle=CLE_TRUENAS, utilisateur="abysse", tls=None,
                 signature_fausse=False, iterations=50_000, datasets=None, datasets_en_erreur=False,
                 datasets_muet=False):
        self.pools = pools
        self.datasets = DATASETS if datasets is None else datasets
        self.datasets_en_erreur = datasets_en_erreur
        self.datasets_muet = datasets_muet
        self.id_cle, self.secret = cle.split("-", 1)
        self.utilisateur = utilisateur
        self.signature_fausse = signature_fausse
        self.iterations = iterations
        self.sel = os.urandom(16)
        self.messages = []
        self.entetes_gs2 = []
        self.requetes_http = []
        self.trames_non_masquees = 0
        self.contexte = None
        self.liaison_attendue = None
        if tls:
            certificat, cle_privee = tls
            self.contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.contexte.load_cert_chain(certificat, cle_privee)
            with open(certificat, encoding="ascii") as f:
                self.liaison_attendue = hashlib.sha256(ssl.PEM_cert_to_DER_cert(f.read())).digest()
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.url = f"{'https' if tls else 'http'}://127.0.0.1:{self.port}"
        threading.Thread(target=self._boucle, daemon=True).start()

    def _boucle(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _cles(self):
        sale = _PBKDF2("sha512", self.secret.encode(), self.sel, self.iterations)
        client = hmac.digest(sale, b"Client Key", "sha512")
        return hashlib.sha512(client).digest(), hmac.digest(sale, b"Server Key", "sha512")

    def _scram(self, p, etat):
        refus = {"response_type": "AUTH_ERR"}
        if p.get("mechanism") != "SCRAM":
            return refus
        if p.get("scram_type") == "CLIENT_FIRST_MESSAGE":
            gs2, _, nu = p["rfc_str"].partition(",,")
            self.entetes_gs2.append(gs2)
            attrs = dict(x.split("=", 1) for x in nu.split(","))
            if attrs.get("n") != f"{self.utilisateur}:{self.id_cle}":
                return refus
            nonce = base64.b64decode(attrs["r"]) + os.urandom(32)
            sf = f"r={_b64(nonce)},s={_b64(self.sel)},i={self.iterations}"
            etat.update(gs2=gs2, nu=nu, sf=sf, nonce=nonce)
            return {"response_type": "SCRAM_RESPONSE", "scram_type": "SERVER_FIRST_RESPONSE", "rfc_str": sf}
        if p.get("scram_type") == "CLIENT_FINAL_MESSAGE" and "sf" in etat:
            sans_preuve, _, preuve = p["rfc_str"].rpartition(",p=")
            attrs = dict(x.split("=", 1) for x in sans_preuve.split(","))
            if self.liaison_attendue is not None and etat["gs2"] != "p=tls-server-end-point":
                return refus
            attendu = (etat["gs2"] + ",,").encode() + (self.liaison_attendue or b"")
            if base64.b64decode(attrs["c"]) != attendu or attrs["r"] != _b64(etat["nonce"]):
                return refus
            message_auth = f"{etat['nu']},{etat['sf']},{sans_preuve}".encode()
            stockee, serveur = self._cles()
            signature = hmac.digest(stockee, message_auth, "sha512")
            cle_client = bytes(a ^ b for a, b in zip(base64.b64decode(preuve), signature))
            if hashlib.sha512(cle_client).digest() != stockee:
                return refus
            etat["ok"] = True
            v = bytes(64) if self.signature_fausse else hmac.digest(serveur, message_auth, "sha512")
            return {"response_type": "SCRAM_RESPONSE", "scram_type": "SERVER_FINAL_RESPONSE",
                    "rfc_str": "v=" + _b64(v)}
        return refus

    def _client(self, c):
        try:
            if self.contexte is not None:
                c = self.contexte.wrap_socket(c, server_side=True)
            tampon = b""
            while b"\r\n\r\n" not in tampon:
                morceau = c.recv(4096)
                if not morceau:
                    return
                tampon += morceau
            tete, _ = tampon.split(b"\r\n\r\n", 1)
            lignes = tete.decode().split("\r\n")
            methode, chemin, _ = lignes[0].split(" ")
            self.requetes_http.append(chemin)
            entetes = {}
            for l in lignes[1:]:
                k, v = l.split(":", 1)
                entetes[k.strip().lower()] = v.strip()
            if chemin != "/api/current" or entetes.get("upgrade", "").lower() != "websocket":
                c.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                return
            acc = base64.b64encode(hashlib.sha1((entetes["sec-websocket-key"] + _GUID_WS).encode()).digest())
            c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      b"Sec-WebSocket-Accept: " + acc + b"\r\n\r\n")
            etat = {}
            while True:
                b0, b1 = _lire_exact(c, 2)
                opcode = b0 & 0x0F
                masque = b1 & 0x80
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", _lire_exact(c, 2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", _lire_exact(c, 8))[0]
                if not masque:
                    self.trames_non_masquees += 1
                    return
                cle_m = _lire_exact(c, 4)
                charge = bytes(o ^ cle_m[i % 4] for i, o in enumerate(_lire_exact(c, n)))
                if opcode == 8:
                    c.sendall(_trame_serveur(8, b""))
                    return
                if opcode != 1:
                    continue
                msg = json.loads(charge)
                self.messages.append(msg)
                if msg["method"] == "auth.login_ex":
                    rep = {"jsonrpc": "2.0", "id": msg["id"], "result": self._scram(msg["params"][0], etat)}
                    c.sendall(_trame_serveur(1, json.dumps(rep).encode()))
                elif msg["method"] == "pool.query" and etat.get("ok"):
                    # Une notification parasite, un ping, puis la réponse en deux fragments.
                    c.sendall(_trame_serveur(1, json.dumps({"jsonrpc": "2.0", "method": "collection_update",
                                                            "params": {}}).encode()))
                    c.sendall(_trame_serveur(9, b"coucou"))
                    rep = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": self.pools}).encode()
                    moitie = len(rep) // 2
                    c.sendall(_trame_serveur(1, rep[:moitie], fin=False))
                    c.sendall(_trame_serveur(0, rep[moitie:], fin=True))
                elif msg["method"] == "pool.dataset.query" and self.datasets_muet:
                    continue  # TrueNAS chargé (scrub) : ne répond pas à temps
                elif msg["method"] == "pool.dataset.query" and etat.get("ok") and not self.datasets_en_erreur:
                    noms = msg["params"][0][0][2]
                    rep = {"jsonrpc": "2.0", "id": msg["id"],
                           "result": [d for d in self.datasets if d["id"] in noms]}
                    c.sendall(_trame_serveur(1, json.dumps(rep).encode()))
                else:
                    rep = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": 13, "message": "Not authenticated"}}
                    c.sendall(_trame_serveur(1, json.dumps(rep).encode()))
        except (OSError, ConnectionError, ValueError, KeyError):
            pass
        finally:
            c.close()

    def fermer(self):
        self.sock.close()


def _port_ferme():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# --------------------------------------------------------------------------- MikroTik

class TestMikrotik(unittest.TestCase):
    def setUp(self):
        self.srv = FauxHTTP({
            ("GET", "/rest/interface"): (200, _en_chaines(_json("mikrotik_interfaces.json")), "application/json"),
            ("GET", "/rest/system/resource"): (200, _en_chaines(_json("mikrotik_resource.json")), "application/json"),
            ("GET", "/rest/ip/arp"): (200, _en_chaines(_json("mikrotik_arp.json")), "application/json"),
            ("GET", "/rest/ip/dhcp-server/lease"): (200, [], "application/json"),
            ("GET", "/rest/interface/bridge/host"): (200, _en_chaines(_json("mikrotik_bridge_hosts.json")),
                                                    "application/json"),
            ("GET", "/rest/ip/dhcp-client"): (200, [{".id": "*1", "interface": "ether1", "status": "bound",
                                                     "address": "192.168.0.23/24"}], "application/json"),
        })
        self.addCleanup(self.srv.fermer)
        self.cfg = charger_config({
            "ABYSSE_MIKROTIK_URL": self.srv.url + "/rest",
            "ABYSSE_MIKROTIK_USER": "abysse",
            "ABYSSE_MIKROTIK_PASS": PASS_MK,
        })

    def test_mikrotik_chaines(self):
        r = mikrotik.lire_rapide(self.cfg)
        self.assertEqual(set(r), {"interfaces"})
        ether1 = next(i for i in r["interfaces"] if i["name"] == "ether1")
        self.assertEqual(ether1["rx-byte"], "91682063614")
        self.assertEqual(ether1["running"], "true")
        self.assertEqual(mikrotik.lire_lent(self.cfg)["ressource"]["cpu-load"], "4")
        # Les compteurs en chaînes s'utilisent tels quels pour le débit.
        d = CompteurDebit()
        self.assertIsNone(d.maj("ether1:rx", ether1["rx-byte"], 0.0))
        self.assertEqual(d.maj("ether1:rx", str(91682063614 + 1_250_000), 1.0), 10_000_000.0)

    def test_mikrotik_basic_auth(self):
        mikrotik.lire_rapide(self.cfg)
        attendu = "Basic " + base64.b64encode(f"abysse:{PASS_MK}".encode()).decode()
        self.assertTrue(self.srv.requetes)
        for req in self.srv.requetes:
            self.assertEqual(req["entetes"].get("Authorization"), attendu)
            self.assertEqual(req["methode"], "GET")
        self.assertEqual([r["chemin"] for r in self.srv.requetes], ["/rest/interface"])  # une seule requête

    def test_mikrotik_lent(self):
        r = mikrotik.lire_lent(self.cfg)
        self.assertEqual(set(r), {"ressource", "arp", "baux", "hotes_pont", "dhcp_client"})
        self.assertEqual(len(r["arp"]), len(_json("mikrotik_arp.json")))
        self.assertEqual(len(r["hotes_pont"]), len(_json("mikrotik_bridge_hosts.json")))
        self.assertEqual(r["baux"], [])
        self.assertEqual(r["dhcp_client"][0]["status"], "bound")

    def test_mikrotik_sobriete_rest(self):
        # Chaque requête REST ouvre une session sur RouterOS, qui en garde une petite part :
        # moins de 60 000 requêtes par jour.
        from abysse.collecteur import MIKROTIK_LENT_S, MIKROTIK_RAPIDE_S
        self.srv.requetes.clear()
        mikrotik.lire_rapide(self.cfg)
        n_rapide = len(self.srv.requetes)
        self.srv.requetes.clear()
        mikrotik.lire_lent(self.cfg)
        n_lent = len(self.srv.requetes)
        self.assertEqual((n_rapide, n_lent), (1, 5))
        par_jour = 86400 * (n_rapide / MIKROTIK_RAPIDE_S + n_lent / MIKROTIK_LENT_S)
        self.assertLess(par_jour, 60000)

    def test_mikrotik_url_sans_rest(self):
        cfg = charger_config({"ABYSSE_MIKROTIK_URL": self.srv.url + "/", "ABYSSE_MIKROTIK_USER": "abysse",
                              "ABYSSE_MIKROTIK_PASS": PASS_MK})
        r = mikrotik.lire_rapide(cfg)
        self.assertTrue(r["interfaces"])

    def test_mikrotik_reponse_inattendue(self):
        self.srv.routes[("GET", "/rest/interface")] = (200, {"pas": "une liste"}, "application/json")
        with self.assertRaises(ErreurSource):
            mikrotik.lire_rapide(self.cfg)


# --------------------------------------------------------------------------- Proxmox

def _pve_routes():
    return {
        ("GET", "/api2/json/cluster/resources"): (200, {"data": _json("pve_cluster_resources.json")},
                                                  "application/json"),
        ("GET", "/api2/json/nodes/pve/status"): (200, {"data": _json("pve_node_status.json")},
                                                           "application/json"),
        ("GET", "/api2/json/nodes/pve/lxc/143/config"): (200, {"data": {
            "onboot": 1, "hostname": "site-perso",
            "net0": "name=eth0,bridge=vmbr0,firewall=1,gw=192.168.10.198,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.10.186/24,type=veth",
        }}, "application/json"),
        ("GET", "/api2/json/nodes/pve/lxc/105/config"): (200, {"data": {
            "onboot": 0, "net0": "name=eth0,bridge=vmbr0,ip=dhcp,type=veth",
        }}, "application/json"),
        ("GET", "/api2/json/nodes/pve/lxc/210/config"): (500, {"data": None,
            "message": "Configuration file 'nodes/pve/lxc/210.conf' does not exist\n"}, "application/json"),
        ("GET", "/api2/json/nodes/pve/qemu/210/config"): (200, {"data": {
            "net0": "virtio=BC:24:11:00:11:22,bridge=vmbr0", "ipconfig0": "ip=192.168.10.34/24,gw=192.168.10.198",
        }}, "application/json"),
        ("GET", "/api2/json/nodes/pve/qemu/220/config"): (200, {"data": {
            "onboot": "0", "net0": "e1000=BC:24:11:33:44:55,bridge=vmbr0",
        }}, "application/json"),
    }


class TestProxmox(unittest.TestCase):
    def setUp(self):
        self.srv = FauxHTTP(_pve_routes())
        self.addCleanup(self.srv.fermer)
        self.cfg = charger_config({"ABYSSE_PVE_URL": self.srv.url + "/api2/json", "ABYSSE_PVE_JETON": JETON_PVE,
                                   "ABYSSE_PVE_CA": ""})

    def test_proxmox_entete_jeton(self):
        r = proxmox.lire(self.cfg)
        self.assertEqual(set(r), {"ressources", "noeud"})
        self.assertEqual(len(r["ressources"]), len(_json("pve_cluster_resources.json")))
        self.assertIn("memory", r["noeud"])
        for req in self.srv.requetes:
            self.assertEqual(req["entetes"].get("Authorization"), f"PVEAPIToken={JETON_PVE}")
        self.assertEqual({r["chemin"] for r in self.srv.requetes},
                         {"/api2/json/cluster/resources", "/api2/json/nodes/pve/status"})

    def test_proxmox_ip_net0(self):
        r = proxmox.lire_configs(self.cfg, [143, 105, 210])
        self.assertEqual(r[143], {"onboot": 1, "ip": "192.168.10.186"})
        self.assertEqual(r[105], {"onboot": 0, "ip": None})  # ip=dhcp : pas d'IP fixe
        # 210 n'est pas un CT : repli sur qemu, IP depuis ipconfig0, onboot absent = 0
        self.assertEqual(r[210], {"onboot": 0, "ip": "192.168.10.34"})

    def test_proxmox_configs_types_connus(self):
        r = proxmox.lire_configs(self.cfg, {220: "qemu", 143: "lxc"})
        self.assertEqual(r, {220: {"onboot": 0, "ip": None}, 143: {"onboot": 1, "ip": "192.168.10.186"}})
        chemins = [q["chemin"] for q in self.srv.requetes]
        self.assertNotIn("/api2/json/nodes/pve/lxc/220/config", chemins)

    def test_proxmox_config_absente_ignoree(self):
        r = proxmox.lire_configs(self.cfg, [143, 4242])
        self.assertEqual(set(r), {143})

    def test_proxmox_jeton_refuse(self):
        refus = (401, {"data": None, "message": "authentication failure"}, "application/json")
        for k in list(self.srv.routes):
            self.srv.routes[k] = refus
        with self.assertRaises(ErreurSource) as ctx:
            proxmox.lire_configs(self.cfg, [143, 105])
        self.assertEqual(ctx.exception.statut, 401)

    def test_proxmox_url_sans_api2(self):
        cfg = charger_config({"ABYSSE_PVE_URL": self.srv.url, "ABYSSE_PVE_JETON": JETON_PVE})
        self.assertTrue(proxmox.lire(cfg)["ressources"])


# --------------------------------------------------------------------------- NUT

def _nut_fixture():
    valeurs = {}
    for ligne in _octets("nut_upsc.txt").decode().splitlines():
        if ":" in ligne:
            k, v = ligne.split(":", 1)
            valeurs[k.strip()] = v.strip()
    return valeurs


class TestNut(unittest.TestCase):
    def test_nut_parse(self):
        valeurs = _nut_fixture()
        valeurs["ups.test.result"] = 'Pas de "test" \\ fait'  # guillemets et barre oblique échappés
        srv = FauxNUT(valeurs)
        self.addCleanup(srv.fermer)
        r = nut.lire("127.0.0.1", srv.port, "onduleur")
        self.assertEqual(r["battery.charge"], "100")
        self.assertEqual(r["input.voltage"], "234.6")
        self.assertEqual(r["ups.status"], "OL")
        self.assertEqual(r["ups.test.result"], 'Pas de "test" \\ fait')
        self.assertEqual(len(r), len(valeurs))
        self.assertIn("LIST VAR onduleur", srv.commandes)

    def test_nut_ups_inconnu(self):
        srv = FauxNUT(_nut_fixture())
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource):
            nut.lire("127.0.0.1", srv.port, "autre")

    def test_nut_refuse(self):
        with self.assertRaises(ErreurSource):
            nut.lire("127.0.0.1", _port_ferme(), "onduleur", delai=1)

    def test_nut_muet(self):
        srv = FauxMuet()
        self.addCleanup(srv.fermer)
        debut = time.monotonic()
        with self.assertRaises(ErreurSource):
            nut.lire("127.0.0.1", srv.port, "onduleur", delai=1)
        self.assertLess(time.monotonic() - debut, 2.5)


# --------------------------------------------------------------------------- InfluxDB

def _lignes_donnees_csv(texte):
    """Nombre de lignes de données d'un CSV annoté (ni annotation, ni en-tête, ni vide)."""
    n = 0
    entete_vu = False
    for ligne in texte.splitlines():
        if not ligne.strip():
            entete_vu = False
        elif ligne.startswith("#"):
            continue
        elif not entete_vu:
            entete_vu = True
        else:
            n += 1
    return n


class TestInflux(unittest.TestCase):
    def setUp(self):
        self.csv = _octets("influx_extraits.csv")
        self.srv = FauxHTTP({("POST", "/api/v2/query"): (200, self.csv, "text/csv; charset=utf-8")})
        self.addCleanup(self.srv.fermer)
        self.cfg = charger_config({"ABYSSE_INFLUX_URL": self.srv.url, "ABYSSE_INFLUX_JETON": JETON_INFLUX,
                                   "ABYSSE_INFLUX_ORG": "homelab"})

    def test_influx_csv_multi_tables(self):
        lignes = influx.requete(self.cfg, 'from(bucket: "homelab") |> range(start: -15m) |> last()')
        self.assertEqual(len(lignes), _lignes_donnees_csv(self.csv.decode()))
        # Des tables aux schémas différents : colonnes propres à chacune.
        raid = next(l for l in lignes if l.get("_field") == "raid_total_size")
        self.assertEqual(raid["_value"], 1964250939392)  # long -> int
        self.assertEqual(raid["raid_name"], "Volume 1")
        kuma = next(l for l in lignes if l.get("monitor_name") == "host-pbs")
        self.assertEqual(kuma["_value"], 1.0)  # double -> float
        self.assertEqual(kuma["_measurement"], "monitor_status")
        sante = next(l for l in lignes if l.get("_field") == "health")
        self.assertEqual(sante["_value"], "ONLINE")  # string
        cpu = next(l for l in lignes if l.get("_field") == "cpu" and l.get("vmid") == "105")
        self.assertIsInstance(cpu["_value"], float)  # double « 0 » -> 0.0
        self.assertEqual(cpu["_value"], 0.0)
        statut = next(l for l in lignes if l.get("_field") == "status" and l.get("vmid") == "105")
        self.assertEqual(statut["_value"], "stopped")
        self.assertNotIn("", lignes[0])  # colonne d'annotation retirée
        # Requête : POST, org dans l'URL, jeton, CSV annoté demandé.
        req = self.srv.requetes[0]
        self.assertEqual(req["methode"], "POST")
        self.assertEqual(req["chemin"], "/api/v2/query?org=homelab")
        self.assertEqual(req["entetes"].get("Authorization"), f"Token {JETON_INFLUX}")
        self.assertEqual(req["entetes"].get("Accept"), "application/csv")
        corps = json.loads(req["corps"])
        self.assertIn("range(start: -15m)", corps["query"])
        self.assertIn("datatype", corps["dialect"]["annotations"])

    def test_influx_csv_brut(self):
        texte = (
            "#datatype,string,long,dateTime:RFC3339,double,string\r\n"
            "#group,false,false,false,false,true\r\n"
            "#default,_result,,,,\r\n"
            ",result,table,_time,_value,nom\r\n"
            ',,0,2026-10-26T00:00:00Z,1.5,"a,b"\r\n'
            ",,0,2026-10-26T00:00:01Z,,c\r\n"
            "\r\n"
            ",result,table,_value\r\n"  # table suivante sans annotations
            ",,1,texte\r\n"
        )
        lignes = influx.analyser_csv(texte)
        self.assertEqual(lignes[0], {"result": "_result", "table": 0, "_time": "2026-10-26T00:00:00Z",
                                     "_value": 1.5, "nom": "a,b"})
        self.assertIsNone(lignes[1]["_value"])
        self.assertEqual(lignes[2], {"result": "", "table": "1", "_value": "texte"})

    def test_influx_erreur_dans_csv(self):
        self.srv.routes[("POST", "/api/v2/query")] = (
            200, "#datatype,string,string\n#group,true,true\n#default,,\n,error,reference\n,quelque chose,897\n",
            "text/csv")
        with self.assertRaises(ErreurSource):
            influx.requete(self.cfg, "x")

    def test_influx_lire(self):
        r = influx.lire(self.cfg)
        self.assertEqual(set(r), {"kuma", "synology", "pbs_pool"})
        self.assertEqual(r["kuma"]["host-pbs"], 1)
        self.assertEqual(r["kuma"]["net-mikrotik"], 1)
        self.assertTrue(all(v in (0, 1) for v in r["kuma"].values()))
        self.assertEqual(r["synology"], {"raid_total_size": 1964250939392, "raid_free_size": 849346379776,
                                         "system_status": 1})
        self.assertEqual(r["pbs_pool"], {"size": 15977278341120, "alloc": 2545320828928, "health": "ONLINE"})
        corps = json.loads(self.srv.requetes[0]["corps"])["query"]
        for mot in ("monitor_status", "synology", "zfs_pool_etat", "last()", "-15m"):
            self.assertIn(mot, corps)

    def test_influx_kuma_bas(self):
        texte = (
            "#datatype,string,long,double,string,string,string\n"
            "#group,false,false,false,true,true,true\n"
            "#default,_result,,,,,\n"
            ",result,table,_value,_field,_measurement,monitor_name\n"
            ",,0,0,gauge,monitor_status,host-pbs\n"
            ",,1,2,gauge,monitor_status,svc-x\n"
        )
        self.srv.routes[("POST", "/api/v2/query")] = (200, texte, "text/csv")
        r = influx.lire(self.cfg)
        self.assertEqual(r["kuma"], {"host-pbs": 0, "svc-x": 1})
        self.assertEqual(r["synology"], {})
        self.assertEqual(r["pbs_pool"], {})


# --------------------------------------------------------------------------- TrueNAS

POOLS = [  # taille brute des disques (parité comprise), comme pool.query
    {"id": 1, "name": "NAS", "status": "ONLINE", "healthy": True, "size": 23987000000000,
     "allocated": 3800000000000, "free": 20187000000000},
    {"id": 2, "name": "boot-pool", "status": "ONLINE", "healthy": True, "size": 32212254720,
     "allocated": 3221225472, "free": 28991029248},
]

DATASETS = [  # dataset racine : espace utilisable (le boot-pool n'en a pas dans pool.dataset.query)
    {"id": "NAS", "used": {"parsed": 2418925756416, "value": "2.2 TiB"},
     "available": {"parsed": 13575532453888, "value": "12.3 TiB"}},
]


def _der(etiquette, contenu):
    n = len(contenu)
    longueur = bytes([n]) if n < 128 else (bytes([0x81, n]) if n < 256 else b"\x82" + n.to_bytes(2, "big"))
    return bytes([etiquette]) + longueur + contenu


def _oid_der(oid):
    arcs = [int(a) for a in oid.split(".")]
    sortie = bytes([40 * arcs[0] + arcs[1]])
    for a in arcs[2:]:
        groupe = [a & 0x7F]
        a >>= 7
        while a:
            groupe.append(0x80 | (a & 0x7F))
            a >>= 7
        sortie += bytes(reversed(groupe))
    return _der(0x06, sortie)


def _faux_certificat(oid, parametres=b""):
    algo = _der(0x30, _oid_der(oid) + parametres)
    return _der(0x30, _der(0x30, b"\x02\x01\x01" + b"x" * 200) + algo + _der(0x03, b"\x00signature"))


def _certificat_essai():
    """(certificat, clé privée) auto-signés en SHA-256 dans un dossier temporaire, ou None sans openssl."""
    exe = shutil.which("openssl")
    if not exe:
        return None
    dossier = tempfile.mkdtemp(prefix="abysse-tls-")
    cert, cle = os.path.join(dossier, "cert.pem"), os.path.join(dossier, "cle.pem")
    r = subprocess.run([exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
                        "-subj", "/CN=truenas-essai", "-keyout", cle, "-out", cert],
                       capture_output=True, timeout=60)
    return (cert, cle) if r.returncode == 0 else None


class TestTruenas(unittest.TestCase):
    def setUp(self):
        truenas._derivations.clear()

    def _cfg(self, url, cle=CLE_TRUENAS, ca=""):
        return charger_config({"ABYSSE_TRUENAS_URL": url, "ABYSSE_TRUENAS_CLE": cle, "ABYSSE_TRUENAS_CA": ca})

    def _verifier_sans_secret(self, srv, erreur=None):
        secret = CLE_TRUENAS.split("-", 1)[1]
        self.assertNotIn(secret, json.dumps(srv.messages))
        if erreur is not None:
            self.assertNotIn(secret, str(erreur))

    def test_truenas_scram(self):
        srv = FauxTrueNAS(POOLS)
        self.addCleanup(srv.fermer)
        r = truenas.lire(self._cfg(srv.url))
        self.assertEqual(set(r["pools"]), {"NAS", "boot-pool"})
        # Espace utilisable du dataset racine (2,4 / 16 To), pas la taille brute des disques.
        self.assertEqual(r["pools"]["NAS"], {"taille": 15994458210304, "alloue": 2418925756416, "etat": "ONLINE"})
        self.assertEqual(r["pools"]["boot-pool"], {"taille": 32212254720, "alloue": 3221225472, "etat": "ONLINE"})
        self.assertEqual([m["method"] for m in srv.messages],
                         ["auth.login_ex", "auth.login_ex", "pool.query", "pool.dataset.query"])
        self.assertTrue(all(m.get("jsonrpc") == "2.0" for m in srv.messages))
        self.assertEqual(srv.entetes_gs2, ["n"])  # ws:// local : pas de liaison de canal
        self.assertEqual(srv.requetes_http, ["/api/current"])  # plus aucune requête REST
        self.assertEqual(srv.trames_non_masquees, 0)
        self._verifier_sans_secret(srv)

    def test_truenas_capacite_brute_si_datasets_illisibles(self):
        srv = FauxTrueNAS(POOLS, datasets_en_erreur=True)
        self.addCleanup(srv.fermer)
        r = truenas.lire(self._cfg(srv.url))
        self.assertEqual(r["pools"]["NAS"], {"taille": 23987000000000, "alloue": 3800000000000, "etat": "ONLINE"})

    def test_truenas_capacite_brute_si_datasets_muets(self):
        srv = FauxTrueNAS(POOLS, datasets_muet=True)
        self.addCleanup(srv.fermer)
        url_ws = srv.url.replace("http://", "ws://") + "/api/current"
        r = truenas.lire_websocket(url_ws, "abysse", CLE_TRUENAS, delai=0.5)
        self.assertEqual(r["pools"]["NAS"]["etat"], "ONLINE")
        self.assertEqual(r["pools"]["NAS"]["taille"], 23987000000000)

    def test_truenas_json_hostile(self):
        class WsFactice:
            def __init__(self, texte):
                self.texte = texte

            def envoyer(self, texte):
                pass

            def recevoir(self):
                return self.texte

        for texte in ('{"jsonrpc": "2.0", "id": 3, "result": [{"name": "NAS", "size": Infinity}]}',
                      '{"jsonrpc": "2.0", "id": 3, "result": NaN}',
                      "[" * 200_000):
            with self.assertRaises(ErreurSource):
                truenas._appel(WsFactice(texte), 3, "pool.query", [])

    def test_truenas_derivation_memorisee(self):
        srv = FauxTrueNAS(POOLS)
        self.addCleanup(srv.fermer)
        with mock.patch.object(truenas.hashlib, "pbkdf2_hmac", wraps=_PBKDF2) as pbkdf2:
            truenas.lire(self._cfg(srv.url))
            truenas.lire(self._cfg(srv.url))
        self.assertEqual(pbkdf2.call_count, 1)

    def test_truenas_cle_refusee(self):
        srv = FauxTrueNAS(POOLS, cle="1-UneAutreCle0123456789")  # même id, autre secret
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource) as ctx:
            truenas.lire(self._cfg(srv.url))
        self.assertEqual(ctx.exception.statut, 401)
        self.assertNotIn("pool.query", [m["method"] for m in srv.messages])
        self._verifier_sans_secret(srv, ctx.exception)

    def test_truenas_id_de_cle_inconnu(self):
        srv = FauxTrueNAS(POOLS, cle="7-" + CLE_TRUENAS.split("-", 1)[1])
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource) as ctx:
            truenas.lire(self._cfg(srv.url))
        self.assertEqual(ctx.exception.statut, 401)
        self.assertEqual(len(srv.messages), 1)
        self._verifier_sans_secret(srv, ctx.exception)

    def test_truenas_signature_serveur_fausse(self):
        # Un faux serveur qui accepte n'importe quelle preuve ne passe pas : il doit prouver qu'il a la clé.
        srv = FauxTrueNAS(POOLS, signature_fausse=True)
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource) as ctx:
            truenas.lire(self._cfg(srv.url))
        self.assertIn("signature", str(ctx.exception))
        self.assertNotIn("pool.query", [m["method"] for m in srv.messages])

    def test_truenas_tours_hors_bornes(self):
        srv = FauxTrueNAS(POOLS, iterations=1000)  # serveur hostile : dérivation affaiblie
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource):
            truenas.lire(self._cfg(srv.url))
        self.assertEqual(len(srv.messages), 1)

    def test_truenas_tls_liaison_de_canal(self):
        paire = _certificat_essai()
        if paire is None:
            self.skipTest("openssl absent")
        srv = FauxTrueNAS(POOLS, tls=paire)
        self.addCleanup(srv.fermer)
        r = truenas.lire(self._cfg(srv.url, ca=paire[0]))
        self.assertEqual(r["pools"]["NAS"]["etat"], "ONLINE")
        self.assertEqual(srv.entetes_gs2, ["p=tls-server-end-point"])
        self._verifier_sans_secret(srv)

    def test_truenas_cle_mal_formee(self):
        srv = FauxTrueNAS(POOLS)
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource) as ctx:
            truenas.lire(self._cfg(srv.url, cle="pas une clé, secret-123"))
        self.assertNotIn("secret-123", str(ctx.exception))
        self.assertEqual(srv.messages, [])

    def test_truenas_http_distant_refuse(self):
        # Jamais de transport en clair hors de la boucle locale (pas de liaison de canal possible).
        debut = time.monotonic()
        with self.assertRaises(ErreurSource) as ctx:
            truenas.lire(self._cfg("http://10.255.255.1"))
        self.assertLess(time.monotonic() - debut, 0.5)
        self.assertNotIn(CLE_TRUENAS, str(ctx.exception))

    def test_liaison_canal(self):
        with open(os.path.join(FIXTURES, "pve-ca-test.pem"), encoding="ascii") as f:
            der = ssl.PEM_cert_to_DER_cert(f.read())  # sha256WithRSAEncryption
        self.assertEqual(truenas.liaison_canal(der), hashlib.sha256(der).digest())
        cas = {
            "1.2.840.10045.4.3.3": hashlib.sha384,   # ecdsa-with-SHA384
            "1.2.840.113549.1.1.5": hashlib.sha256,  # sha1WithRSA -> SHA-256 (RFC 5929)
            "1.2.840.113549.1.1.13": hashlib.sha512,
        }
        for oid, h in cas.items():
            faux = _faux_certificat(oid, b"\x05\x00")
            self.assertEqual(truenas.liaison_canal(faux), h(faux).digest(), oid)
        pss_sha512 = _der(0x30, _der(0xA0, _der(0x30, _oid_der("2.16.840.1.101.3.4.2.3"))))
        faux = _faux_certificat("1.2.840.113549.1.1.10", pss_sha512)
        self.assertEqual(truenas.liaison_canal(faux), hashlib.sha512(faux).digest())
        faux = _faux_certificat("1.2.840.113549.1.1.10")
        self.assertEqual(truenas.liaison_canal(faux), hashlib.sha256(faux).digest())
        with self.assertRaises(ErreurSource):
            truenas.liaison_canal(_faux_certificat("1.3.101.112"))  # Ed25519 : pas de hachage défini
        with self.assertRaises(ErreurSource):
            truenas.liaison_canal(b"\x30\x82\xff")


# --------------------------------------------------------------------------- erreurs, délais, sécurité

class TestErreurs(unittest.TestCase):
    def test_erreur_sans_secret(self):
        refus = (401, {"message": "authentication failure", "echo": "rien"}, "application/json")
        srv = FauxHTTP({
            ("GET", "/api2/json/cluster/resources"): refus,
            ("GET", "/rest/interface"): refus,
            ("POST", "/api/v2/query"): refus,
        })
        self.addCleanup(srv.fermer)
        cfg = charger_config({
            "ABYSSE_PVE_URL": srv.url + "/api2/json", "ABYSSE_PVE_JETON": JETON_PVE,
            "ABYSSE_MIKROTIK_URL": srv.url + "/rest", "ABYSSE_MIKROTIK_USER": "abysse",
            "ABYSSE_MIKROTIK_PASS": PASS_MK,
            "ABYSSE_INFLUX_URL": srv.url, "ABYSSE_INFLUX_JETON": JETON_INFLUX,
        })
        secrets = (JETON_PVE, PASS_MK, JETON_INFLUX, base64.b64encode(f"abysse:{PASS_MK}".encode()).decode())
        for appel in (lambda: proxmox.lire(cfg), lambda: mikrotik.lire_rapide(cfg), lambda: influx.lire(cfg)):
            with self.assertRaises(ErreurSource) as ctx:
                appel()
            e = ctx.exception
            self.assertEqual(e.statut, 401)
            texte = str(e) + repr(e) + repr(e.args)
            for s in secrets:
                self.assertNotIn(s, texte)
            self.assertIsNone(e.__cause__)
            self.assertTrue(e.__suppress_context__)

    def test_url_avec_identifiants_masquee(self):
        port = _port_ferme()
        with self.assertRaises(ErreurSource) as ctx:
            shttp.requete_json(f"http://abysse:{PASS_MK}@127.0.0.1:{port}/rest/interface", {}, delai=1)
        self.assertNotIn(PASS_MK, str(ctx.exception))

    def test_delai(self):
        srv = FauxMuet()
        self.addCleanup(srv.fermer)
        debut = time.monotonic()
        with self.assertRaises(ErreurSource):
            shttp.requete_json(f"http://127.0.0.1:{srv.port}/rest/interface", {})
        self.assertLess(time.monotonic() - debut, 6.0)

    def test_connexion_refusee(self):
        with self.assertRaises(ErreurSource) as ctx:
            shttp.requete_json(f"http://127.0.0.1:{_port_ferme()}/x", {}, delai=1)
        self.assertIsNone(ctx.exception.statut)

    def test_json_invalide(self):
        srv = FauxHTTP({("GET", "/x"): (200, b"<html>pas du json</html>", "text/html")})
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource):
            shttp.requete_json(srv.url + "/x", {})

    def test_pas_de_redirection(self):
        # Une redirection ne doit pas emporter l'en-tête d'authentification ailleurs.
        cible = FauxHTTP({("GET", "/vole"): (200, [], "application/json")})
        self.addCleanup(cible.fermer)
        srv = FauxHTTP({("GET", "/x"): (302, b"", "text/plain", {"Location": cible.url + "/vole"})})
        self.addCleanup(srv.fermer)
        with self.assertRaises(ErreurSource) as ctx:
            shttp.requete_json(srv.url + "/x", {"Authorization": f"PVEAPIToken={JETON_PVE}"})
        self.assertEqual(ctx.exception.statut, 302)
        self.assertEqual(cible.requetes, [])

    def test_ca_illisible(self):
        with self.assertRaises(ErreurSource):
            shttp.requete_json("https://127.0.0.1:1/x", {}, ca=os.path.join(FIXTURES, "absente.pem"), delai=1)

    def test_corps_post(self):
        srv = FauxHTTP({("POST", "/p"): (200, {"ok": True}, "application/json")})
        self.addCleanup(srv.fermer)
        r = shttp.requete_json(srv.url + "/p", {"Content-Type": "application/json"}, methode="POST", corps=b'{"a":1}')
        self.assertEqual(r, {"ok": True})
        self.assertEqual(srv.requetes[0]["corps"], b'{"a":1}')


if __name__ == "__main__":
    unittest.main()


class TestTlsCaInterne(unittest.TestCase):
    def test_ca_interne_sans_mode_strict(self):
        import ssl
        from abysse.sources.http import contexte_tls
        ca = os.path.join(os.path.dirname(__file__), "fixtures", "pve-ca-test.pem")
        ctx = contexte_tls(ca)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertFalse(ctx.verify_flags & getattr(ssl, "VERIFY_X509_STRICT", 0))
