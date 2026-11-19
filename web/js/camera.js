// Caméra 3D « table inclinée » reprise de docs/prototypes/proto-4-hologramme.html :
// le graphe est posé sur un plan (x, y) avec une hauteur z ; yaw = rotation autour de la verticale,
// pitch = inclinaison (0,5 ≈ vue rasante, 1,45 ≈ vue de dessus), k = zoom, (tx, ty) = point visé.

export const PITCH_MIN = 0.5;
export const PITCH_MAX = 1.45;
export const K_MIN = 0.06;
export const K_MAX = 5;
export const YAW_DEFAUT = 0.3;
export const PITCH_DEFAUT = 0.94;

const TAU = Math.PI * 2;
const PROFONDEUR_MIN = 240;
const borne = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const adoucir = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fini = (v) => typeof v === "number" && Number.isFinite(v);

export class Camera {
  constructor({ largeur = 800, hauteur = 600 } = {}) {
    this.yaw = YAW_DEFAUT;
    this.pitch = PITCH_DEFAUT;
    this.k = 0.6;
    this.tx = 0;
    this.ty = 0;
    /** Distance de l'œil au plan (perspective). */
    this.D = 2600;
    /** Décalage du centre de projection en pixels (ex. quand un panneau s'ouvre). */
    this.decalX = 0;
    this.decalY = 0;
    this.largeur = largeur;
    this.hauteur = hauteur;
    this._anim = null;
  }

  redimensionner(largeur, hauteur) {
    this.largeur = largeur;
    this.hauteur = hauteur;
  }

  get enMouvement() {
    return this._anim !== null;
  }

  /** Monde (x, y au sol, z hauteur) → écran {sx, sy, s (échelle), p (profondeur)}. `o` évite une allocation. */
  projeter(x, y, z = 0, o = { sx: 0, sy: 0, s: 0, p: 0 }) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dx = x - this.tx, dy = y - this.ty;
    const xr = dx * cy + dy * sy, yr = -dx * sy + dy * cy;
    let p = this.D + yr * cp - z * sp;
    if (p < PROFONDEUR_MIN) p = PROFONDEUR_MIN;
    const s = (this.k * this.D) / p;
    o.sx = this.largeur / 2 + this.decalX + xr * s;
    o.sy = this.hauteur / 2 + this.decalY - (yr * sp + z * cp) * s;
    o.s = s;
    o.p = p;
    return o;
  }

  /** Écran → point du sol (z = 0). */
  deprojeter(sx, sy) {
    const cy = Math.cos(this.yaw), syw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const F = this.k * this.D;
    const u = (sx - this.largeur / 2 - this.decalX) / F;
    const v = -(sy - this.hauteur / 2 - this.decalY) / F;
    let den = sp - v * cp;
    if (den < 0.05) den = 0.05; // au-dessus de l'horizon : on borne au lieu de diverger
    const yr = (v * this.D) / den;
    const xr = u * (this.D + yr * cp);
    return { x: xr * cy - yr * syw + this.tx, y: xr * syw + yr * cy + this.ty };
  }

  /** Clic droit glissé : dx → rotation, dy → inclinaison (bornée). */
  tourner(dx, dy) {
    this._anim = null;
    this.yaw += (fini(dx) ? dx : 0) * 0.006;
    this.pitch = borne(this.pitch - (fini(dy) ? dy : 0) * 0.004, PITCH_MIN, PITCH_MAX);
  }

  /** Zoom d'un facteur en gardant immobile le point du sol sous (sx, sy). */
  zoomer(facteur, sx, sy) {
    if (!fini(facteur) || facteur <= 0) return;
    this._anim = null;
    const avant = this.deprojeter(sx, sy);
    this.k = borne(this.k * facteur, K_MIN, K_MAX);
    const apres = this.deprojeter(sx, sy);
    this.tx += avant.x - apres.x;
    this.ty += avant.y - apres.y;
  }

  /** Glisser la vue de (dx, dy) pixels : le point du sol sous le curseur suit la souris. */
  deplacer(sx0, sy0, sx1, sy1) {
    this._anim = null;
    const a = this.deprojeter(sx0, sy0), b = this.deprojeter(sx1, sy1);
    this.tx += a.x - b.x;
    this.ty += a.y - b.y;
  }

  /** Anime vers `cible` ({tx, ty, k, yaw, pitch}, champs facultatifs) en `duree` secondes, yaw par le plus court chemin. */
  viser(cible = {}, duree = 1) {
    const depart = { tx: this.tx, ty: this.ty, k: this.k, yaw: this.yaw, pitch: this.pitch };
    const arrivee = { ...depart };
    for (const c of ["tx", "ty", "k", "yaw", "pitch"]) if (fini(cible[c])) arrivee[c] = cible[c];
    arrivee.k = borne(arrivee.k, K_MIN, K_MAX);
    arrivee.pitch = borne(arrivee.pitch, PITCH_MIN, PITCH_MAX);
    const d = arrivee.yaw - depart.yaw;
    arrivee.yaw = depart.yaw + ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    if (!fini(duree) || duree <= 0) {
      Object.assign(this, arrivee);
      this._anim = null;
      return;
    }
    this._anim = { depart, arrivee, t: 0, duree };
  }

  /** Avance l'animation de `dt` secondes (à appeler à chaque image). */
  avancer(dt) {
    const a = this._anim;
    if (!a) return;
    a.t += fini(dt) && dt > 0 ? dt : 0;
    if (a.t >= a.duree) {
      Object.assign(this, a.arrivee);
      this._anim = null;
      return;
    }
    const e = adoucir(a.t / a.duree);
    for (const c of ["tx", "ty", "k", "yaw", "pitch"]) this[c] = lerp(a.depart[c], a.arrivee[c], e);
  }

  /** Arrête toute animation en cours. */
  figer() {
    this._anim = null;
  }

  /**
   * Cadrage qui fait tenir des points {x, y} à l'écran (marge en pixels), à passer à `viser`.
   * Approximation à plat (sans perspective), suffisante pour un recentrage.
   */
  cadrage(points, marge = 80) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) {
      if (!p || !fini(p.x) || !fini(p.y)) continue;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (x0 === Infinity) return { tx: 0, ty: 0, k: 0.6 };
    const rayon = Math.max(60, Math.hypot(x1 - x0, y1 - y0) / 2);
    const utile = Math.max(100, Math.min(this.largeur, this.hauteur) - 2 * marge);
    return { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, k: borne(utile / (2 * rayon), K_MIN, K_MAX) };
  }
}
