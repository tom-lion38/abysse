"""Débit par différence de compteurs d'octets (interfaces MikroTik, invités Proxmox)."""

from __future__ import annotations

# Au-delà, l'écart ne peut pas être du trafic réel (le homelab plafonne à 10 Gbit/s) :
# compteur remplacé, interface recréée… on ignore l'échantillon.
DEBIT_MAX = 100e9  # bits/s


def _en_entier(octets: object) -> int | None:
    if isinstance(octets, bool):
        return None
    if isinstance(octets, int):
        n = octets
    elif isinstance(octets, float):
        if octets != octets or octets in (float("inf"), float("-inf")):
            return None
        n = int(octets)
    elif isinstance(octets, str):
        try:
            n = int(octets.strip())
        except ValueError:
            return None
    else:
        return None
    return n if n >= 0 else None


class CompteurDebit:
    """Garde le dernier échantillon de chaque compteur et en déduit un débit en bits/s.

    ``maj`` renvoie ``None`` quand le débit n'est pas calculable : premier échantillon,
    intervalle nul ou négatif, compteur qui recule (redémarrage, interface recréée),
    valeur illisible ou pic impossible. Le débit n'est donc jamais négatif.
    """

    def __init__(self) -> None:
        self._derniers: dict[str, tuple[int, float]] = {}

    def maj(self, cle: str, octets: int | str, t: float) -> float | None:
        n = _en_entier(octets)
        if n is None:
            return None  # valeur illisible : on garde la référence précédente
        avant = self._derniers.get(cle)
        if avant is None:
            self._derniers[cle] = (n, t)
            return None
        n0, t0 = avant
        dt = t - t0
        if dt == 0:
            return None  # même instant : pas de débit
        self._derniers[cle] = (n, t)
        if dt < 0:
            return None  # horloge qui recule : nouvelle base, sinon plus aucun débit d'ici t0
        if n < n0:
            return None  # compteur reparti de zéro : nouvelle base
        bps = (n - n0) * 8 / dt
        if bps > DEBIT_MAX:
            return None
        return float(bps)

    def oublier(self, cle: str) -> None:
        """Retire un compteur (appareil parti) pour que la table ne grossisse pas."""
        self._derniers.pop(cle, None)
