"""Sites servis par Caddy, détectés depuis le Caddyfile du Caddy public (CT en marche en 192.168.10.17).

``analyser_caddyfile`` lit le texte du Caddyfile et renvoie un site par nom :
``{"nom", "url", "amont_ip", "amont_port"}``. L'installation l'exécute une fois
(``python -m abysse.sites <Caddyfile>`` → ``sites.json``) ; le mode « modifier » complète.

Règles :

- les snippets ``(xxx) { … }`` et le bloc d'options globales ``{ … }`` sont ignorés ;
- ``a, b {`` (ou ``a b {``) donne deux sites ; un schéma ``https://`` ou ``http://`` devant
  l'adresse est retiré du nom ; ``url = "https://" + nom`` ;
- l'amont est le premier ``reverse_proxy`` du bloc qui s'applique à tout le site (ni matcher
  ``@x`` / ``/chemin`` sur la directive, ni dans un ``handle /chemin``) ; à défaut le premier
  ``reverse_proxy`` du bloc ; aucun → ``amont_ip`` et ``amont_port`` à ``None`` ;
- l'amont tolère un schéma (``https://192.168.10.97:8006``) ; port par défaut 443 en https, 80 sinon ;
- les accolades n'ouvrent ou ne ferment un bloc que seules (``{remote_host}`` ou ``"{ }"``
  entre guillemets ne comptent pas) ; ``#`` en début de mot commence un commentaire.
"""

from __future__ import annotations

import json
import sys

from . import inventaire

_SCHEMAS = ("https://", "http://", "h2c://")
# Directives dont le bloc ne s'applique qu'à une partie des requêtes, même sans matcher.
_TOUJOURS_CONDITIONNELLES = {"handle_errors"}


def _mots(ligne: str) -> list[str]:
    """Découpe une ligne en mots (guillemets ``"…"`` et accents graves respectés, commentaires retirés)."""
    mots: list[str] = []
    i, n = 0, len(ligne)
    while i < n:
        c = ligne[i]
        if c.isspace():
            i += 1
            continue
        if c == "#":
            break  # commentaire jusqu'à la fin de la ligne
        mot = []
        while i < n and not ligne[i].isspace():
            c = ligne[i]
            if c in "\"`":
                fin = c
                mot.append(c)
                i += 1
                while i < n and ligne[i] != fin:
                    if ligne[i] == "\\" and fin == '"' and i + 1 < n:
                        mot.append(ligne[i])
                        i += 1
                    mot.append(ligne[i])
                    i += 1
                if i < n:
                    mot.append(ligne[i])
                    i += 1
                continue
            mot.append(c)
            i += 1
        mots.append("".join(mot))
    return mots


def _est_matcher(mot: str) -> bool:
    return mot.startswith(("@", "/", "*"))


def _amont(adresse: str) -> tuple[str | None, int | None]:
    """``https://192.168.10.97:8006`` → ``("192.168.10.97", 8006)`` ; ``192.168.10.177`` → ``("192.168.10.177", 80)``."""
    a = adresse.strip()
    port_defaut = 80
    for schema in _SCHEMAS:
        if a.lower().startswith(schema):
            a = a[len(schema):]
            port_defaut = 443 if schema == "https://" else 80
            break
    a = a.split("/", 1)[0]
    if not a:
        return None, None
    if a.startswith("["):  # IPv6 : [fd00::1]:8443
        fin = a.find("]")
        if fin < 0:
            return None, None
        hote, reste = a[1:fin], a[fin + 1:]
        port_txt = reste[1:] if reste.startswith(":") else ""
    elif a.count(":") == 1:
        hote, port_txt = a.split(":", 1)
    else:
        hote, port_txt = a, ""
    if not hote:
        return None, None
    if port_txt:
        if not port_txt.isdigit() or not 0 < int(port_txt) < 65536:
            return hote, None
        return hote, int(port_txt)
    return hote, port_defaut


