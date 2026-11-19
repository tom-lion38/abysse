// Influx de débit : des impulsions lumineuses circulent dans chaque axone, dans le sens du trafic.
// Deux voies par lien : `descendant` (de `de` vers `vers`) et `montant` (l'inverse), chacune dans sa teinte.
// Nombre et vitesse suivent le débit réel sur une échelle logarithmique (1 Mbit/s = 30 /s, 1 Gbit/s = 60 /s).
//
// Mémoire : un réservoir de taille fixe (TAILLE_POOL) en tableaux typés ; en régime établi, `maj` et
// `dessiner` n'allouent rien (les seules allocations ont lieu quand un lien apparaît pour la première fois).
//
// Le rendu (rendu.js) fournit la géométrie projetée de chaque axone via `influx.geometrie = (idLien) => geo`
//   geo = { n, px: Float32Array(n + 1), py: Float32Array(n + 1), s (échelle écran), alpha (0-1),
//           cDesc: [r, g, b], cMont: [r, g, b] }
// Sans elle, `dessiner` se rabat sur un segment droit entre les deux nœuds projetés.

export const TAILLE_POOL = 4000;
/** Plafond par voie : un seul lien saturé ne doit pas vider le réservoir pour les autres. */
export const MAX_PAR_VOIE = 110;
/** Vitesse d'une impulsion à `vitesse() = 1`, en unités du monde par seconde. */
export const VITESSE_MONDE = 470;
const LONGUEUR_REPLI = 220;
const SPAWN_MAX_IMAGE = 6;

const borne = (v, a, b) => (v < a ? a : v > b ? b : v);
const fini = (v) => typeof v === "number" && Number.isFinite(v);

/** Particules par seconde pour un débit en bit/s : `null` ou ≤ 1 000 → 0 ; sinon 10 × (log10(bps) − 3), borné à [0, 60]. */
export function tauxEmission(bps) {
  if (!fini(bps) || bps <= 1000) return 0;
  return borne(10 * (Math.log10(bps) - 3), 0, 60);
}

/** Facteur de vitesse 0,25 → 1 sur la même échelle (0,25 sans débit, 1 à partir de 1 Gbit/s). */
export function vitesse(bps) {
  return 0.25 + 0.75 * (tauxEmission(bps) / 60);
}

/** Intensité 0-1 d'un débit (même échelle), pratique pour l'éclat des axones. */
export function intensite(bps) {
  return tauxEmission(bps) / 60;
}

/* ------------------------------------------------------------------ sprites de lueur (partagés avec rendu.js) */

function creerCanvas(l, h) {
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = l; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(l, h);
  return null;
}

const CACHE_LUEURS = new Map();
/** Tailles disponibles par type (« mipmaps » faites main) : le rendu dessine en lissage bilinéaire simple. */
const TAILLES_LUEUR = { halo: [128, 64, 32, 16], coeur: [128, 64, 32, 16], tete: [48, 24, 12] };

/**
 * Sprite de lueur précalculé (dégradé radial), mis en cache par type, couleur quantifiée et taille.
 * `type` : "halo" (grand, doux), "coeur" (centre blanc), "tete" (petit, net). `rgb` = [r, g, b].
 * `diametre` (px, facultatif) : taille à laquelle il sera dessiné ; on rend la plus petite version au moins
 * aussi grande, pour qu'une réduction en bilinéaire reste propre (le lissage « medium »/« high » du canvas
 * recalcule des mipmaps à chaque dessin et coûte la moitié de la cadence). Renvoie `null` hors navigateur.
 */
