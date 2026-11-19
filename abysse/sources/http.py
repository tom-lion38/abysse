"""Requêtes HTTP(S) JSON en lecture seule, bibliothèque standard uniquement.

- Vérification TLS **toujours** active. ``ca`` = chemin d'une CA à faire confiance (CA
  interne de Proxmox, certificat de TrueNAS) ; dans ce cas seulement ``check_hostname`` est
  désactivé, car ces services sont appelés par IP. Le certificat reste vérifié contre la CA.
- Aucune redirection suivie (elle emporterait l'en-tête d'authentification ailleurs) et
  aucun proxy d'environnement (``HTTP_PROXY``…) : les identifiants ne quittent pas la cible.
- Les messages d'erreur ne citent que le chemin de l'URL (ni identifiants, ni requête,
  ni en-têtes, ni corps de réponse) : rien de secret ne peut s'y glisser.
"""

from __future__ import annotations

import http.client  # bibliothèque standard (import absolu : pas ce module)
import json
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from . import ErreurSource

# Taille maximale acceptée pour une réponse (les plus grosses, /cluster/resources ou un
# CSV InfluxDB, font quelques dizaines de Kio).
TAILLE_MAX = 16 * 1024 * 1024


class _SansRedirection(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - API urllib
        return None  # urllib lève alors HTTPError avec le code 3xx


def contexte_tls(ca: str | None) -> ssl.SSLContext:
    """Contexte TLS vérifiant le certificat (contre ``ca`` si fourni, sinon les CA du système)."""
    if ca:
        try:
            ctx = ssl.create_default_context(cafile=ca)
        except (OSError, ssl.SSLError):
            raise ErreurSource("certificat d'autorité (CA) illisible") from None
        ctx.check_hostname = False  # appel par IP ; le certificat reste vérifié (CERT_REQUIRED)
        # Python 3.13 active VERIFY_X509_STRICT : la CA interne de Proxmox (sans extension
        # keyUsage) serait refusée. On garde la vérification de la chaîne, sans ce mode strict.
        ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    else:
        ctx = ssl.create_default_context()
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def chemin_affichable(url: str) -> str:
    """Chemin seul de l'URL (sans identifiants, hôte ni requête), pour les messages d'erreur."""
    try:
        return urllib.parse.urlsplit(url).path or "/"
    except ValueError:
        return "?"


def _raison_reseau(e: BaseException) -> str:
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "délai dépassé"
    if isinstance(e, ConnectionRefusedError):
        return "connexion refusée"
    if isinstance(e, ssl.SSLCertVerificationError):
        return "certificat TLS refusé"
    if isinstance(e, ssl.SSLError):
        return "erreur TLS"
    if isinstance(e, socket.gaierror):
        return "nom d'hôte introuvable"
    if isinstance(e, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return "connexion coupée"
    if isinstance(e, urllib.error.URLError) and isinstance(e.reason, BaseException):
        return _raison_reseau(e.reason)
    return "erreur réseau"


def requete(
    url: str,
    entetes: dict,
    ca: str | None = None,
    delai: float = 5,
    methode: str = "GET",
    corps: bytes | None = None,
) -> bytes:
    """Effectue la requête et renvoie le corps brut de la réponse (statut 2xx seulement).

    ``delai`` borne chaque opération réseau ; la lecture du corps entier est en plus bornée
    à ``3 × delai``. Lève ``ErreurSource`` (``statut`` = code HTTP s'il y en a un).
    """
    chemin = chemin_affichable(url)
    try:
        decoupe = urllib.parse.urlsplit(url)
    except ValueError:
        raise ErreurSource("URL invalide") from None
    if decoupe.scheme not in ("http", "https") or not decoupe.hostname:
        raise ErreurSource("URL invalide (http:// ou https:// attendu)")
    if decoupe.username is not None or decoupe.password is not None:
        # Les identifiants passent par les en-têtes, jamais par l'URL.
        url = urllib.parse.urlunsplit(decoupe._replace(netloc=decoupe.netloc.rsplit("@", 1)[1]))

    gestionnaires = [urllib.request.ProxyHandler({}), _SansRedirection()]
    if decoupe.scheme == "https":
        gestionnaires.append(urllib.request.HTTPSHandler(context=contexte_tls(ca)))
    ouvreur = urllib.request.build_opener(*gestionnaires)
    req = urllib.request.Request(url, data=corps, headers=dict(entetes), method=methode)

    debut = time.monotonic()
    try:
        with ouvreur.open(req, timeout=delai) as rep:
            morceaux = []
            taille = 0
            while True:
                morceau = rep.read(65536)
                if not morceau:
                    break
                taille += len(morceau)
                if taille > TAILLE_MAX:
                    raise ErreurSource(f"réponse trop volumineuse sur {chemin}")
                if time.monotonic() - debut > 3 * delai:
                    raise ErreurSource(f"délai dépassé sur {chemin}")
                morceaux.append(morceau)
            return b"".join(morceaux)
    except ErreurSource:
        raise
    except urllib.error.HTTPError as e:
        code = e.code
        e.close()
        raise ErreurSource(f"HTTP {code} sur {chemin}", code) from None
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
        raise ErreurSource(f"{_raison_reseau(e)} sur {chemin}") from None


def requete_json(
    url: str,
    entetes: dict,
    ca: str | None = None,
    delai: float = 5,
    methode: str = "GET",
    corps: bytes | None = None,
) -> object:
    """Comme ``requete`` mais décode la réponse en JSON (``ErreurSource`` si illisible)."""
    brut = requete(url, entetes, ca=ca, delai=delai, methode=methode, corps=corps)
    try:
        return json.loads(brut.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ErreurSource(f"réponse JSON invalide sur {chemin_affichable(url)}") from None
