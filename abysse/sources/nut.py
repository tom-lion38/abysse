"""Client NUT (upsd) minimal : protocole texte TCP, sans compte, lecture seule.

``LIST VAR <ups>`` → ``BEGIN LIST VAR <ups>``, lignes ``VAR <ups> <nom> "<valeur>"``,
``END LIST VAR <ups>`` ; une erreur répond ``ERR <code>``.
"""

from __future__ import annotations

import socket
import time

from . import ErreurSource

NOM = "NUT"
TAILLE_MAX = 1024 * 1024


def _valeur(texte: str) -> str:
    """Retire les guillemets et les échappements ``\\"`` / ``\\\\`` d'une valeur NUT."""
    t = texte.strip()
    if len(t) >= 2 and t[0] == '"' and t[-1] == '"':
        t = t[1:-1]
    sortie = []
    i = 0
    while i < len(t):
        c = t[i]
        if c == "\\" and i + 1 < len(t):
            i += 1
            c = t[i]
        sortie.append(c)
        i += 1
    return "".join(sortie)


def lire(hote: str, port: int, ups: str, delai: float = 3) -> dict[str, str]:
    """Toutes les variables de l'onduleur ``ups`` : ``{"battery.charge": "100", ...}``.

    ``delai`` borne la connexion et chaque lecture ; l'échange complet est borné à ``2 × delai``.
    """
    if not ups or any(c.isspace() for c in ups) or '"' in ups:
        raise ErreurSource(f"{NOM} : nom d'onduleur invalide")
    debut = time.monotonic()
    fin_attendue = f"END LIST VAR {ups}"
    try:
        with socket.create_connection((hote, int(port)), timeout=delai) as s:
            s.sendall(f"LIST VAR {ups}\n".encode("utf-8"))
            tampon = b""
            valeurs: dict[str, str] = {}
            commence = False
            while True:
                while b"\n" not in tampon:
                    if time.monotonic() - debut > 2 * delai:
                        raise ErreurSource(f"{NOM} : délai dépassé")
                    morceau = s.recv(65536)
                    if not morceau:
                        raise ErreurSource(f"{NOM} : connexion fermée par le serveur")
                    tampon += morceau
                    if len(tampon) > TAILLE_MAX:
                        raise ErreurSource(f"{NOM} : réponse trop volumineuse")
                brute, tampon = tampon.split(b"\n", 1)
                ligne = brute.decode("utf-8", "replace").rstrip("\r")
                if ligne.startswith("ERR "):
                    code = ligne[4:].strip().split(" ")[0]
                    raise ErreurSource(f"{NOM} : erreur {code}")
                if ligne == f"BEGIN LIST VAR {ups}":
                    commence = True
                elif ligne == fin_attendue:
                    break
                elif commence and ligne.startswith(f"VAR {ups} "):
                    reste = ligne[len(f"VAR {ups} "):]
                    nom, _, valeur = reste.partition(" ")
                    if nom:
                        valeurs[nom] = _valeur(valeur)
            try:
                s.sendall(b"LOGOUT\n")
            except OSError:
                pass
            return valeurs
    except ErreurSource:
        raise
    except (socket.timeout, TimeoutError):
        raise ErreurSource(f"{NOM} : délai dépassé") from None
    except ConnectionRefusedError:
        raise ErreurSource(f"{NOM} : connexion refusée") from None
    except OSError:
        raise ErreurSource(f"{NOM} : erreur réseau") from None
