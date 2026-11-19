"""TrueNAS (VM 200, 192.168.10.31), lecture seule : utilisateur ``abysse`` (rôle READONLY_ADMIN)
et sa clé d'API ``<id>-<secret>``.

TrueNAS 27 n'a plus d'API REST : client JSON-RPC 2.0 en WebSocket sur ``/api/current``
(bibliothèque standard, ``socket`` + ``ssl``, trames RFC 6455 masquées), puis ``pool.query``
(état des pools) et ``pool.dataset.query`` sur leurs datasets racines (espace utilisable, parité
exclue : ``pool.query`` ne donne que la taille brute des disques).

Authentification ``auth.login_ex`` par le mécanisme ``SCRAM`` (SCRAM-SHA-512, RFC 5802), comme
le client officiel ``truenas_api_client`` (``midclt``) :

- la clé ne circule jamais, même chiffrée : seule une preuve dérivée (PBKDF2-HMAC-SHA512) part ;
- le nom envoyé est ``<utilisateur>:<id de la clé>`` (variante TrueNAS : un compte peut avoir
  plusieurs clés) ;
- en ``wss://``, liaison de canal ``tls-server-end-point`` (RFC 5929) : la preuve est liée au
  certificat reçu, un intermédiaire qui présenterait un autre certificat la rendrait invalide ;
- le serveur prouve à son tour qu'il connaît la clé (signature finale vérifiée) avant toute
  lecture.

Transport : ``https://`` (donc ``wss://``) obligatoire, certificat vérifié contre
``cfg.truenas_ca`` si fourni ; ``http://`` accepté vers la boucle locale seulement (essais),
sans liaison de canal. Aucun message d'erreur ne cite la clé, les messages SCRAM ni les
réponses du serveur.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import ssl
import struct
import threading
import time
import urllib.parse

from . import ErreurSource
from .http import contexte_tls

NOM = "TrueNAS"
CHEMIN_WS = "/api/current"
_GUID_WS = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TAILLE_MAX = 16 * 1024 * 1024

# Bornes et tailles du client officiel (truenas_api_client, py_scram).
ITERATIONS_MIN, ITERATIONS_MAX = 50_000, 5_000_000
TAILLE_NONCE = 32
SEL_MAX = 1024
LIAISON = "tls-server-end-point"

_UTILISATEUR_VALIDE = re.compile(r"[A-Za-z0-9._-]{1,64}")  # ni « , » ni « = » (RFC 5802)
_CLE_VALIDE = re.compile(r"(\d+)-([A-Za-z0-9]+)")         # format des clés brutes de TrueNAS

# Algorithme de signature du certificat -> hachage de la liaison de canal (RFC 5929, 4.1 :
# MD5 et SHA-1 sont remplacés par SHA-256). DSA et EdDSA ne sont pas pris en charge.
_HACHAGE_SIGNATURE = {
    "1.2.840.113549.1.1.4": "sha256",    # md5WithRSAEncryption
    "1.2.840.113549.1.1.5": "sha256",    # sha1WithRSAEncryption
    "1.2.840.113549.1.1.14": "sha224",
    "1.2.840.113549.1.1.11": "sha256",
    "1.2.840.113549.1.1.12": "sha384",
    "1.2.840.113549.1.1.13": "sha512",
    "1.2.840.10045.4.1": "sha256",       # ecdsa-with-SHA1
    "1.2.840.10045.4.3.1": "sha224",
    "1.2.840.10045.4.3.2": "sha256",
    "1.2.840.10045.4.3.3": "sha384",
    "1.2.840.10045.4.3.4": "sha512",
}
_RSASSA_PSS = "1.2.840.113549.1.1.10"   # le hachage est dans les paramètres, pas dans l'OID
_HACHAGE_PSS = {
    "1.2.840.113549.2.5": "sha256",      # MD5
    "1.3.14.3.2.26": "sha256",           # SHA-1
    "2.16.840.1.101.3.4.2.4": "sha224",
    "2.16.840.1.101.3.4.2.1": "sha256",
    "2.16.840.1.101.3.4.2.2": "sha384",
    "2.16.840.1.101.3.4.2.3": "sha512",
}

# Dérivation PBKDF2 (500 000 tours chez TrueNAS) gardée en mémoire : le sel ne change qu'avec
# la clé. Indexée par l'empreinte du secret, jamais par le secret lui-même.
_derivations: dict[tuple[bytes, bytes, int], tuple[bytes, bytes, bytes]] = {}
_verrou = threading.Lock()


def _boucle_locale(hote: str) -> bool:
    if hote == "localhost":
        return True
    try:
        return ipaddress.ip_address(hote).is_loopback
    except ValueError:
        return False


def _pools(liste: object) -> dict:
    if not isinstance(liste, list):
        raise ErreurSource(f"{NOM} : réponse inattendue")
    pools = {}
    for p in liste:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        taille, alloue = p.get("size"), p.get("allocated")
        pools[p["name"]] = {
            "taille": int(taille) if isinstance(taille, (int, float)) and not isinstance(taille, bool) else None,
            "alloue": int(alloue) if isinstance(alloue, (int, float)) and not isinstance(alloue, bool) else None,
            "etat": p.get("status") if isinstance(p.get("status"), str) else None,
        }
    return {"pools": pools}


def _capacites(liste: object) -> dict[str, tuple[int, int]]:
    """``{pool: (utilisé, utilisable)}`` d'après les datasets racines (``used`` + ``available``)."""
    capacites: dict[str, tuple[int, int]] = {}
    if not isinstance(liste, list):
        return capacites

    def nombre(d: dict, champ: str) -> int | None:
        v = d.get(champ)
        v = v.get("parsed") if isinstance(v, dict) else None
        return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None

    for d in liste:
        if not isinstance(d, dict) or not isinstance(d.get("id"), str):
            continue
        utilise, disponible = nombre(d, "used"), nombre(d, "available")
        if utilise is not None and disponible is not None:
            capacites[d["id"]] = (utilise, utilise + disponible)
    return capacites