export function lueur(type, rgb, diametre = Infinity) {
  const r = rgb[0] | 0, g = rgb[1] | 0, b = rgb[2] | 0;
  const tailles = TAILLES_LUEUR[type] || TAILLES_LUEUR.tete;
  let niveau = 0;
  while (niveau + 1 < tailles.length && tailles[niveau + 1] >= diametre) niveau++;
  const cle = ((type === "halo" ? 0 : type === "coeur" ? 1 : 2) * 4 + niveau) * 16777216 + ((r >> 2) << 16 | (g >> 2) << 8 | (b >> 2));
  let s = CACHE_LUEURS.get(cle);
  if (s !== undefined) return s;
  if (CACHE_LUEURS.size > 1500) CACHE_LUEURS.clear();
  const S = tailles[niveau];
  s = creerCanvas(S, S);
  if (s) {
    const c = s.getContext("2d");
    const d = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const base = `rgba(${r},${g},${b},`;
    if (type === "halo") {
      d.addColorStop(0, base + ".55)"); d.addColorStop(0.16, base + ".30)"); d.addColorStop(0.42, base + ".09)");
      d.addColorStop(0.7, base + ".025)"); d.addColorStop(1, base + "0)");
    } else if (type === "coeur") {
      d.addColorStop(0, "rgba(255,255,255,1)"); d.addColorStop(0.22, base + ".92)"); d.addColorStop(0.55, base + ".20)");
      d.addColorStop(1, base + "0)");
    } else {
      d.addColorStop(0, "rgba(255,255,255,1)"); d.addColorStop(0.18, base + ".9)"); d.addColorStop(0.5, base + ".22)");
      d.addColorStop(1, base + "0)");
    }
    c.fillStyle = d;
    c.fillRect(0, 0, S, S);
  }
  CACHE_LUEURS.set(cle, s);
  return s;
}

/** Point de la polyligne `geo` à l'abscisse t ∈ [0, 1], décalé de `dec` pixels sur la normale. Écrit dans `o`. */
export function pointSurLien(geo, t, dec, o) {
  const N = geo.n;
  let f = borne(t, 0, 1) * N, i = f | 0;
  if (i >= N) i = N - 1;
  f -= i;
  const x0 = geo.px[i], y0 = geo.py[i], x1 = geo.px[i + 1], y1 = geo.py[i + 1];
  let nx = -(y1 - y0), ny = x1 - x0;
  const ln = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= ln; ny /= ln;
  o.x = x0 + (x1 - x0) * f + nx * dec;
  o.y = y0 + (y1 - y0) * f + ny * dec;
  return o;
}

/* ------------------------------------------------------------------ Influx */

const TEINTE_DESC = [172, 240, 255];
const TEINTE_MONT = [62, 118, 255];
const NB_SEAUX_MAX = 64;
/** Niveaux d'éclat : chaque seau de couleur est découpé en NB_NIVEAUX lots (un `stroke` + deux `fill` par lot). */
const NB_NIVEAUX = 3;
const ECLAT_NIVEAU = [1, 0.62, 0.3];
const NB_LOTS = NB_SEAUX_MAX * 2 * NB_NIVEAUX;
const SANS_LOT = 0xffff;
const TAU = Math.PI * 2;
const P_A = { x: 0, y: 0 }, P_B = { x: 0, y: 0 }, PROJ = { sx: 0, sy: 0, s: 0, p: 0 };

function actifParDefaut(lien, a, b) {
  return lien.etat === "on" && !!a && !!b && a.etat === "on" && b.etat === "on";
}