def _noms_de_site(mots: list[str]) -> list[str]:
    noms = []
    for morceau in " ".join(mots).replace(",", " ").split():
        nom = morceau
        for schema in _SCHEMAS:
            if nom.lower().startswith(schema):
                nom = nom[len(schema):]
                break
        nom = nom.rstrip("/")
        # « :8080 » (port seul), jokers et espaces réservés ne sont pas des sites ouvrables
        if not nom or nom.startswith(":") or "*" in nom or "{" in nom or '"' in nom:
            continue
        noms.append(nom)
    return noms


def analyser_caddyfile(texte: str) -> list[dict]:
    """Un site par nom déclaré dans le Caddyfile (voir les règles du module)."""
    resultat: list[dict] = []
    vus: set[str] = set()
    # pile de blocs : (genre, conditionnel) ; genre ∈ site, snippet, global, sous
    pile: list[tuple[str, bool]] = []
    site_noms: list[str] = []
    amonts: list[tuple[bool, str]] = []  # (conditionnel, adresse)

    def dans_site() -> bool:
        return bool(pile) and pile[0][0] == "site"

    def directive(mots: list[str]) -> None:
        if not mots or not dans_site() or mots[0] != "reverse_proxy":
            return
        args = mots[1:]
        conditionnel = any(c for _, c in pile[1:])
        if args and _est_matcher(args[0]):
            conditionnel = True
            args = args[1:]
        if args:
            amonts.append((conditionnel, args[0]))

    def ouvrir(mots: list[str]) -> None:
        nonlocal site_noms, amonts
        if not pile:
            if not mots:
                pile.append(("global", False))
            elif mots[0].startswith("("):
                pile.append(("snippet", False))
            else:
                pile.append(("site", False))
                site_noms, amonts = _noms_de_site(mots), []
            return
        directive(mots)
        conditionnel = bool(mots) and (
            mots[0] in _TOUJOURS_CONDITIONNELLES
            or mots[0].startswith("@")  # définition d'un matcher nommé
            or (len(mots) > 1 and _est_matcher(mots[1]))
        )
        pile.append(("sous", conditionnel))

    def fermer() -> None:
        if not pile:
            return  # accolade fermante orpheline : ignorée
        genre, _ = pile.pop()
        if pile or genre != "site":
            return
        choix = next((a for c, a in amonts if not c), None) or next((a for _, a in amonts), None)
        ip, port = _amont(choix) if choix else (None, None)
        for nom in site_noms:
            if nom in vus:
                continue
            vus.add(nom)
            resultat.append({"nom": nom, "url": "https://" + nom, "amont_ip": ip, "amont_port": port})

    for ligne in (texte or "").splitlines():
        mots: list[str] = []
        for mot in _mots(ligne):
            if mot == "{":
                ouvrir(mots)
                mots = []
            elif mot == "}":
                directive(mots)
                fermer()
                mots = []
            else:
                mots.append(mot)
        directive(mots)
    return resultat


def parent_du_site(site: dict, ip_vers_id: dict[str, str]) -> str | None:
    """Nœud parent d'un site : le CT/VM de son IP amont, sinon l'équipement de cette IP."""
    ip = site.get("amont_ip") if isinstance(site, dict) else None
    if not isinstance(ip, str) or not ip:
        return None
    if ip in ip_vers_id:
        return ip_vers_id[ip]
    for id_, e in inventaire.EQUIPEMENTS.items():
        if e.get("ip") == ip:
            return id_
    return None


def charger_sites(chemin: str) -> list[dict]:
    """Lit ``sites.json`` ; fichier absent ou illisible → liste vide (jamais d'exception)."""
    try:
        with open(chemin, encoding="utf-8") as f:
            donnees = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(donnees, list):
        return []
    return [s for s in donnees if isinstance(s, dict) and isinstance(s.get("nom"), str)]


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage : python -m abysse.sites <Caddyfile>", file=sys.stderr)
        return 2
    try:
        with open(argv[0], encoding="utf-8") as f:
            texte = f.read()
    except OSError as e:
        print(f"Caddyfile illisible : {e.strerror}", file=sys.stderr)
        return 1
    sortie = json.dumps(analyser_caddyfile(texte), ensure_ascii=False, indent=2) + "\n"
    sys.stdout.buffer.write(sortie.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
