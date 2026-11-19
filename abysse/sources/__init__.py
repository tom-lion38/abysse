"""Sources de données d'Abysse (lecture seule) : MikroTik, Proxmox, NUT, InfluxDB, TrueNAS.

Chaque fonction de lecture lève ``ErreurSource`` en cas d'échec. Le message d'une
``ErreurSource`` ne contient **jamais** de secret (jeton, mot de passe, clé, en-tête
d'authentification) : il peut être journalisé tel quel.
"""

from __future__ import annotations


class ErreurSource(Exception):
    """Échec de lecture d'une source.

    ``statut`` : code HTTP quand le serveur a répondu (401, 404, 500…), ``None`` pour une
    erreur réseau (délai dépassé, connexion refusée, TLS) ou une réponse illisible.
    """

    def __init__(self, message: str, statut: int | None = None) -> None:
        super().__init__(message)
        self.statut = statut

    def prefixee(self, prefixe: str) -> "ErreurSource":
        """Même erreur, message préfixé par le nom de la source (« MikroTik : … »)."""
        return ErreurSource(f"{prefixe} : {self}", self.statut)


__all__ = ["ErreurSource"]
