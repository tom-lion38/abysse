// Placement des étiquettes de la carte, sans chevauchement (fonction pure, testée sous Node).
//
//   const placeur = new Placeur();
//   const res = placeur.placer(demandes, obstacles, zone);   // à chaque image
//
// demande  = {id, x, y, r (rayon du nœud à l'écran), priorite, variantes: [{w, h}, …] (de la plus riche
//             à la plus courte), prefere: angle (rad) ou null}
// obstacle = {id, x, y, r} : disque d'un nœud que les étiquettes des autres ne doivent pas couvrir
// zone     = {x0, y0, x1, y1} : rectangle utile (entre la barre du haut et la frise)
// résultat = {id, visible, x0, y0, x1, y1, aligne: "left" | "center" | "right", variante, cote}
//
// Les demandes sont traitées par priorité décroissante (glouton) ; chacune essaie ses variantes, de la plus
// riche à la plus courte, et pour chacune ses côtés (côté préféré d'abord, puis dessous, dessus, droite,
// gauche, diagonales). La place de l'image précédente est essayée en premier et sans marge : une étiquette
// ne saute pas d'un côté à l'autre tant que sa place reste libre (pas de scintillement).

export const ECART = 4;
const MARGE = 2;
const R2 = Math.SQRT2;

const COTES = [
  ["dessous", Math.PI / 2], ["dessus", -Math.PI / 2], ["droite", 0], ["gauche", Math.PI],
  ["dessous-droite", Math.PI / 4], ["dessous-gauche", (3 * Math.PI) / 4],
  ["dessus-droite", -Math.PI / 4], ["dessus-gauche", (-3 * Math.PI) / 4],
];
const ANGLE = new Map(COTES);

const signe = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Boîte d'une étiquette posée contre le nœud dans la direction `angle` (rad, écran : 0 = droite,
 * π/2 = dessous) : {x0, y0, x1, y1, aligne}.
 */
export function boite(d, v, angle, ecart = ECART) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const px = d.x + c * (d.r + ecart), py = d.y + s * (d.r + ecart);
  const fx = signe(c) * Math.min(1, Math.abs(c) * R2), fy = signe(s) * Math.min(1, Math.abs(s) * R2);
  const x0 = px - v.w / 2 + (fx * v.w) / 2, y0 = py - v.h / 2 + (fy * v.h) / 2;
  return { x0, y0, x1: x0 + v.w, y1: y0 + v.h, aligne: c > 0.38 ? "left" : c < -0.38 ? "right" : "center" };
}

function dansZone(b, z, m) {
  return b.x0 >= z.x0 + m && b.y0 >= z.y0 + m && b.x1 <= z.x1 - m && b.y1 <= z.y1 - m;
}

function coupeBoites(b, places, m) {
  for (let i = 0; i < places.length; i++) {
    const o = places[i];
    if (b.x0 - m < o.x1 && b.x1 + m > o.x0 && b.y0 - m < o.y1 && b.y1 + m > o.y0) return true;
  }
  return false;
}

function coupeDisques(b, obstacles, id, m) {
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.id === id) continue;
    const px = o.x < b.x0 ? b.x0 : o.x > b.x1 ? b.x1 : o.x;
    const py = o.y < b.y0 ? b.y0 : o.y > b.y1 ? b.y1 : o.y;
    const dx = px - o.x, dy = py - o.y, r = o.r + m;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

export class Placeur {
  constructor() {
    /** id → [variante, côté, angle] retenus à l'image précédente. */
    this._avant = new Map();
  }

  /** Oublie les places mémorisées (changement de vue, par exemple). */
  oublier() {
    this._avant.clear();
  }

  /**
   * `reserves` : rectangles {x0, y0, x1, y1} où aucune étiquette ne doit aller (légende, panneau ouvert…),
   * traités comme des étiquettes déjà posées.
   */
  placer(demandes, obstacles = [], zone = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }, reserves = []) {
    const ordre = demandes.map((_, i) => i).sort((a, b) => {
      const da = demandes[a], db = demandes[b];
      return (db.priorite - da.priorite) || (da.id < db.id ? -1 : da.id > db.id ? 1 : 0);
    });
    const places = reserves.filter((r) => r && r.x1 > r.x0 && r.y1 > r.y0);
    const res = new Array(demandes.length);
    const nouveau = new Map();
    for (const i of ordre) {
      const d = demandes[i];
      const avant = this._avant.get(d.id);
      let trouve = null;
      const essayer = (vi, cote, angle, m) => {
        const v = d.variantes[vi];
        if (!v) return false;
        const b = boite(d, v, angle);
        if (!dansZone(b, zone, 0) || coupeBoites(b, places, m) || coupeDisques(b, obstacles, d.id, m)) return false;
        trouve = { id: d.id, visible: true, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, aligne: b.aligne, variante: vi, cote, angle };
        return true;
      };
      for (let vi = 0; vi < d.variantes.length && !trouve; vi++) {
        // la place précédente d'abord, sans marge ; une place meilleure doit être libre avec une marge
        if (avant && avant[0] === vi && essayer(vi, avant[1], avant[2], 0)) break;
        if (avant && avant[0] < vi) {
          // on avait mieux à l'image précédente : la même place, en plus court, avant tout le reste
          if (essayer(vi, avant[1], avant[2], 0)) break;
        }
        if (typeof d.prefere === "number" && Number.isFinite(d.prefere) && essayer(vi, "radial", d.prefere, MARGE)) break;
        for (const [nom, angle] of COTES) if (essayer(vi, nom, angle, MARGE)) break;
      }
      if (trouve) {
        places.push(trouve);
        nouveau.set(d.id, [trouve.variante, trouve.cote, trouve.angle]);
        const { angle, ...sans } = trouve;
        res[i] = sans;
      } else {
        res[i] = { id: d.id, visible: false };
      }
    }
    this._avant = nouveau;
    return res;
  }
}

export { ANGLE as ANGLES_COTES };