# --------------------------------------------------------------------------- liaison de canal

def _tlv(der: bytes, pos: int) -> tuple[int, int, int]:
    """``(étiquette, début, fin)`` de l'élément DER en ``pos`` (étiquettes courtes seulement)."""
    if pos + 2 > len(der):
        raise ValueError("DER tronqué")
    etiquette, n = der[pos], der[pos + 1]
    pos += 2
    if n & 0x80:
        k = n & 0x7F
        if not 1 <= k <= 4 or pos + k > len(der):
            raise ValueError("longueur DER invalide")
        n = int.from_bytes(der[pos:pos + k], "big")
        pos += k
    if pos + n > len(der):
        raise ValueError("DER tronqué")
    return etiquette, pos, pos + n


def _oid(octets: bytes) -> str:
    if not octets:
        raise ValueError("OID vide")
    premier = min(octets[0] // 40, 2)
    parties = [str(premier), str(octets[0] - 40 * premier)]
    valeur = 0
    for o in octets[1:]:
        valeur = (valeur << 7) | (o & 0x7F)
        if not o & 0x80:
            parties.append(str(valeur))
            valeur = 0
    return ".".join(parties)


def _hachage_pss(parametres: bytes) -> str | None:
    """Hachage de ``RSASSA-PSS-params`` (absent : SHA-1 par défaut, donc SHA-256 ici)."""
    if not parametres:
        return "sha256"
    t, debut, fin = _tlv(parametres, 0)
    if t != 0x30:
        raise ValueError("paramètres PSS invalides")
    if debut >= fin:
        return "sha256"
    t, debut, _ = _tlv(parametres, debut)
    if t != 0xA0:                      # [0] hashAlgorithm omis
        return "sha256"
    t, debut, _ = _tlv(parametres, debut)
    if t != 0x30:
        raise ValueError("paramètres PSS invalides")
    t, debut, fin = _tlv(parametres, debut)
    if t != 0x06:
        raise ValueError("paramètres PSS invalides")
    return _HACHAGE_PSS.get(_oid(parametres[debut:fin]))


def liaison_canal(der: bytes) -> bytes:
    """Donnée ``tls-server-end-point`` (RFC 5929) : le certificat DER haché avec l'algorithme de
    sa propre signature (MD5 et SHA-1 remplacés par SHA-256)."""
    try:
        t, debut, _ = _tlv(der, 0)                     # Certificate
        if t != 0x30:
            raise ValueError("pas un certificat")
        t, _, fin_tbs = _tlv(der, debut)               # tbsCertificate
        if t != 0x30:
            raise ValueError("pas un certificat")
        t, debut_alg, fin_alg = _tlv(der, fin_tbs)     # signatureAlgorithm
        if t != 0x30:
            raise ValueError("pas un certificat")
        t, debut, fin = _tlv(der, debut_alg)           # algorithm OBJECT IDENTIFIER
        if t != 0x06:
            raise ValueError("pas un certificat")
        oid = _oid(der[debut:fin])
        hachage = _hachage_pss(der[fin:fin_alg]) if oid == _RSASSA_PSS else _HACHAGE_SIGNATURE.get(oid)
    except (ValueError, IndexError):
        raise ErreurSource(f"{NOM} : certificat du serveur illisible") from None
    if hachage is None:
        raise ErreurSource(f"{NOM} : algorithme de signature du certificat non pris en charge")
    return hashlib.new(hachage, der).digest()


# --------------------------------------------------------------------------- WebSocket

class _WebSocket:
    """Client WebSocket minimal (texte seulement), bloquant, borné par une échéance."""

    def __init__(self, url: str, ca: str | None, delai: float) -> None:
        d = urllib.parse.urlsplit(url)
        securise = d.scheme in ("wss", "https")
        self.hote = d.hostname or ""
        port = d.port or (443 if securise else 80)
        self.echeance = time.monotonic() + 3 * delai
        self.tampon = b""
        brut = socket.create_connection((self.hote, port), timeout=delai)
        try:
            if securise:
                self.sock = contexte_tls(ca).wrap_socket(brut, server_hostname=self.hote)
            else:
                self.sock = brut
            self._poignee_de_main(d, port, securise)
        except BaseException:
            brut.close()
            raise

    def certificat_der(self) -> bytes | None:
        """Certificat du serveur (DER) en ``wss://``, ``None`` en ``ws://``."""
        if isinstance(self.sock, ssl.SSLSocket):
            return self.sock.getpeercert(binary_form=True) or None
        return None

    def _poignee_de_main(self, d, port: int, securise: bool) -> None:
        cle = base64.b64encode(os.urandom(16)).decode("ascii")
        defaut = 443 if securise else 80
        hote = self.hote if ":" not in self.hote else f"[{self.hote}]"
        hote_entete = hote if port == defaut else f"{hote}:{port}"
        demande = (
            f"GET {d.path or '/'} HTTP/1.1\r\n"
            f"Host: {hote_entete}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {cle}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.sock.sendall(demande.encode("ascii"))
        while b"\r\n\r\n" not in self.tampon:
            self._recevoir()
            if len(self.tampon) > 65536:
                raise ErreurSource(f"{NOM} : réponse WebSocket invalide")
        tete, self.tampon = self.tampon.split(b"\r\n\r\n", 1)
        lignes = tete.decode("latin-1").split("\r\n")
        morceaux = lignes[0].split(" ")
        if len(morceaux) < 2 or morceaux[1] != "101":
            statut = int(morceaux[1]) if len(morceaux) > 1 and morceaux[1].isdigit() else None
            raise ErreurSource(f"{NOM} : WebSocket refusé (HTTP {statut})", statut)
        entetes = {}
        for l in lignes[1:]:
            k, _, v = l.partition(":")
            entetes[k.strip().lower()] = v.strip()
        attendu = base64.b64encode(hashlib.sha1((cle + _GUID_WS).encode("ascii")).digest()).decode("ascii")
        if entetes.get("sec-websocket-accept") != attendu:
            raise ErreurSource(f"{NOM} : poignée de main WebSocket invalide")

    def _recevoir(self) -> None:
        if time.monotonic() > self.echeance:
            raise ErreurSource(f"{NOM} : délai dépassé")
        morceau = self.sock.recv(65536)
        if not morceau:
            raise ErreurSource(f"{NOM} : connexion fermée par le serveur")
        self.tampon += morceau

    def _lire(self, n: int) -> bytes:
        while len(self.tampon) < n:
            self._recevoir()
        donnees, self.tampon = self.tampon[:n], self.tampon[n:]
        return donnees

    def _envoyer_trame(self, opcode: int, charge: bytes) -> None:
        tete = bytes([0x80 | opcode])
        n = len(charge)
        if n < 126:
            tete += bytes([0x80 | n])
        elif n < 65536:
            tete += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            tete += bytes([0x80 | 127]) + struct.pack("!Q", n)
        masque = os.urandom(4)
        masquee = bytes(o ^ masque[i % 4] for i, o in enumerate(charge))
        self.sock.sendall(tete + masque + masquee)

    def envoyer(self, texte: str) -> None:
        self._envoyer_trame(0x1, texte.encode("utf-8"))

    def recevoir(self) -> str:
        """Prochain message texte complet (fragments réassemblés, pings répondus)."""
        message = b""
        en_cours = False
        while True:
            b0, b1 = self._lire(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._lire(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._lire(8))[0]
            if n > TAILLE_MAX:
                raise ErreurSource(f"{NOM} : message WebSocket trop volumineux")
            masque = self._lire(4) if b1 & 0x80 else None
            charge = self._lire(n)
            if masque:
                charge = bytes(o ^ masque[i % 4] for i, o in enumerate(charge))
            if opcode == 0x8:
                raise ErreurSource(f"{NOM} : WebSocket fermé par le serveur")
            if opcode == 0x9:
                self._envoyer_trame(0xA, charge)  # pong
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                message, en_cours = charge, True
            elif opcode == 0x0 and en_cours:
                message += charge
            else:
                raise ErreurSource(f"{NOM} : trame WebSocket inattendue")
            if len(message) > TAILLE_MAX:
                raise ErreurSource(f"{NOM} : message WebSocket trop volumineux")
            if fin:
                try:
                    return message.decode("utf-8")
                except UnicodeDecodeError:
                    raise ErreurSource(f"{NOM} : message WebSocket illisible") from None

    def fermer(self) -> None:
        try:
            self._envoyer_trame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def _refus_constante(nom: str) -> object:
    raise ValueError("constante JSON non finie")  # Infinity, -Infinity, NaN


def _appel(ws: _WebSocket, ident: int, methode: str, params: list) -> object:
    ws.envoyer(json.dumps({"jsonrpc": "2.0", "id": ident, "method": methode, "params": params}))
    while True:
        try:
            rep = json.loads(ws.recevoir(), parse_constant=_refus_constante)
        except (ValueError, RecursionError):  # RecursionError : JSON imbriqué à l'extrême
            raise ErreurSource(f"{NOM} : réponse JSON-RPC invalide") from None
        if not isinstance(rep, dict) or rep.get("id") != ident:
            continue  # notification (collection_update…) ou autre réponse
        if "error" in rep:
            err = rep.get("error")
            code = err.get("code") if isinstance(err, dict) else None
            code = code if isinstance(code, int) and not isinstance(code, bool) else None
            # Le message d'erreur du serveur n'est pas recopié (il pourrait citer les paramètres).
            raise ErreurSource(f"{NOM} : {methode} a échoué (code {code})")
        return rep.get("result")


# --------------------------------------------------------------------------- SCRAM-SHA-512

def _b64(octets: bytes) -> str:
    return base64.b64encode(octets).decode("ascii")


def _derivation(secret: str, sel: bytes, iterations: int) -> tuple[bytes, bytes, bytes]:
    """``(ClientKey, StoredKey, ServerKey)`` de la RFC 5802 en SHA-512, mémorisés."""
    index = (hashlib.sha256(secret.encode("utf-8")).digest(), sel, iterations)
    with _verrou:
        trouve = _derivations.get(index)
    if trouve is not None:
        return trouve
    sale = hashlib.pbkdf2_hmac("sha512", secret.encode("utf-8"), sel, iterations)
    client = hmac.digest(sale, b"Client Key", "sha512")
    resultat = (client, hashlib.sha512(client).digest(), hmac.digest(sale, b"Server Key", "sha512"))
    with _verrou:
        if len(_derivations) >= 4:
            _derivations.clear()
        _derivations[index] = resultat
    return resultat


def _reponse_scram(rep: object, attendu: str) -> str:
    """``rfc_str`` d'une réponse de ``auth.login_ex`` ; refus du serveur -> statut 401."""
    if not isinstance(rep, dict):
        raise ErreurSource(f"{NOM} : réponse d'authentification inattendue")
    genre = rep.get("response_type")
    if genre in ("AUTH_ERR", "EXPIRED", "DENIED"):
        raise ErreurSource(f"{NOM} : clé API refusée ({genre})", 401)
    rfc = rep.get("rfc_str")
    if genre != "SCRAM_RESPONSE" or rep.get("scram_type") != attendu or not isinstance(rfc, str):
        raise ErreurSource(f"{NOM} : réponse d'authentification inattendue")
    return rfc


def _premier_serveur(rfc: str, nonce_client: bytes) -> tuple[bytes, bytes, int]:
    """``r=<nonce>,s=<sel>,i=<tours>`` vérifié : nonce prolongeant le nôtre, bornes du client officiel."""
    champs: dict[str, str] = {}
    for morceau in rfc.split(","):
        k, signe, v = morceau.partition("=")
        if not signe or not v or k in champs:
            raise ErreurSource(f"{NOM} : défi SCRAM invalide")
        champs[k] = v
    if set(champs) != {"r", "s", "i"}:
        raise ErreurSource(f"{NOM} : défi SCRAM invalide")
    try:
        nonce = base64.b64decode(champs["r"], validate=True)
        sel = base64.b64decode(champs["s"], validate=True)
        iterations = int(champs["i"])
    except ValueError:
        raise ErreurSource(f"{NOM} : défi SCRAM invalide") from None
    if not nonce.startswith(nonce_client) or not len(nonce_client) < len(nonce) <= 2 * TAILLE_NONCE:
        raise ErreurSource(f"{NOM} : défi SCRAM invalide (nonce)")
    if not 1 <= len(sel) <= SEL_MAX or not ITERATIONS_MIN <= iterations <= ITERATIONS_MAX:
        raise ErreurSource(f"{NOM} : défi SCRAM invalide (sel ou nombre de tours)")
    return nonce, sel, iterations


def _authentifier(ws: _WebSocket, utilisateur: str, cle: str, liaison: bytes | None) -> None:
    """Échange SCRAM complet ; lève ``ErreurSource`` (sans secret) si une étape échoue."""
    m = _CLE_VALIDE.fullmatch(cle.strip())
    if m is None:
        raise ErreurSource(f"{NOM} : clé API mal formée (attendu <id>-<secret>)")
    if not _UTILISATEUR_VALIDE.fullmatch(utilisateur):
        raise ErreurSource(f"{NOM} : nom d'utilisateur invalide")
    id_cle, secret = int(m.group(1)), m.group(2)

    nonce_client = os.urandom(TAILLE_NONCE)
    entete_gs2 = f"p={LIAISON},," if liaison is not None else "n,,"
    premier_nu = f"n={utilisateur}:{id_cle},r={_b64(nonce_client)}"
    premier_serveur = _reponse_scram(
        _appel(ws, 1, "auth.login_ex", [{"mechanism": "SCRAM", "scram_type": "CLIENT_FIRST_MESSAGE",
                                         "rfc_str": entete_gs2 + premier_nu}]),
        "SERVER_FIRST_RESPONSE")
    nonce, sel, iterations = _premier_serveur(premier_serveur, nonce_client)

    cle_client, cle_stockee, cle_serveur = _derivation(secret, sel, iterations)
    c = _b64(entete_gs2.encode("ascii") + (liaison or b""))
    final_sans_preuve = f"c={c},r={_b64(nonce)}"
    message_auth = f"{premier_nu},{premier_serveur},{final_sans_preuve}".encode("utf-8")
    signature_client = hmac.digest(cle_stockee, message_auth, "sha512")
    preuve = bytes(a ^ b for a, b in zip(cle_client, signature_client))
    final_serveur = _reponse_scram(
        _appel(ws, 2, "auth.login_ex", [{"mechanism": "SCRAM", "scram_type": "CLIENT_FINAL_MESSAGE",
                                         "rfc_str": f"{final_sans_preuve},p={_b64(preuve)}"}]),
        "SERVER_FINAL_RESPONSE")

    if not final_serveur.startswith("v=") or "," in final_serveur:
        raise ErreurSource(f"{NOM} : réponse d'authentification inattendue")
    try:
        signature = base64.b64decode(final_serveur[2:], validate=True)
    except ValueError:
        raise ErreurSource(f"{NOM} : réponse d'authentification inattendue") from None
    if not hmac.compare_digest(hmac.digest(cle_serveur, message_auth, "sha512"), signature):
        raise ErreurSource(f"{NOM} : le serveur n'a pas prouvé qu'il connaît la clé (signature SCRAM invalide)")


# --------------------------------------------------------------------------- lecture

def lire_websocket(url_ws: str, utilisateur: str, cle: str, ca: str | None = None, delai: float = 5) -> dict:
    """Authentification SCRAM puis ``pool.query`` sur ``url_ws`` (``wss://``, ou ``ws://`` local)."""
    try:
        ws = _WebSocket(url_ws, ca, delai)
    except ErreurSource:
        raise
    except (socket.timeout, TimeoutError):
        raise ErreurSource(f"{NOM} : délai dépassé") from None
    except ConnectionRefusedError:
        raise ErreurSource(f"{NOM} : connexion refusée") from None
    except ssl.SSLError:
        raise ErreurSource(f"{NOM} : certificat TLS refusé ou erreur TLS") from None
    except (OSError, ValueError):
        raise ErreurSource(f"{NOM} : erreur réseau") from None
    try:
        der = ws.certificat_der()
        if der is None and not _boucle_locale(ws.hote):
            raise ErreurSource(f"{NOM} : liaison de canal impossible sans TLS")
        _authentifier(ws, utilisateur, cle, liaison_canal(der) if der else None)
        resultat = _pools(_appel(ws, 3, "pool.query", [[], {"select": ["name", "status", "size", "allocated"]}]))
        pools = resultat["pools"]
        if pools:
            try:
                capacites = _capacites(_appel(ws, 4, "pool.dataset.query", [
                    [["id", "in", sorted(pools)]],
                    {"select": ["id", "used", "available"],
                     "extra": {"properties": ["used", "available"], "retrieve_children": False}}]))
            except (ErreurSource, OSError):  # délai, coupure : la taille brute plutôt que rien
                capacites = {}
            for nom, (alloue, taille) in capacites.items():
                if nom in pools:
                    pools[nom].update(taille=taille, alloue=alloue)
        return resultat
    except ErreurSource:
        raise
    except (socket.timeout, TimeoutError):
        raise ErreurSource(f"{NOM} : délai dépassé") from None
    except (OSError, ValueError):
        raise ErreurSource(f"{NOM} : erreur réseau") from None
    finally:
        ws.fermer()


def lire(cfg) -> dict:
    """``{"pools": {nom: {"taille": int, "alloue": int, "etat": str}}}`` (octets utilisables)."""
    base = cfg.truenas_url.strip().rstrip("/")
    try:
        d = urllib.parse.urlsplit(base)
        port = d.port
    except ValueError:
        raise ErreurSource(f"{NOM} : URL invalide") from None
    if d.scheme not in ("http", "https") or not d.hostname:
        raise ErreurSource(f"{NOM} : URL invalide (https:// attendu)")
    if d.scheme != "https" and not _boucle_locale(d.hostname):
        raise ErreurSource(f"{NOM} : HTTPS obligatoire hors de la machine locale")
    if not cfg.truenas_cle.strip():
        raise ErreurSource(f"{NOM} : clé API absente")
    hote = d.hostname if ":" not in d.hostname else f"[{d.hostname}]"
    netloc = hote if port is None else f"{hote}:{port}"  # jamais d'identifiants dans l'URL
    url_ws = urllib.parse.urlunsplit(("wss" if d.scheme == "https" else "ws", netloc, CHEMIN_WS, "", ""))
    return lire_websocket(url_ws, cfg.truenas_utilisateur.strip() or "abysse", cfg.truenas_cle,
                          ca=cfg.truenas_ca or None)