export class Influx {
  constructor() {
    // réservoir (tableaux typés, taille fixe)
    this._lien = new Int32Array(TAILLE_POOL);   // index du lien (slot)
    this._voie = new Uint8Array(TAILLE_POOL);   // 0 = descendant, 1 = montant
    this._u = new Float32Array(TAILLE_POOL);    // position 0 → 1 dans le sens de la voie
    this._du = new Float32Array(TAILLE_POOL);   // vitesse en u/s
    this._taille = new Float32Array(TAILLE_POOL);
    this._force = new Float32Array(TAILLE_POOL); // intensité 0-1 au départ
    this._fondu = new Float32Array(TAILLE_POOL); // 1 → 0 quand le lien s'éteint
    this._seau = new Uint16Array(TAILLE_POOL);
    this._ordre = new Int16Array(TAILLE_POOL);
    // positions écran calculées une fois par image : tête, début de traînée, rayon
    this._hx = new Float32Array(TAILLE_POOL); this._hy = new Float32Array(TAILLE_POOL);
    this._qx = new Float32Array(TAILLE_POOL); this._qy = new Float32Array(TAILLE_POOL);
    this._hr = new Float32Array(TAILLE_POOL); this._lw = new Float32Array(TAILLE_POOL);
    /** Nombre de particules vivantes. */
    this.nombre = 0;

    this._slots = [];          // index → slot
    this._parId = new Map();   // id de lien → index
    this._libres = [];
    this._image = 0;
    this._imageDessin = 0;
    this._graine = 0x2545f491;

    // seaux de couleur pour regrouper les traînées en peu d'appels `stroke`
    this._teintes = new Map();
    this._seauxCouleur = [];
    this._seauxTete = [];
    this._seauxRgb = [];
    this._compte = new Int32Array(NB_LOTS);
    this._debut = new Int32Array(NB_LOTS + 1);

    /** (idLien) → géométrie projetée, fournie par le rendu. */
    this.geometrie = null;
    /** (lien, noeudDe, noeudVers) → booléen : la voie peut-elle émettre ? */
    this.actif = actifParDefaut;
    /** (idNoeud, force 0-1, voie 0|1) appelé quand une impulsion arrive au bout de l'axone. */
    this.surArrivee = null;
    /** Multiplicateur global d'émission (qualité adaptative, mouvement réduit). */
    this.multiplicateur = 1;
    /** Mouvement réduit : moins d'impulsions, plus lentes. */
    this.calme = false;
  }

  _alea() {
    // xorshift32 : déterministe, sans allocation
    let x = this._graine;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._graine = x;
    return (x >>> 0) / 4294967296;
  }

  _slot(lien) {
    let i = this._parId.get(lien.id);
    if (i !== undefined) return this._slots[i];
    i = this._libres.length ? this._libres.pop() : this._slots.length;
    let s = this._slots[i];
    if (!s) {
      s = { index: i, id: "", lien: null, de: null, vers: null, acc0: 0, acc1: 0, n0: 0, n1: 0, long: LONGUEUR_REPLI,
        vu: -1, ok: false, repli: null, _geoImg: 0, _g: null };
      this._slots[i] = s;
    }
    s.id = lien.id; s.acc0 = this._alea(); s.acc1 = this._alea(); s.n0 = 0; s.n1 = 0; s.vu = -1; s.ok = false;
    this._parId.set(lien.id, i);
    return s;
  }

  _emettre(s, voie, bps) {
    if (this.nombre >= TAILLE_POOL) return false;
    if ((voie ? s.n1 : s.n0) >= MAX_PAR_VOIE) return false;
    const i = this.nombre++;
    const f = intensite(bps);
    this._lien[i] = s.index;
    this._voie[i] = voie;
    this._u[i] = this._alea() * 0.02;
    this._du[i] = (vitesse(bps) * VITESSE_MONDE * (this.calme ? 0.5 : 1) * (0.85 + this._alea() * 0.3)) / s.long;
    this._taille[i] = 0.7 + this._alea() * 0.6;
    this._force[i] = f;
    this._fondu[i] = 1;
    if (voie) s.n1++; else s.n0++;
    return true;
  }

  _retirer(i) {
    const s = this._slots[this._lien[i]];
    if (s) { if (this._voie[i]) s.n1--; else s.n0--; }
    const j = --this.nombre;
    if (i !== j) {
      this._lien[i] = this._lien[j]; this._voie[i] = this._voie[j]; this._u[i] = this._u[j];
      this._du[i] = this._du[j]; this._taille[i] = this._taille[j]; this._force[i] = this._force[j];
      this._fondu[i] = this._fondu[j];
    }
  }

