// Couleurs de la carte : une teinte par groupe, les enfants dans la teinte du parent en plus clair.
// Le rouge est réservé aux pannes réelles.

export const GROUPES = Object.freeze({
  mikrotik: "#7fe7ff",
  internet: "#ff9a3c",
  pve: "#a37bff",
  pbs: "#4fe39a",
  synology: "#4f8dff",
  truenas: "#2fe0c8",
  onduleur: "#ffc94a",
  ha: "#6cc8ff",
  reseau: "#9aa7b5",
  appareils: "#ff7ad9",
});

export const ROUGE = "#ff3b4e";
export const GRIS_ETEINT = "#4a5563";
export const INCONNU = "#5b7a99";
/** Teinte d'un groupe que la carte ne connaît pas (jamais rouge). */
export const REPLI = "#8fa8c8";

const PAS_PROFONDEUR = 0.18;
const ECLAIRCI_MAX = 0.6;

const borne = (v, a, b) => (v < a ? a : v > b ? b : v);

/** "#rrggbb" (ou "#rgb") → {r, g, b} entiers 0-255. Valeur illisible → teinte de repli. */
export function versRgb(hex) {
  let h = typeof hex === "string" ? hex.trim().replace(/^#/, "") : "";
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(h)) return versRgb(REPLI);
  const v = parseInt(h, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/** {r, g, b} → "#rrggbb" en minuscules. */
export function versHex({ r, g, b }) {
  const c = (v) => borne(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mélange vers le blanc : t = 0 ne change rien, t = 1 donne du blanc (t borné à [0, 1]). */
export function eclaircir(hex, t) {
  const k = borne(Number.isFinite(t) ? t : 0, 0, 1);
  const { r, g, b } = versRgb(hex);
  return versHex({ r: r + (255 - r) * k, g: g + (255 - g) * k, b: b + (255 - b) * k });
}

/** Couleur d'un nœud selon son groupe : +0,18 de blanc par niveau sous la racine du groupe, au plus 0,6. */
export function couleurNoeud(noeud, profondeurDansGroupe = 0) {
  const base = (noeud && Object.hasOwn(GROUPES, noeud.groupe)) ? GROUPES[noeud.groupe] : REPLI;
  const p = Number.isFinite(profondeurDansGroupe) ? Math.max(0, profondeurDansGroupe) : 0;
  return versRgb(eclaircir(base, Math.min(ECLAIRCI_MAX, PAS_PROFONDEUR * p)));
}

/** Couleur à afficher selon l'état : rouge si `off`, gris si `eteint`, bleu-gris si `inconnu`, sinon celle du groupe. */
export function couleurEtat(noeud, profondeurDansGroupe = 0) {
  switch (noeud && noeud.etat) {
    case "off": return versRgb(ROUGE);
    case "eteint": return versRgb(GRIS_ETEINT);
    case "inconnu": return versRgb(INCONNU);
    default: return couleurNoeud(noeud, profondeurDansGroupe);
  }
}

/** "rgba(r,g,b,a)" pour le Canvas 2D. */
export function rgba({ r, g, b }, a = 1) {
  return `rgba(${r},${g},${b},${borne(a, 0, 1)})`;
}

/* ------------------------------------------------------------------ palette de rendu */

const versBlanc = (c, t) => [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];
const versNoir = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/**
 * Teintes de rendu d'un nœud (et de l'axone qui le relie à son parent) à partir de sa couleur de base
 * [r, g, b] : uniquement des mélanges vers le blanc ou le noir, la teinte du groupe reste donc nette
 * (pas de glissement vers le bleu). Tableaux [r, g, b] (flottants 0-255).
 */
export function palette(base) {
  const c = [borne(base[0], 0, 255), borne(base[1], 0, 255), borne(base[2], 0, 255)];
  return {
    soma: versBlanc(c, 0.5),         // corps lumineux du neurone
    halo: c,                         // lueur, couleur pure du groupe
    anneau: versBlanc(c, 0.3),       // jauges et décorations
    dendrite: versNoir(c, 0.82),     // dendrites, un ton plus sombre
    axone: versNoir(c, 0.9),         // gaine lumineuse de l'axone
    coeurAxone: versBlanc(c, 0.3),   // fil central de l'axone
    descendant: versBlanc(c, 0.55),  // influx vers l'enfant : pâle
    montant: c,                      // influx vers le parent : saturé
    nom: versBlanc(c, 0.72),         // étiquette : blanc teinté du groupe
  };
}