  /** Avance la simulation de `dt` secondes sur les liens de `graphe` (instance de Graphe). */
  maj(dt, graphe) {
    if (!fini(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const img = ++this._image;
    const liens = graphe && graphe.liens;
    const noeuds = graphe && graphe.noeuds;
    // budget : on ralentit l'émission avant que le réservoir ne sature, pour rester équitable entre les liens
    const plein = this.nombre / TAILLE_POOL;
    const budget = (plein > 0.7 ? Math.max(0, (1 - plein) / 0.3) : 1) * this.multiplicateur * (this.calme ? 0.3 : 1);

    if (liens) {
      for (const lien of liens.values()) {
        if (!lien || typeof lien.id !== "string") continue;
        const s = this._slot(lien);
        s.vu = img;
        s.lien = lien;
        const a = noeuds ? noeuds.get(lien.de) : null, b = noeuds ? noeuds.get(lien.vers) : null;
        s.de = a || null; s.vers = b || null;
        if (a && b && fini(a.x) && fini(a.y) && fini(b.x) && fini(b.y)) {
          const dx = b.x - a.x, dy = b.y - a.y, dz = (fini(b.z) ? b.z : 0) - (fini(a.z) ? a.z : 0);
          s.long = Math.max(40, Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.08);
        } else s.long = LONGUEUR_REPLI;
        let ok = false;
        try { ok = !!this.actif(lien, a, b); } catch { ok = false; }
        s.ok = ok;
        for (let v = 0; v < 2; v++) {
          const bps = v ? lien.montant : lien.descendant;
          const taux = ok ? tauxEmission(bps) * budget : 0;
          if (taux <= 0) { if (v) s.acc1 = 0; else s.acc0 = 0; continue; }
          let acc = (v ? s.acc1 : s.acc0) + taux * dt;
          let k = 0;
          while (acc >= 1 && k < SPAWN_MAX_IMAGE) {
            acc -= 1; k++;
            if (!this._emettre(s, v, bps)) { acc = 0; break; }
          }
          if (acc > 1) acc = 1;
          if (v) s.acc1 = acc; else s.acc0 = acc;
        }
      }
    }

    // avance, arrivées, fondu des liens éteints, ménage des liens disparus
    for (let i = this.nombre - 1; i >= 0; i--) {
      const s = this._slots[this._lien[i]];
      if (!s || s.vu !== img) { this._retirer(i); continue; }
      if (!s.ok) {
        this._fondu[i] -= dt * 3;
        if (this._fondu[i] <= 0) { this._retirer(i); continue; }
      }
      this._u[i] += this._du[i] * dt;
      if (this._u[i] >= 1) {
        if (this._fondu[i] > 0.5 && this.surArrivee) {
          const id = this._voie[i] ? s.lien.de : s.lien.vers;
          try { this.surArrivee(id, this._force[i], this._voie[i]); } catch { /* le rendu ne doit pas casser la simulation */ }
        }
        this._retirer(i);
      }
    }
    for (let k = 0; k < this._slots.length; k++) {
      const s = this._slots[k];
      if (s && s.id && s.vu !== img && s.vu !== -2) {
        this._parId.delete(s.id);
        s.id = ""; s.lien = null; s.de = null; s.vers = null; s.vu = -2;
        this._libres.push(k);
      }
    }
  }

  /** Nombre de particules d'un lien par voie (diagnostic, tests). */
  compterVoies(idLien) {
    const i = this._parId.get(idLien);
    const s = i === undefined ? null : this._slots[i];
    return { descendant: s ? s.n0 : 0, montant: s ? s.n1 : 0 };
  }

  /** Vrai si aucune particule n'a de position non finie. */
  toutesFinies() {
    for (let i = 0; i < this.nombre; i++) if (!Number.isFinite(this._u[i]) || !Number.isFinite(this._du[i])) return false;
    return true;
  }

  /** Vide le réservoir (changement brutal d'instant, par exemple). */
  vider() {
    this.nombre = 0;
    for (const s of this._slots) if (s) { s.n0 = 0; s.n1 = 0; }
  }

  _seauPour(rgb, voie) {
    const r = rgb[0] | 0, g = rgb[1] | 0, b = rgb[2] | 0;
    const cle = ((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3)) * 2 + voie;
    let k = this._teintes.get(cle);
    if (k !== undefined) return k;
    if (this._teintes.size >= NB_SEAUX_MAX) { this._teintes.clear(); this._seauxCouleur.length = 0; this._seauxTete.length = 0; this._seauxRgb.length = 0; }
    k = this._teintes.size;
    this._teintes.set(cle, k);
    this._seauxCouleur[k] = `rgb(${r},${g},${b})`;
    this._seauxRgb[k] = [r, g, b];
    // cœur de la tête : la teinte du seau tirée vers le blanc (le bloom fait le reste de la lueur)
    this._seauxTete[k] = `rgb(${(r + (255 - r) * 0.62) | 0},${(g + (255 - g) * 0.62) | 0},${(b + (255 - b) * 0.62) | 0})`;
    return k;
  }

  _geo(s, camera) {
    const g = typeof this.geometrie === "function" ? this.geometrie(s.id) : null;
    if (g && g.n >= 1 && g.px && g.py) return g;
    // repli : segment droit entre les nœuds projetés
    const a = s.de, b = s.vers;
    if (!a || !b || !fini(a.x) || !fini(a.y) || !fini(b.x) || !fini(b.y)) return null;
    if (!s.repli) s.repli = { n: 1, px: new Float32Array(2), py: new Float32Array(2), s: 1, alpha: 1, cDesc: TEINTE_DESC, cMont: TEINTE_MONT };
    const r = s.repli;
    camera.projeter(a.x, a.y, fini(a.z) ? a.z : 0, PROJ);
    r.px[0] = PROJ.sx; r.py[0] = PROJ.sy; let sc = PROJ.s;
    camera.projeter(b.x, b.y, fini(b.z) ? b.z : 0, PROJ);
    r.px[1] = PROJ.sx; r.py[1] = PROJ.sy; sc = (sc + PROJ.s) / 2;
    r.s = sc;
    return r;
  }

  /**
   * Dessine les impulsions (traînée + tête lumineuse) en coordonnées écran, mélange additif.
   * Les impulsions sont groupées par lot (couleur × voie × niveau d'éclat) : un `stroke` pour les traînées et
   * deux `fill` pour les têtes (halo + cœur) par lot, quel que soit leur nombre. Les extrémités et les liens qui
   * s'éteignent rétrécissent les têtes au lieu de les estomper (l'alpha est commun au lot).
   */
  dessiner(ctx, camera) {
    const N = this.nombre;
    if (!N || !ctx || !camera) return;
    // 1) géométrie : lot, position de la tête et de la traînée, rayon (géométrie du lien mémorisée par image)
    const compte = this._compte;
    compte.fill(0);
    const img = ++this._imageDessin;
    const hx = this._hx, hy = this._hy, qx = this._qx, qy = this._qy, hr = this._hr, lwp = this._lw;
    for (let i = 0; i < N; i++) {
      const s = this._slots[this._lien[i]];
      if (s._geoImg !== img) { s._geoImg = img; s._g = this._geo(s, camera); }
      const g = s._g;
      if (!g || !(g.alpha > 0.01)) { this._seau[i] = SANS_LOT; continue; }
      const v = this._voie[i];
      const f = this._force[i];
      const eclat = (0.35 + 0.65 * f) * g.alpha;
      const rev = v === 1;
      const u = this._u[i];
      const th = rev ? 1 - u : u;
      // apparition / disparition aux extrémités (sous les somas : `coupeA` / `coupeB` fournis par le rendu)
      const cA = g.coupeA || 0, cB = g.coupeB || 0;
      const bord = borne((th - cA) / 0.06, 0, 1) * borne((1 - cB - th) / 0.06, 0, 1);
      if (eclat < 0.03 || bord <= 0) { this._seau[i] = SANS_LOT; continue; }
      const niveau = eclat >= 0.72 ? 0 : eclat >= 0.38 ? 1 : 2;
      const k = this._seauPour(v ? (g.cMont || TEINTE_MONT) : (g.cDesc || TEINTE_DESC), v);
      const lot = (k * 2 + v) * NB_NIVEAUX + niveau;
      this._seau[i] = lot;
      compte[lot]++;
      const tl = Math.min(0.12, (10 + 28 * f) / s.long);
      const dec = (rev ? -1 : 1) * (1.8 + 1.5 * f) * Math.max(0.35, g.s);
      pointSurLien(g, rev ? th + tl : th - tl, dec, P_B);
      pointSurLien(g, th, dec, P_A);
      hx[i] = P_A.x; hy[i] = P_A.y; qx[i] = P_B.x; qy[i] = P_B.y;
      // extinction du lien : la tête rétrécit (l'alpha est commun au lot)
      const sc = Math.max(0.45, Math.min(1.5, g.s));
      hr[i] = ((1.1 + 1.9 * f) * this._taille[i] * sc + 0.4) * bord * this._fondu[i];
      lwp[i] = (0.6 + 1.1 * f) * Math.max(0.4, Math.min(1.8, g.s));
    }
    const debut = this._debut;
    debut[0] = 0;
    for (let k = 0; k < NB_LOTS; k++) debut[k + 1] = debut[k] + compte[k];
    compte.fill(0);
    for (let i = 0; i < N; i++) {
      const lot = this._seau[i];
      if (lot === SANS_LOT) continue;
      this._ordre[debut[lot] + compte[lot]++] = i;
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let lot = 0; lot < NB_LOTS; lot++) {
      const d0 = debut[lot], d1 = debut[lot + 1];
      if (d1 <= d0) continue;
      const niveau = lot % NB_NIVEAUX, k = (lot / NB_NIVEAUX / 2) | 0;
      const e = ECLAT_NIVEAU[niveau];
      // 2) traînées
      ctx.beginPath();
      let lw = 0;
      for (let j = d0; j < d1; j++) {
        const i = this._ordre[j];
        ctx.moveTo(qx[i], qy[i]);
        ctx.lineTo(hx[i], hy[i]);
        lw += lwp[i];
      }
      ctx.strokeStyle = this._seauxCouleur[k];
      ctx.lineWidth = lw / (d1 - d0);
      ctx.globalAlpha = 0.3 * e;
      ctx.stroke();
      // 3) têtes : deux halos colorés de plus en plus serrés puis un cœur pâle (le bloom fait le reste)
      for (let passe = 0; passe < 2; passe++) {
        const f = passe ? 1.55 : 2.7;
        ctx.beginPath();
        for (let j = d0; j < d1; j++) {
          const i = this._ordre[j], r = hr[i] * f;
          if (r < 0.3) continue;
          ctx.moveTo(hx[i] + r, hy[i]);
          ctx.arc(hx[i], hy[i], r, 0, TAU);
        }
        ctx.fillStyle = this._seauxCouleur[k];
        ctx.globalAlpha = (passe ? 0.2 : 0.07) * e;
        ctx.fill();
      }
      ctx.beginPath();
      for (let j = d0; j < d1; j++) {
        const i = this._ordre[j], r = hr[i] * 0.62;
        if (r < 0.25) continue;
        ctx.moveTo(hx[i] + r, hy[i]);
        ctx.arc(hx[i], hy[i], r, 0, TAU);
      }
      ctx.fillStyle = this._seauxTete[k];
      ctx.globalAlpha = 0.95 * e;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
