// Rendu « Synapses » en perspective (table inclinée de camera.js) : chaque machine est un neurone
// (soma + dendrites + halo), chaque lien un axone courbe en 3D où circulent les influx de débit.
//
//   const rendu = new Rendu(canvas);
//   requestAnimationFrame(function boucle(t) { rendu.image(dt, graphe, camera, idSurvol, idSelection); … });
//
// Contrat avec main.js / interactions.js :
//   - `image()` redimensionne le canvas (DPR), AVANCE la caméra (`camera.avancer(dt)`) et joue l'entrée
//     cinématographique ; main.js ne doit donc pas appeler `camera.avancer` lui-même ;
//   - les nœuds doivent avoir été posés par `disposer()` (x, y, z) ; un nœud sans position éclot près de son parent ;
//   - aides pour les interactions : `noeudSous(sx, sy)`, `ecran(id)`, `recadrer(camera, duree)` ;
//   - réglages : `connexionPerdue` (PVE + MikroTik en rouge pulsé), `correspondances` (Set d'ids : sonar de recherche),
//     `calme` (suivi automatique de prefers-reduced-motion).
// Les changements d'état sont détectés ici, image par image (aucun appel supplémentaire à faire après `appliquer`).

import { couleurNoeud, versRgb, palette, ROUGE, GRIS_ETEINT, INCONNU } from "./couleurs.js";
import { Influx, lueur, pointSurLien, intensite } from "./particules.js";
import { Fond } from "./fond.js";
import { Placeur } from "./etiquettes.js";
import { YAW_DEFAUT, PITCH_DEFAUT } from "./camera.js";

const TAU = Math.PI * 2;
const borne = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fini = (v) => typeof v === "number" && Number.isFinite(v);
const sstep = (a, b, v) => { const t = borne((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sortieCubique = (t) => 1 - Math.pow(1 - t, 3);
const sortieRetour = (t) => { const c1 = 1.45, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
/** Battement « lub-dub » (0-1). */
const battement = (t) => { const s = TAU * t; return Math.pow(Math.max(0, Math.sin(s)), 12) + 0.6 * Math.pow(Math.max(0, Math.sin(s - 0.75)), 12); };
function melanger(a, b, t, o) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }
function copier(s, o) { o[0] = s[0]; o[1] = s[1]; o[2] = s[2]; return o; }
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
function hacher(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry(graine) {
  let s = graine | 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ------------------------------------------------------------------ constantes visuelles */

/** Rayon du soma (unités du monde) par type de nœud. */
const RAYON = { routeur: 18, hyperviseur: 16, internet: 13, sauvegarde: 11, nas: 11, "nas-vm": 10, onduleur: 10, box: 9.5,
  domotique: 9, pc: 9, switch: 8, vm: 7, ct: 6, appareil: 5.2, site: 3.4 };
const MAJEURS = new Set(["routeur", "internet", "box", "hyperviseur", "sauvegarde", "nas", "nas-vm", "onduleur", "domotique", "switch", "pc"]);

const BLANC = [255, 255, 255];
const tableau = ({ r, g, b }) => [r, g, b];
const C_ROUGE = tableau(versRgb(ROUGE));
const C_GRIS = tableau(versRgb(GRIS_ETEINT));
const C_INCONNU = tableau(versRgb(INCONNU));
const C_MORT = [74, 84, 100];
const C_CHAUD = [255, 84, 96];
const AMB_SOMA = [255, 228, 182], AMB_HALO = [255, 128, 28], AMB_ANNEAU = [255, 194, 96];
const C_SOL = [110, 190, 255];
const C_USB = [160, 196, 228];

const N_SEG = 16;               // segments d'un axone
const MAX_COMETES = 64, MAX_ETINCELLES = 420, MAX_ONDES = 40, MAX_IMPACTS = 160;
const NB = " ", NNB = " ";

/** Débit d'impulsions par rapport à l'échelle de particules.js : assez pour voir couler, pas un collier de perles. */
const DENSITE_INFLUX = 0.55;
/** Types dont les invités tournent en anneau autour du parent (orbites dessinées au sol). */
const INVITES = new Set(["ct", "vm", "nas-vm"]);

const SANS = '"Space Grotesk", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
const F_MAJEUR = `600 12.5px ${SANS}`;
const F_CT = `500 10.5px ${MONO}`;
const F_SITE = `500 10px ${MONO}`;
const F_PETIT = `400 9.5px ${MONO}`;
const H_MAJEUR = 15, H_NOM = 13, H_LIGNE = 12;
/** Hauteur (z) des orbites : celle des CT/VM (disposition.js, niveau 2). */
const HAUTEURS_ORBITE = 35;

/* ------------------------------------------------------------------ formats (affichage sur la carte) */

const NF0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nombre = (v) => (v >= 100 ? NF0 : NF1).format(v);
function fmtDebit(bps) {
  if (!fini(bps) || bps < 0) return "–";
  if (bps < 1e3) return NF0.format(bps) + NB + "bit/s";
  if (bps < 1e6) return nombre(bps / 1e3) + NB + "kbit/s";
  if (bps < 1e9) return nombre(bps / 1e6) + NB + "Mbit/s";
  return nombre(bps / 1e9) + NB + "Gbit/s";
}
const fmtPct = (x) => NF0.format(borne(fini(x) ? x : 0, 0, 1) * 100) + NNB + "%";
function fmtStockage(d) {
  if (!d || !fini(d.u) || !fini(d.t) || d.t <= 0) return "";
  const u = d.t >= 1e12 ? 1e12 : 1e9, unite = d.t >= 1e12 ? "To" : "Go";
  const f = (v) => (v >= 10 ? NF0 : NF1).format(v);
  return `${f(d.u / u)} / ${f(d.t / u)}${NB}${unite} · ${fmtPct(d.u / d.t)}`;
}
function fmtRam(d) {
  if (!d || !fini(d.u) || !fini(d.t) || d.t <= 0) return "";
  const G = 1073741824, f = (v) => (v >= 10 ? NF0 : NF1).format(v);
  return `RAM ${f(d.u / G)} / ${f(d.t / G)}${NB}Go`;
}
function fmtDuree(s) {
  if (!fini(s) || s < 0) return "";
  if (s < 3600) return NF0.format(Math.max(1, Math.round(s / 60))) + NB + "min";
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return `${h}${NB}h${m ? " " + m + NB + "min" : ""}`; }
  const j = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return `${j}${NB}j${h ? " " + h + NB + "h" : ""}`;
}

/* ------------------------------------------------------------------ fabrication des objets visuels */

function dendritesDe(type, R) {
  if (type === "site") return [];
  const petit = type === "ct" || type === "vm" || type === "appareil";
  const nb = type === "internet" ? 13 : petit ? 3 + ((R() * 3) | 0) : 6 + ((R() * 4) | 0);
  const out = [];
  for (let i = 0; i < nb; i++) {
    out.push({
      a: (i / nb) * TAU + (R() - 0.5) * 0.8, l: (petit ? 1.2 : 0.9) + R() * (petit ? 1.6 : 1.5), courbe: (R() - 0.5) * 1.1, ph: R() * TAU,
      fourche: R() < 0.55 ? { a: 0.5 + R() * 0.3, da: (R() < 0.5 ? -1 : 1) * (0.4 + R() * 0.5), l: 0.3 + R() * 0.35 } : null,
    });
  }
  return out;
}

function creerVisuel(n) {
  const R = mulberry(hacher(n.id));
  return {
    id: n.id, n, type: n.type, groupe: n.groupe, parentId: n.parent,
    x: NaN, y: NaN, z: 0, rx: 0, ry: 0, rz: 0,
    pr: { sx: 0, sy: 0, s: 1, p: 1 }, sx: 0, sy: 0, s: 1, p: 1, bx: 0, by: 0, bs: 1, r: 0, brume: 1, visible: false,
    parentV: null, lienParent: null, prof: 0, rang: 0, deg: 1, enfantsN: 0,
    base: [143, 168, 200], soma: [200, 230, 255], halo: [80, 140, 255], anneau: [150, 220, 255], dend: [100, 150, 255],
    somaA: [0, 0, 0], haloA: [0, 0, 0], anneauA: [0, 0, 0], dendA: [0, 0, 0],
    naissance: Infinity, ne: false, born: 0, vis: 0, retrait: 0,
    etat: "", vie: 0, vieV: 0, wOff: 0, wEt: 0, wInc: 0, wPerdu: 0, reveilA: -Infinity, mortA: -Infinity, allumerA: 0, eteindreA: 0, puffA: 0,
    flash: 0, ign: 0, anneaux: new Float32Array(4).fill(-99), ia: 0, mortT: -99, dernierImpact: 0,
    ret: 0, dim: 1, dimT: 1, ph: R() * TAU, dendrites: dendritesDe(n.type, R),
    g: { cpu: 0, ram: 0, disque: 0, bat: 0 }, labV: 0, vu: 0, prochaineOnde: 0,
    pal: null, chef: null, ordreI: 0, orbites: null, tSx: 0, tSy: 0, tN: 0, tR: 0, tVie: 0,
    labA: 0, vars: null, moyeu: 1, voisins: [],
    // étiquette : boîte affichée (décalage par rapport au nœud, glisse vers la place choisie), lignes, variante
    lab: { x0: 0, y0: 0, x1: 0, y1: 0, ok: false, aligne: "center", nb: 0, lignes: [], etat: "", nom: "", majeur: false },
    dem: { id: n.id, x: 0, y: 0, r: 0, priorite: 0, variantes: [], prefere: null },
    obs: { id: n.id, x: 0, y: 0, r: 0 },
  };
}

function creerLienVisuel(l, a, b) {
  const h = hacher(l.id);
  let courbe = ((h & 1) ? 1 : -1) * (0.07 + (((h >>> 3) % 100) / 100) * 0.12);
  if (l.type === "usb") courbe = 0.16;
  if (l.type === "site") courbe *= 0.6;
  return {
    id: l.id, l, a, b, sortant: true, courbe, etat: "",
    geo: { n: N_SEG, px: new Float32Array(N_SEG + 1), py: new Float32Array(N_SEG + 1), s: 1, alpha: 0, cDesc: [172, 240, 255], cMont: [62, 118, 255], coupeA: 0, coupeB: 0 },
    reveal: 0, lumiere: 0, wOn: 0, wOff: 0, wEt: 0, wInc: 0, wPerdu: 0, hl: 0, hlT: 0, dim: 1, dimT: 1, rf: 0, rr: 0,
    jag: new Float32Array(N_SEG + 1), jag2: new Float32Array(N_SEG + 1), jagT: 0, vu: 0, retrait: 0, ph: (h % 1000) / 159,
    halo: [80, 140, 255], coeur: [150, 200, 255],
  };
}

const PROJ = { sx: 0, sy: 0, s: 0, p: 0 }, PA = { x: 0, y: 0 }, PB = { x: 0, y: 0 };

/* ================================================================== Rendu */

export class Rendu {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.influx = new Influx();
    this.influx.multiplicateur = DENSITE_INFLUX;
    this.fond = new Fond();
    this.T = 0;
    this.W = 1; this.H = 1; this.DPR = 1;
    this.qualite = 2;
    /** Vrai pendant une perte de connexion au serveur : PVE et MikroTik en rouge pulsé. */
    this.connexionPerdue = false;
    /** Ids à signaler par un sonar (recherche), ou null. */
    this.correspondances = null;

    this._noeuds = new Map();
    this._liens = new Map();
    this._ordre = [];
    this._tri = [];
    this._img = 0;
    this._etendue = 600;
    this._racine = null;

    // effets (réservoirs de taille fixe)
    this._cometes = Array.from({ length: MAX_COMETES }, () => ({ actif: false, lv: null, dir: 1, t0: 0, duree: 0.4, col: [255, 255, 255], taille: 1, cible: null, rouge: false }));
    this._ondes = Array.from({ length: MAX_ONDES }, () => ({ actif: false, x: 0, y: 0, z: 0, t0: 0, d: 1, R: 100, col: [255, 255, 255], a: 0.55 }));
    this._impacts = Array.from({ length: MAX_IMPACTS }, () => ({ actif: false, v: null, t0: 0, col: [255, 255, 255] }));
    const E = MAX_ETINCELLES;
    this._et = { n: 0, x: new Float32Array(E), y: new Float32Array(E), z: new Float32Array(E), vx: new Float32Array(E), vy: new Float32Array(E),
      vz: new Float32Array(E), t0: new Float32Array(E), d: new Float32Array(E), sz: new Float32Array(E), sp: new Array(E).fill(null) };
    this._pensee = null;
    this._placeur = new Placeur();
    this._demandes = [];
    this._obstacles = [];
    this._dVisuels = [];
    this._largeurs = new Map();
    this._zone = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this._reserves = [];
    this._zoneMinuterie = 0;
    this._zoneT = -10;
    /** Zoom de la vue d'ensemble (cadrage) : le zoom sémantique se règle par rapport à lui. */
    this._kVue = 0.9;
    this._kVueSale = true;
    this._territoires = [];

    // état global de la scène
    this._intro = { t0: null, viser: false, fini: false, pret: false };
    this.A = 0;               // alerte batterie 0-1
    this._surBatterie = null;
    this._brune = 0; this._vacille = 0;
    this._surge = 0;
    this._flashEcran = -10; this._flashX = 0; this._flashY = 0; this._flashZ = 0;
    this._spontane = 0;
    this._survol = null; this._selection = null; this._chaine = null;
    this._perf = { acc: 0, n: 0 };
    this._alerteCss = -1;
    this._bandeau = { texte: "", fin: 0, visible: false };

    // bloom : copies sous-échantillonnées additionnées à l'image
    const mk = () => { const c = document.createElement("canvas"); c.width = c.height = 1; return [c, c.getContext("2d")]; };
    [this._bH, this._bHx] = mk(); [this._bA, this._bAx] = mk(); [this._bB, this._bBx] = mk(); [this._bC, this._bCx] = mk();

    // mouvement réduit
    this.calme = false;
    try {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.calme = mq.matches;
      const suivre = (e) => { this.calme = e.matches; };
      if (mq.addEventListener) mq.addEventListener("change", suivre); else if (mq.addListener) mq.addListener(suivre);
    } catch { /* pas de matchMedia */ }

    // liaison avec les influx
    this.influx.geometrie = (id) => { const lv = this._liens.get(id); return lv ? lv.geo : null; };
    this.influx.actif = (lien) => {
      const lv = this._liens.get(lien.id);
      // connexion perdue : plus de données fraîches, les influx s'éteignent (l'état affiché reste le dernier connu)
      return !this.connexionPerdue && !!lv && !lv.retrait && lv.reveal >= 1 && lv.etat === "on" && lv.lumiere > 0.6 && lien.type !== "usb";
    };
    this.influx.surArrivee = (id, force) => {
      const v = this._noeuds.get(id);
      if (!v || !v.ne) return;
      // les gros carrefours (PVE) reçoivent beaucoup d'influx : flash atténué pour scintiller sans saturer
      v.flash = Math.min(1.5, v.flash + (0.035 + 0.1 * force) * v.moyeu);
      if (!this.calme && force > 0.55 && this.T - v.dernierImpact > 0.14) { v.dernierImpact = this.T; this._impact(v, this._cDesc); }
    };
    this._cDesc = [172, 240, 255];
  }

  /** Vrai une fois l'entrée cinématographique jouée. */
  get introTerminee() { return this._intro.fini; }

  /** Zoom (camera.k) de la vue d'ensemble pour la taille d'écran actuelle : référence du zoom sémantique. */
  get zoomVue() { return this._kVue; }

  /* ---------------------------------------------------------------- API pour les interactions */

  /** Id du nœud sous le point écran (sx, sy) en pixels CSS, ou null. Le plus proche de la caméra l'emporte. */
  noeudSous(sx, sy) {
    let meilleur = null, dMin = Infinity;
    for (const v of this._noeuds.values()) {
      if (!v.visible || v.retrait || v.vis < 0.3) continue;
      const rayon = Math.max(v.r * 1.9, v.type === "site" ? 8 : 10);
      const dx = v.sx - sx, dy = v.sy - sy, d2 = dx * dx + dy * dy;
      if (d2 > rayon * rayon) continue;
      const score = d2 / (rayon * rayon) + v.p * 1e-6;
      if (score < dMin) { dMin = score; meilleur = v.id; }
    }
    return meilleur;
  }

  /** Position écran d'un nœud {sx, sy, r} (pixels CSS) ou null. */
  ecran(id) {
    const v = this._noeuds.get(id);
    if (!v || !v.visible) return null;
    const L = v.lab;
    // boîte de l'étiquette affichée (pixels CSS), pour que le bouton ⓘ ne la recouvre pas
    const lab = L.ok && v.labV > 0.05 ? { x0: v.sx + L.x0, y0: v.sy + L.y0, x1: v.sx + L.x1, y1: v.sy + L.y0 + (L.h || 16) } : null;
    return { sx: v.sx, sy: v.sy, r: v.r, lab };
  }

  /** Cadrage de tout le graphe (vue par défaut), animé sur `duree` secondes. */
  recadrer(camera, duree = 1.2) {
    camera.viser(this.cadrage(camera), this.calme ? 0 : duree);
  }

  /**
   * Cadrage en perspective : {tx, ty, k, yaw, pitch} qui fait tenir tous les nœuds (et leurs étiquettes)
   * entre la barre du haut et la frise, vu sous l'angle donné (par défaut l'angle d'origine).
   * La caméra n'est pas modifiée.
   */
  /**
   * Angle de vue par défaut : le graphe est en longueur (Internet à gauche, pve à droite) ; sur un écran en
   * hauteur (téléphone), on tourne d'un quart de tour : Internet en haut, la galaxie de pve en bas, au premier plan.
   */
  yawVue(camera = null) {
    const W = camera ? camera.largeur : this.W, H = camera ? camera.hauteur : this.H;
    return H > W * 1.15 ? YAW_DEFAUT + Math.PI / 2 : YAW_DEFAUT;
  }

  cadrage(camera, yaw = this.yawVue(camera), pitch = PITCH_DEFAUT, marges = { haut: 70, bas: 100, cotes: 40 }) {
    // par point : x, y, z, marge autour du nœud (unités du monde), place pour l'étiquette dessous (pixels)
    const pts = [];
    for (const v of this._noeuds.values()) {
      if (v.retrait) continue;
      const x = fini(v.x) ? v.x : v.n.x, y = fini(v.y) ? v.y : v.n.y;
      if (!fini(x) || !fini(y)) continue;
      const t = v.type, majeur = MAJEURS.has(t);
      pts.push(x, y, fini(v.n.z) ? v.n.z : 30, majeur ? 30 : t === "site" ? 7 : 14, majeur ? 40 : t === "site" ? 2 : 14);
    }
    if (!pts.length) return { tx: 0, ty: 0, k: 0.6, yaw, pitch };
    const sauve = { tx: camera.tx, ty: camera.ty, k: camera.k, yaw: camera.yaw, pitch: camera.pitch };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 5) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
    }
    camera.yaw = yaw; camera.pitch = pitch; camera.tx = (x0 + x1) / 2; camera.ty = (y0 + y1) / 2; camera.k = 0.5;
    const W = camera.largeur, H = camera.hauteur;
    const aw = Math.max(120, W - 2 * marges.cotes), ah = Math.max(120, H - marges.haut - marges.bas);
    const cxV = W / 2 + camera.decalX, cyV = marges.haut + ah / 2 + camera.decalY;
    for (let it = 0; it < 5; it++) {
      let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
      for (let i = 0; i < pts.length; i += 5) {
        camera.projeter(pts[i], pts[i + 1], pts[i + 2], PROJ);
        const m = pts[i + 3] * PROJ.s;
        a0 = Math.min(a0, PROJ.sx - m); a1 = Math.max(a1, PROJ.sx + m);
        b0 = Math.min(b0, PROJ.sy - m); b1 = Math.max(b1, PROJ.sy + m + pts[i + 4]);
      }
      const f = Math.min(aw / Math.max(1, a1 - a0), ah / Math.max(1, b1 - b0));
      const c = camera.deprojeter((a0 + a1) / 2, (b0 + b1) / 2), d = camera.deprojeter(cxV, cyV);
      camera.tx += c.x - d.x; camera.ty += c.y - d.y;
      camera.k = borne(camera.k * f, 0.08, 2.2);
    }
    const res = { tx: camera.tx, ty: camera.ty, k: camera.k, yaw, pitch };
    Object.assign(camera, sauve);
    return res;
  }

  /* ---------------------------------------------------------------- image */

  /** Dessine une image : `dt` en secondes, `survol` / `selection` = id de nœud ou null. */
  image(dt, graphe, camera, survol = null, selection = null) {
    if (!fini(dt) || dt < 0) dt = 0;
    if (dt > 0.05) dt = 0.05;
    this.T += dt;
    this._adapter(dt);
    this._dimensionner(camera);
    if (graphe && graphe.noeuds) this._synchroniser(graphe);
    this._jouerIntro(camera);
    if (this._kVueSale && this._ordre.length) {
      this._kVueSale = false;
      this._kVue = Math.max(0.05, this.cadrage(camera).k);
    }
    camera.avancer(dt);
    this._majSurvol(graphe, survol, selection);
    this._majScene(dt);
    this._majNoeuds(dt, camera);
    this._majLiens(dt, camera);
    this.influx.calme = this.calme;
    this.influx.maj(dt, graphe);
    this._majEffets(dt);
    this._dessiner(dt, camera);
    this._dom();
  }

  /* ---------------------------------------------------------------- taille, qualité */

  _adapter(dt) {
    if (this.T < 5 || (typeof document !== "undefined" && document.hidden)) return;
    const p = this._perf;
    p.acc += dt; p.n++;
    if (p.n >= 120) {
      const moy = p.acc / p.n;
      p.acc = 0; p.n = 0;
      if (moy > 1 / 40 && this.qualite > 0) {
        this.qualite--;
        this.influx.multiplicateur = DENSITE_INFLUX * (this.qualite === 1 ? 0.7 : 0.45);
        this.W = -1; // force le redimensionnement
      }
    }
  }

  _dimensionner(camera) {
    const cv = this.canvas;
    const W = Math.max(1, cv.clientWidth || window.innerWidth || 1), H = Math.max(1, cv.clientHeight || window.innerHeight || 1);
    const DPR = this.qualite >= 2 ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    if (W !== this.W || H !== this.H || DPR !== this.DPR) {
      this.W = W; this.H = H; this.DPR = DPR;
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      this._bH.width = Math.max(1, Math.ceil(W / 2)); this._bH.height = Math.max(1, Math.ceil(H / 2));
      this._bA.width = Math.max(1, Math.ceil(W / 4)); this._bA.height = Math.max(1, Math.ceil(H / 4));
      this._bB.width = Math.max(1, Math.ceil(W / 8)); this._bB.height = Math.max(1, Math.ceil(H / 8));
      this._bC.width = Math.max(1, Math.ceil(W / 16)); this._bC.height = Math.max(1, Math.ceil(H / 16));
      // Lissage bilinéaire simple partout : « medium » / « high » recalculent des mipmaps à chaque dessin
      // (sprites comme bloom) et coûtaient la moitié de la cadence ; les sprites existent en plusieurs tailles
      // (lueur(type, couleur, diamètre)) pour que les réductions restent propres.
      this.ctx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in this.ctx) this.ctx.imageSmoothingQuality = "low";
      for (const c of [this._bHx, this._bAx, this._bBx, this._bCx]) {
        c.imageSmoothingEnabled = true;
        if ("imageSmoothingQuality" in c) c.imageSmoothingQuality = "low";
      }
      this._kVueSale = true;
      this._zoneT = -10;
    }
    if (camera.largeur !== W || camera.hauteur !== H) camera.redimensionner(W, H);
    if (this.T - this._zoneT > 1) this._majZone();
  }

  /** À appeler quand un élément d'interface apparaît ou disparaît (panneau, légende) : les étiquettes l'évitent. */
  majZone() {
    this._zoneT = -10;
    if (typeof setTimeout === "function") { clearTimeout(this._zoneMinuterie); this._zoneMinuterie = setTimeout(() => { this._zoneT = -10; }, 700); }
  }

  /**
   * Zone utile des étiquettes : entre la barre du haut et la frise, moins la légende, le panneau de détails et le
   * panneau du mode modifier (relue chaque seconde : la barre peut passer sur deux lignes, un panneau s'ouvrir).
   */
  _majZone() {
    this._zoneT = this.T;
    const z = this._zone, R = this._reserves;
    z.x0 = 6; z.x1 = this.W - 6; z.y0 = 62; z.y1 = this.H - 92;
    R.length = 0;
    if (typeof document === "undefined") return;
    const barre = document.getElementById("barre"), frise = document.getElementById("frise");
    const rb = barre && barre.getBoundingClientRect(), rf = frise && !frise.hidden && frise.childElementCount ? frise.getBoundingClientRect() : null;
    if (rb && rb.height > 0) z.y0 = rb.bottom + 4;
    if (rf && rf.height > 0) z.y1 = rf.top - 6;
    if (z.y1 - z.y0 < 80) { z.y0 = 0; z.y1 = this.H; }
    for (const sel of ["#legende", ".panneau.ouvert", ".masques:not([hidden])"]) {
      const e = document.querySelector(sel);
      if (!e || !e.childElementCount) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) R.push({ x0: r.left - 4, y0: r.top - 4, x1: r.right + 4, y1: r.bottom + 4 });
    }
  }

  /* ---------------------------------------------------------------- synchronisation avec le graphe */

  _synchroniser(graphe) {
    const img = ++this._img;
    let topo = false;
    for (const n of graphe.noeuds.values()) {
      let v = this._noeuds.get(n.id);
      if (!v) {
        v = creerVisuel(n);
        this._noeuds.set(n.id, v);
        topo = true;
      } else if (v.retrait) {
        v.retrait = 0; topo = true;
      }
      if (v.n !== n) v.n = n;
      if (v.parentId !== n.parent || v.groupe !== n.groupe || v.type !== n.type) {
        v.parentId = n.parent; v.groupe = n.groupe; v.type = n.type; topo = true;
      }
      v.vu = img;
    }
    for (const v of this._noeuds.values()) {
      if (v.vu !== img && !v.retrait) { v.retrait = this.T || 1e-3; topo = true; }
      else if (v.retrait && this.T - v.retrait > 0.9) { this._noeuds.delete(v.id); topo = true; }
    }
    for (const l of graphe.liens.values()) {
      let lv = this._liens.get(l.id);
      const a = this._noeuds.get(l.de), b = this._noeuds.get(l.vers);
      if (!a || !b) continue;
      if (!lv) { lv = creerLienVisuel(l, a, b); this._liens.set(l.id, lv); topo = true; }
      else if (lv.retrait) { lv.retrait = 0; topo = true; }
      if (lv.a !== a || lv.b !== b) { lv.a = a; lv.b = b; topo = true; }
      lv.l = l;
      lv.vu = img;
    }
    for (const lv of this._liens.values()) {
      if (lv.vu !== img && !lv.retrait) { lv.retrait = this.T || 1e-3; topo = true; }
      else if (lv.retrait && (this.T - lv.retrait > 0.7 || !this._noeuds.has(lv.a.id) || !this._noeuds.has(lv.b.id))) { this._liens.delete(lv.id); topo = true; }
    }
    if (topo) this._topologie();
  }

  _topologie() {
    const enfants = new Map();
    for (const v of this._noeuds.values()) {
      v.deg = 0;
      const p = typeof v.parentId === "string" && v.parentId !== v.id ? this._noeuds.get(v.parentId) : null;
      v.parentV = p && !p.retrait ? p : (v.retrait ? v.parentV : null);
      v.lienParent = null;
    }
    for (const v of this._noeuds.values()) v.voisins.length = 0;
    for (const lv of this._liens.values()) {
      lv.a.deg++; lv.b.deg++;
      lv.a.voisins.push(lv.b); lv.b.voisins.push(lv.a);
      if (lv.b.parentV === lv.a) { lv.b.lienParent = lv; lv.sortant = true; }
      else if (lv.a.parentV === lv.b) { lv.a.lienParent = lv; lv.sortant = false; }
      else lv.sortant = true;
    }
    // ordre en largeur depuis le MikroTik (les parents avant les enfants), puis les orphelins
    for (const v of this._noeuds.values()) {
      if (!v.parentV) continue;
      let l = enfants.get(v.parentV.id);
      if (!l) enfants.set(v.parentV.id, (l = []));
      l.push(v);
    }
    const ordre = [];
    const vus = new Set();
    const racines = [];
    const mk = this._noeuds.get("mikrotik");
    if (mk) racines.push(mk);
    for (const v of this._noeuds.values()) if (!v.parentV && v !== mk) racines.push(v);
    for (const r of racines) {
      if (vus.has(r)) continue;
      vus.add(r); r.prof = 0; r.rang = 0;
      const file = [r];
      for (let i = 0; i < file.length; i++) {
        const v = file[i];
        ordre.push(v);
        const l = enfants.get(v.id) || [];
        v.enfantsN = l.length;
        l.forEach((c, k) => {
          if (vus.has(c)) return;
          vus.add(c); c.prof = v.prof + 1; c.rang = k; file.push(c);
        });
      }
    }
    for (const v of this._noeuds.values()) if (!vus.has(v)) { v.prof = 1; ordre.push(v); }
    this._ordre = ordre;
    this._racine = mk && !mk.retrait ? mk : ordre[0] || null;
    this._kVueSale = true;
    // 1 pour un nœud ordinaire, ~0,3 pour pve : les carrefours reçoivent beaucoup d'influx et d'axones
    for (const v of ordre) v.moyeu = 1 / (1 + Math.max(0, (v.deg || 1) - 6) / 10);
    // couleurs : teinte du groupe, éclaircie avec la profondeur dans le groupe ; palette sans glissement de teinte
    ordre.forEach((v, i) => {
      v.ordreI = i;
      let p = 0, a = v.parentV;
      const vus2 = new Set([v]);
      while (a && a.groupe === v.groupe && !vus2.has(a)) { vus2.add(a); p++; a = a.parentV; }
      const c = couleurNoeud(v.n, p);
      v.base[0] = c.r; v.base[1] = c.g; v.base[2] = c.b;
      const pal = palette(v.base);
      v.pal = pal;
      copier(pal.soma, v.soma); copier(pal.halo, v.halo); copier(pal.anneau, v.anneau); copier(pal.dendrite, v.dend);
      // chef de territoire : l'ancêtre posé directement sous la racine (lueur de groupe au sol)
      let chef = v;
      const vus3 = new Set();
      while (chef.parentV && chef.parentV !== this._racine && !vus3.has(chef)) { vus3.add(chef); chef = chef.parentV; }
      v.chef = v === this._racine ? null : chef;
    });
    for (const lv of this._liens.values()) {
      const enfant = lv.sortant ? lv.b : lv.a;
      const pal = enfant.pal || palette(enfant.base);
      copier(pal.axone, lv.halo);
      copier(pal.coeurAxone, lv.coeur);
    }
    // orbites : les invités d'un hyperviseur tournent sur un ou deux anneaux (dessinés au sol, très discrets)
    for (const v of ordre) {
      v.orbites = null;
      const inv = [];
      for (const c of ordre) if (c.parentV === v && INVITES.has(c.type) && fini(c.n.x) && fini(c.n.y) && fini(v.n.x) && fini(v.n.y)) inv.push(Math.hypot(c.n.x - v.n.x, c.n.y - v.n.y));
      if (inv.length < 7) continue;
      inv.sort((x, y) => x - y);
      const moy = inv.reduce((s, d) => s + d, 0) / inv.length;
      const dedans = inv.filter((d) => d <= moy), dehors = inv.filter((d) => d > moy);
      const med = (l) => l[l.length >> 1];
      v.orbites = dehors.length >= 3 && med(dehors) - med(dedans) > 25 ? [med(dedans), med(dehors)] : [med(inv)];
    }
    // naissances après l'entrée : éclosion près du parent, petit décalage entre frères
    if (this._intro.t0 !== null) {
      for (const v of ordre) {
        if (v.naissance !== Infinity) continue;
        v.naissance = this.calme ? -10 : this.T + 0.08 + Math.min(0.5, v.rang * 0.03);
      }
    }
    // le nœud survolé a disparu : on oublie la chaîne et la pensée en cours
    if (this._survol && !this._noeuds.has(this._survol)) { this._survol = null; this._chaine = null; this._pensee = null; }
  }

  /* ---------------------------------------------------------------- entrée cinématographique */

  _jouerIntro(camera) {
    const it = this._intro;
    if (it.t0 === null) {
      const r = this._noeuds.get("mikrotik") || this._ordre[0];
      if (!r || !fini(r.n.x) || !fini(r.n.y)) return;
      it.t0 = this.T;
      // dates de naissance : par profondeur, puis dans l'ordre angulaire autour du MikroTik
      const parProf = new Map();
      for (const v of this._ordre) { if (!parProf.has(v.prof)) parProf.set(v.prof, []); parProf.get(v.prof).push(v); }
      for (const [d, l] of parProf) {
        l.sort((a, b) => Math.atan2(a.n.y || 0, a.n.x || 0) - Math.atan2(b.n.y || 0, b.n.x || 0));
        l.forEach((v, i) => {
          v.naissance = this.calme ? -10 : it.t0 + 0.45 + d * 0.62 + i * (0.9 / Math.max(l.length, 1)) * Math.min(1, l.length / 10);
        });
      }
      const c = this.cadrage(camera);
      it.cible = c;
      if (this.calme) {
        camera.viser(it.cible, 0);
        it.fini = true;
      } else {
        // départ : tout près du MikroTik, vue presque de dessus, tournée ; puis recul et inclinaison
        camera.viser({ tx: r.n.x, ty: r.n.y, k: Math.min(4, c.k * 2.4), yaw: c.yaw - 1.1, pitch: 1.38 }, 0);
        it.viser = true;
      }
      return;
    }
    const age = this.T - it.t0;
    if (it.viser && age >= 0.35) { it.viser = false; camera.viser(it.cible, 4.2); }
    if (!it.pret && age > 1.5) {
      it.pret = true;
      try { document.body.classList.add("pret"); } catch { /* hors navigateur */ }
    }
    if (!it.fini && age > 5) it.fini = true;
  }

  /* ---------------------------------------------------------------- survol, sélection */

  _majSurvol(graphe, survol, selection) {
    if (survol !== this._survol) {
      this._survol = survol;
      this._chaine = survol && graphe && typeof graphe.chaine === "function" ? new Set(graphe.chaine(survol)) : null;
      this._lancerPensee(survol);
    }
    this._selection = selection;
    const ch = this._chaine;
    for (const v of this._noeuds.values()) {
      v.dimT = ch ? (ch.has(v.id) ? 1 : v.parentV && v.parentV.id === survol ? 0.7 : 0.16) : 1;
    }
    for (const lv of this._liens.values()) {
      const dansChaine = ch && ch.has(lv.a.id) && ch.has(lv.b.id);
      lv.hlT = dansChaine ? 1 : 0;
      lv.dimT = ch ? (dansChaine || lv.a.id === survol || lv.b.id === survol ? 1 : 0.12) : 1;
    }
  }

  /** « Pensée » : une impulsion blanche part du MikroTik et descend la chaîne jusqu'au nœud survolé. */
  _lancerPensee(id) {
    this._pensee = null;
    if (!id || this.calme) return;
    const v = this._noeuds.get(id);
    if (!v) return;
    const chaine = [];
    let c = v;
    const vus = new Set();
    while (c && !vus.has(c)) { vus.add(c); chaine.unshift(c); c = c.parentV; }
    if (chaine.length < 2) { v.flash = Math.min(1.6, v.flash + 0.9); return; }
    const segs = [];
    for (let i = 0; i < chaine.length - 1; i++) {
      const p = chaine[i], e = chaine[i + 1], lv = e.lienParent;
      if (!lv) return;
      segs.push({ lv, dir: lv.a === p ? 1 : -1, vers: e });
    }
    chaine[0].flash = Math.min(1.6, chaine[0].flash + 0.8);
    this._pensee = { segs, i: 0, u: 0, trace: new Float32Array(26), nt: 0 };
  }

  /* ---------------------------------------------------------------- scène : batterie, pointe WAN */

  _majScene(dt) {
    const ups = this._noeuds.get("onduleur");
    const j = ups && !ups.retrait && ups.n.jauges;
    const surBat = !!(j && j.secteur === false && ups.n.etat !== "inconnu");
    if (surBat !== this._surBatterie) {
      if (this._surBatterie !== null && ups && !this.calme && ups.ne) {
        if (surBat) {
          this._brune = 1;
          this._onde(ups.rx, ups.ry, 0, AMB_HALO, 1300, 2.4, 0.35);
          ups.flash = 1.6;
        } else {
          this._onde(ups.rx, ups.ry, 0, this._cDesc, 1500, 2.8, 0);
          this._onde(ups.rx, ups.ry, 0, [206, 246, 255], 900, 2.6, 0.3);
          ups.flash = 1.6;
          this._eclats(ups, [172, 240, 255], 18, 1.1);
        }
      }
      this._surBatterie = surBat;
    }
    this._brune = Math.max(0, this._brune - dt * 1.25);
    let f = this._brune > 0 ? Math.abs(Math.sin(Math.floor(this.T * 19) * 78.233) * 43758.5453) % 1 : 0;
    this._vacille = f > 0.55 ? 1 : f * 0.6;
    this.A += ((surBat ? 1 : 0) - this.A) * Math.min(1, dt * 1.6);
    if (Math.abs(this.A - (surBat ? 1 : 0)) < 0.002) this.A = surBat ? 1 : 0;
    melanger([172, 240, 255], AMB_SOMA, this.A, this._cDesc);
    // pointe WAN : éclairs sur le lien de la box
    let wan = 0;
    const lw = this._liens.get("mikrotik>box");
    if (lw && lw.l) wan = Math.max(fini(lw.l.descendant) ? lw.l.descendant : 0, fini(lw.l.montant) ? lw.l.montant : 0);
    this._surge += (sstep(250e6, 700e6, wan) - this._surge) * Math.min(1, dt * 3);
    if (this._surge > 0.3 && !this.calme) {
      const inet = this._noeuds.get("internet");
      if (inet && inet.ne && this.T > inet.prochaineOnde) {
        inet.prochaineOnde = this.T + 0.36;
        this._onde(inet.rx, inet.ry, inet.rz, this._cDesc, 120 + 140 * this._surge, 1.1, 0);
      }
    }
    if (this.A > 0.3 && !this.calme && ups && ups.ne && this.T > ups.prochaineOnde) {
      ups.prochaineOnde = this.T + 1.05;
      this._onde(ups.rx, ups.ry, ups.rz, AMB_HALO, 90, 1.3, 0);
    }
    // tirs spontanés : le réseau ne dort jamais
    if (!this.calme && this.T > this._spontane && this._ordre.length) {
      this._spontane = this.T + 0.25 + Math.random() * 0.4;
      const v = this._ordre[(Math.random() * this._ordre.length) | 0];
      if (v && v.vie > 0.9) v.flash = Math.min(1.2, v.flash + 0.35);
    }
  }

  /* ---------------------------------------------------------------- nœuds : états, transitions, positions */

  _etatEffectif(v) {
    const e = v.n.etat;
    return e === "on" || e === "off" || e === "eteint" || e === "inconnu" ? e : "inconnu";
  }

  _transition(v, avant, apres) {
    const T = this.T, p = v.parentV;
    if (!v.ne || avant === "") return;
    if (apres === "on") {
      if (avant === "inconnu") { v.reveilA = T; return; } // la source revient : retour discret
      // cascade : attendre que le parent se soit rallumé, ~0,1 s d'écart par génération
      let t = T;
      if (p && p.reveilA > T - 0.05) t = Math.max(T, p.reveilA + 0.1 + Math.min(0.3, v.rang * 0.012));
      const viaComete = !this.calme && p && p.etat === "on" && v.lienParent;
      const trajet = viaComete ? 0.42 : 0;
      v.reveilA = t + trajet;
      v.allumerA = v.reveilA;
      if (viaComete) {
        const lv = v.lienParent;
        this._comete(lv, lv.a === p ? 1 : -1, this._cDesc, t, trajet, 1.25, v, false);
        p.flash = Math.min(1.6, p.flash + 0.6);
      }
      return;
    }
    // vers off / eteint / inconnu : la cascade descend aussi du parent vers les enfants
    let t = T;
    if (p && p.mortA > T - 0.05 && p.etat !== "on") t = Math.max(T, p.mortA + 0.1 + Math.min(0.3, v.rang * 0.012));
    v.mortA = t;
    if (avant === "on" && apres === "off") v.eteindreA = t;
    else if (avant === "on" && apres === "eteint") v.puffA = t;
  }

  _allumer(v) {
    v.ign = 1;
    v.flash = Math.max(v.flash, 1.1);
    if (this.calme) return;
    this._anneau(v, this.T); this._anneau(v, this.T + 0.16); this._anneau(v, this.T + 0.34);
    this._eclats(v, v.soma, v.type === "site" ? 5 : 16, 1);
    this._onde(v.rx, v.ry, v.rz, v.soma, (RAYON[v.type] || 8) * 9, 1.2, 0);
  }

  _eteindre(v) {
    v.flash = Math.min(1.6, v.flash + 0.9);
    if (this.calme) return;
    v.mortT = this.T;
    this._anneau(v, this.T + 0.05);
    this._eclats(v, C_ROUGE, v.type === "site" ? 4 : 12, 0.75);
    const p = v.parentV, lv = v.lienParent;
    if (p && lv) this._comete(lv, lv.a === v ? 1 : -1, C_ROUGE, this.T, 0.55, 0.9, p, true);
  }

  _majNoeuds(dt, camera) {
    const T = this.T, calme = this.calme;
    let pMin = Infinity, pMax = -Infinity, etendue = 200;
    const rx0 = this._racine ? this._racine.rx : 0, ry0 = this._racine ? this._racine.ry : 0;
    for (const v of this._ordre) {
      const n = v.n;
      // position cible (glisse doucement si la disposition ou un déplacement la change)
      let cx = n.x, cy = n.y;
      if (!fini(cx) || !fini(cy)) {
        const p = v.parentV;
        cx = p && fini(p.x) ? p.x + 12 : 0;
        cy = p && fini(p.y) ? p.y + 12 : 0;
      }
      const cz = fini(n.z) ? n.z : 30;
      if (!fini(v.x) || !fini(v.y)) { v.x = cx; v.y = cy; v.z = cz; }
      else if (!v.retrait) {
        const k = calme ? 1 : Math.min(1, dt * 14);
        v.x += (cx - v.x) * k; v.y += (cy - v.y) * k; v.z += (cz - v.z) * k;
      }
      // éclosion / retrait
      if (v.retrait) v.vis = Math.max(0, 1 - (T - v.retrait) / 0.8);
      else {
        v.born = borne((T - v.naissance) / 0.85, 0, 1);
        v.vis = v.born <= 0 ? 0 : v.born >= 1 ? 1 : calme ? v.born : Math.max(0, sortieRetour(v.born));
      }
      const e = this._etatEffectif(v);
      if (!v.ne && v.born > 0 && !v.retrait) {
        v.ne = true;
        v.etat = e;
        if (e === "on") {
          v.reveilA = -Infinity; v.ign = 1;
          if (!calme) { this._anneau(v, T); this._anneau(v, T + 0.14); if (v.type !== "site") this._eclats(v, v.soma, v.type === "ct" || v.type === "vm" ? 3 : 9, 0.55); }
        } else v.mortA = -Infinity;
        if (v === this._racine && !calme && this._intro.t0 !== null && T - this._intro.t0 < 3) {
          this._onde(v.x, v.y, v.z, [172, 240, 255], 900, 2.2, 0);
          this._onde(v.x, v.y, v.z, [62, 118, 255], 620, 2.4, 0.25);
          v.flash = 1.5;
          this._flashEcran = T; this._flashX = v.x; this._flashY = v.y; this._flashZ = v.z;
          this._eclats(v, [206, 246, 255], 26, 1.6);
        }
      } else if (v.ne && e !== v.etat) {
        const avant = v.etat;
        v.etat = e;
        this._transition(v, avant, e);
      }
      if (v.allumerA && T >= v.allumerA) { v.allumerA = 0; if (v.etat === "on") this._allumer(v); }
      if (v.eteindreA && T >= v.eteindreA) { v.eteindreA = 0; if (v.etat === "off") this._eteindre(v); }
      if (v.puffA && T >= v.puffA) {
        v.puffA = 0;
        if (v.etat === "eteint" && !calme) { this._anneau(v, T); this._eclats(v, [150, 160, 176], 6, 0.4); }
      }
      // poids d'état (fondus croisés)
      const vivant = v.ne && !v.retrait;
      const cOn = vivant && v.etat === "on" && T >= v.reveilA ? 1 : 0;
      const apres = vivant && T >= v.mortA;
      // le cœur rouge continue de battre jusqu'à ce que l'étincelle de retour arrive
      const attente = v.etat === "on" && T < v.reveilA && v.wOff > 0.05;
      const cOff = apres && (v.etat === "off" || attente) ? 1 : 0;
      const cEt = apres && v.etat === "eteint" ? 1 : 0;
      const cInc = apres && v.etat === "inconnu" ? 1 : 0;
      const vit = calme ? 3 : 1;
      if (v.vie < cOn) v.vie = Math.min(1, v.vie + dt * 0.85 * vit);
      else if (v.vie > cOn) v.vie = Math.max(0, v.vie - dt * (v.etat === "eteint" ? 0.45 : 0.75) * vit);
      v.wOff += (cOff - v.wOff) * Math.min(1, dt * (cOff ? 0.9 : 2.2) * vit);
      v.wEt += (cEt - v.wEt) * Math.min(1, dt * (cEt ? 0.7 : 2.2) * vit);
      v.wInc += (cInc - v.wInc) * Math.min(1, dt * 1.6 * vit);
      const perdu = this.connexionPerdue && (v.id === "pve" || v.id === "mikrotik") && !v.retrait ? 1 : 0;
      v.wPerdu += (perdu - v.wPerdu) * Math.min(1, dt * (perdu ? 3 : 1.5));
      // scintillement d'allumage
      v.ign = Math.max(0, v.ign - dt / 1.5);
      let lv = v.vie;
      if (v.ign > 0 && !calme) {
        const fl = Math.abs(Math.sin(Math.floor(T * 24 + v.ph * 9) * 12.9898) * 43758.5453) % 1;
        lv *= lerp(1, 0.45 + 0.55 * fl, v.ign);
      }
      v.vieV = lv;
      v.flash *= Math.exp(-dt * 3.2);
      const retT = v.id === this._survol || v.id === this._selection ? 1 : 0;
      v.ret += (retT - v.ret) * Math.min(1, dt * (retT ? 9 : 6));
      v.dim += (v.dimT - v.dim) * Math.min(1, dt * 7);
      // jauges lissées
      const j = n.jauges || {}, gk = Math.min(1, dt * 2.6), g = v.g, on = v.etat === "on";
      const ratio = (d) => (d && fini(d.u) && fini(d.t) && d.t > 0 ? borne(d.u / d.t, 0, 1) : 0);
      g.cpu += ((on && fini(j.cpu) ? borne(j.cpu, 0, 1) : 0) - g.cpu) * gk;
      g.ram += ((on ? ratio(j.ram) : 0) - g.ram) * gk;
      g.disque += (ratio(j.disque) - g.disque) * gk;
      g.bat += ((fini(j.batterie) ? borne(j.batterie / 100, 0, 1) : 0) - g.bat) * gk;
      // palette du moment (teinte ambre sur batterie, plus forte sur l'onduleur)
      const am = v.type === "onduleur" ? this.A : this.A * 0.42;
      melanger(v.soma, AMB_SOMA, am, v.somaA);
      melanger(v.halo, AMB_HALO, am, v.haloA);
      melanger(v.anneau, AMB_ANNEAU, am, v.anneauA);
      melanger(v.dend, AMB_HALO, am * 0.8, v.dendA);
      // position rendue : éclosion depuis le parent, flottement, survol qui soulève
      const p = v.parentV;
      const bob = calme ? 0 : Math.sin(T * 1.1 + v.ph) * 2.2 * v.vie;
      if (v.vis < 1 && p && !v.retrait) {
        v.rx = lerp(p.rx, v.x, v.vis); v.ry = lerp(p.ry, v.y, v.vis); v.rz = lerp(p.rz, v.z, v.vis);
      } else { v.rx = v.x; v.ry = v.y; v.rz = v.z; }
      v.rz += bob + v.ret * 6;
      // projection
      camera.projeter(v.rx, v.ry, v.rz, v.pr);
      v.sx = v.pr.sx; v.sy = v.pr.sy; v.s = v.pr.s; v.p = v.pr.p;
      camera.projeter(v.rx, v.ry, 0, PROJ);
      v.bx = PROJ.sx; v.by = PROJ.sy; v.bs = PROJ.s;
      const pop = 1 + 0.16 * sortieRetour(borne(v.ret, 0, 1)) * (v.type === "site" ? 1.6 : 1);
      const palp = v.type === "onduleur" && !calme ? 1 + 0.1 * Math.sin(T * 7) * this.A : 1;
      v.r = (RAYON[v.type] || 7) * v.s * Math.max(0.05, v.vis) * pop * palp;
      v.visible = v.vis > 0.002 && v.sx > -200 && v.sx < this.W + 200 && v.sy > -200 && v.sy < this.H + 200;
      if (v.visible) { if (v.p < pMin) pMin = v.p; if (v.p > pMax) pMax = v.p; }
      const d = Math.hypot(v.x - rx0, v.y - ry0);
      if (d > etendue && !v.retrait) etendue = d;
    }
    this._etendue += (etendue - this._etendue) * Math.min(1, dt * 2);
    // brume de profondeur : le fond de la scène s'estompe un peu
    const pe = pMax > pMin ? pMax - pMin : 1;
    for (const v of this._ordre) v.brume = 1 - 0.42 * borne((v.p - pMin) / pe, 0, 1);
  }

  /* ---------------------------------------------------------------- liens : géométrie 3D, états */

  _majLiens(dt, camera) {
    const T = this.T, calme = this.calme;
    for (const lv of this._liens.values()) {
      const a = lv.a, b = lv.b, l = lv.l, geo = lv.geo;
      // courbe de Bézier quadratique en 3D, légèrement bombée vers le haut, échantillonnée puis projetée
      const ax = a.rx, ay = a.ry, az = a.rz, bx = b.rx, by = b.ry, bz = b.rz;
      const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const c = lv.courbe * len;
      const mx = (ax + bx) / 2 - (dy / len) * c, my = (ay + by) / 2 + (dx / len) * c;
      const mz = (az + bz) / 2 + Math.min(len * 0.1, 55);
      for (let i = 0; i <= N_SEG; i++) {
        const u = i / N_SEG, iu = 1 - u, k0 = iu * iu, k1 = 2 * iu * u, k2 = u * u;
        camera.projeter(k0 * ax + k1 * mx + k2 * bx, k0 * ay + k1 * my + k2 * by, k0 * az + k1 * mz + k2 * bz, PROJ);
        geo.px[i] = PROJ.sx; geo.py[i] = PROJ.sy;
      }
      geo.s = (a.s + b.s) / 2;
      // part de l'axone cachée sous chaque soma (les influx y rétrécissent, l'axone part de la membrane)
      const lEcran = Math.hypot(geo.px[N_SEG] - geo.px[0], geo.py[N_SEG] - geo.py[0]) || 1;
      geo.coupeA = Math.min(0.4, (a.r * 1.15 + 1) / lEcran);
      geo.coupeB = Math.min(0.4, (b.r * 1.15 + 1) / lEcran);
      // tracé progressif pendant l'éclosion
      const enfant = lv.sortant ? b : a;
      lv.reveal = calme || lv.retrait ? 1 : borne((T - (enfant.naissance - 0.5)) / 0.5, 0, 1);
      let e = l.etat;
      // connexion perdue : alerte rouge par-dessus le dernier état connu (qui reste affiché)
      const perdu = this.connexionPerdue && ((a.id === "mikrotik" && b.id === "pve") || (a.id === "pve" && b.id === "mikrotik")) ? 1 : 0;
      lv.wPerdu += (perdu - lv.wPerdu) * Math.min(1, dt * (perdu ? 3 : 1.5));
      if (e !== "on" && e !== "off" && e !== "eteint" && e !== "inconnu") e = "inconnu";
      lv.etat = e;
      const vit = calme ? 3 : 1;
      lv.wOn += ((e === "on" ? 1 : 0) - lv.wOn) * Math.min(1, dt * 2.4 * vit);
      lv.wOff += ((e === "off" && T >= enfant.mortA ? 1 : 0) - lv.wOff) * Math.min(1, dt * 1.4 * vit);
      lv.wEt += ((e === "eteint" ? 1 : 0) - lv.wEt) * Math.min(1, dt * 1.2 * vit);
      lv.wInc += ((e === "inconnu" ? 1 : 0) - lv.wInc) * Math.min(1, dt * 1.6 * vit);
      lv.lumiere = lv.wOn * Math.min(a.vie, b.vie);
      lv.hl += (lv.hlT - lv.hl) * Math.min(1, dt * 5);
      lv.dim += (lv.dimT - lv.dim) * Math.min(1, dt * 7);
      const kk = Math.min(1, dt * 2.2);
      lv.rf += (intensite(l.descendant) - lv.rf) * kk;
      lv.rr += (intensite(l.montant) - lv.rr) * kk;
      const fondu = lv.retrait ? Math.max(0, 1 - (T - lv.retrait) / 0.6) : 1;
      geo.alpha = lv.dim * Math.min(1, lv.lumiere * 1.3) * fondu * Math.min(a.brume, b.brume);
      // deux teintes du groupe de l'enfant : descendant pâle (vers l'enfant), montant saturé
      const pal = enfant.pal || PAL_DEFAUT;
      melanger(pal.descendant, AMB_SOMA, this.A * 0.5, geo.cDesc);
      melanger(pal.montant, AMB_HALO, this.A * 0.5, geo.cMont);
      if (l.type === "wan" || lv.id === "mikrotik>box") {
        if (this._surge > 0.05 && !calme && T > lv.jagT) {
          lv.jagT = T + 0.055;
          for (let i = 0; i <= N_SEG; i++) { lv.jag[i] = Math.random() * 2 - 1; lv.jag2[i] = Math.random() * 2 - 1; }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- effets */

  _anneau(v, t) { v.anneaux[v.ia] = t; v.ia = (v.ia + 1) & 3; }

  _onde(x, y, z, col, R, d, retard) {
    if (this.calme) return;
    for (const o of this._ondes) {
      if (o.actif) continue;
      o.actif = true; o.x = x; o.y = y; o.z = z; o.R = R; o.d = d; o.t0 = this.T + (retard || 0);
      o.col[0] = col[0]; o.col[1] = col[1]; o.col[2] = col[2];
      return;
    }
  }

  _impact(v, col) {
    for (const im of this._impacts) {
      if (im.actif) continue;
      im.actif = true; im.v = v; im.t0 = this.T; im.col[0] = col[0]; im.col[1] = col[1]; im.col[2] = col[2];
      return;
    }
  }

  _comete(lv, dir, col, t0, duree, taille, cible, rouge) {
    if (this.calme || !lv) return;
    for (const c of this._cometes) {
      if (c.actif) continue;
      c.actif = true; c.lv = lv; c.dir = dir; c.t0 = t0; c.duree = Math.max(0.1, duree); c.taille = taille; c.cible = cible; c.rouge = rouge;
      c.col[0] = col[0]; c.col[1] = col[1]; c.col[2] = col[2];
      return;
    }
  }

  _eclats(v, col, nb, force) {
    if (this.calme || !v) return;
    const E = this._et, sp = lueur("tete", col, 8);
    const rw = RAYON[v.type] || 7;
    for (let k = 0; k < nb && E.n < MAX_ETINCELLES; k++) {
      const i = E.n++;
      const a = Math.random() * TAU, el = (Math.random() - 0.3) * 0.9, vit = (26 + Math.random() * 80) * force;
      E.x[i] = v.rx + Math.cos(a) * rw; E.y[i] = v.ry + Math.sin(a) * rw; E.z[i] = v.rz;
      E.vx[i] = Math.cos(a) * vit; E.vy[i] = Math.sin(a) * vit; E.vz[i] = el * vit * 0.7;
      E.t0[i] = this.T; E.d[i] = 0.6 + Math.random() * 0.9; E.sz[i] = 1.1 + Math.random() * 1.8; E.sp[i] = sp;
    }
  }

  _majEffets(dt) {
    const T = this.T;
    for (const c of this._cometes) {
      if (!c.actif) continue;
      if (!this._liens.has(c.lv.id)) { c.actif = false; continue; }
      if (T - c.t0 >= c.duree) {
        c.actif = false;
        if (c.cible && c.cible.ne) {
          this._eclats(c.cible, c.col, 6, 0.6);
          if (c.rouge) { c.cible.flash = Math.min(1.6, c.cible.flash + 0.4); this._impact(c.cible, C_ROUGE); }
        }
      }
    }
    const E = this._et;
    const fr = Math.exp(-dt * 2.6);
    for (let i = E.n - 1; i >= 0; i--) {
      if (T - E.t0[i] > E.d[i]) {
        const j = --E.n;
        E.x[i] = E.x[j]; E.y[i] = E.y[j]; E.z[i] = E.z[j]; E.vx[i] = E.vx[j]; E.vy[i] = E.vy[j]; E.vz[i] = E.vz[j];
        E.t0[i] = E.t0[j]; E.d[i] = E.d[j]; E.sz[i] = E.sz[j]; E.sp[i] = E.sp[j]; E.sp[j] = null;
        continue;
      }
      E.vx[i] *= fr; E.vy[i] *= fr; E.vz[i] *= fr;
      E.x[i] += E.vx[i] * dt; E.y[i] += E.vy[i] * dt; E.z[i] += E.vz[i] * dt;
    }
    for (const im of this._impacts) if (im.actif && T - im.t0 > 0.55) im.actif = false;
    for (const o of this._ondes) if (o.actif && T - o.t0 > o.d) o.actif = false;
    const th = this._pensee;
    if (th) {
      const s = th.segs[th.i];
      if (!s || !this._liens.has(s.lv.id)) this._pensee = null;
      else {
        const longueur = Math.max(60, Math.hypot(s.lv.b.rx - s.lv.a.rx, s.lv.b.ry - s.lv.a.ry));
        th.u += (dt * (620 + 520 * th.i)) / longueur;
        if (th.u >= 1) {
          s.vers.flash = Math.min(1.8, s.vers.flash + 1.1);
          this._impact(s.vers, BLANC);
          if (th.i === th.segs.length - 1) {
            this._eclats(s.vers, s.vers.soma, 10, 0.8);
            this._onde(s.vers.rx, s.vers.ry, s.vers.rz, s.vers.soma, (RAYON[s.vers.type] || 7) * 6, 0.9, 0);
          }
          th.i++; th.u = 0;
          if (th.i >= th.segs.length) this._pensee = null;
        }
      }
    }
  }

  /* ================================================================ dessin */

  _dessiner(dt, camera) {
    const ctx = this.ctx, W = this.W, H = this.H, DPR = this.DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    this.fond.calme = this.calme;
    this.fond.dessiner(ctx, W, H, camera, dt, this.T, this.A);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    this._dessinerSol(ctx, camera);
    this._dessinerOndes(ctx, camera);
    this._dessinerLiens(ctx);
    this.influx.dessiner(ctx, camera);
    this._dessinerCometes(ctx);
    this._dessinerNoeuds(ctx, camera);
    this._dessinerEtincelles(ctx, camera);
    // baisse de tension : la scène vacille avant de basculer en ambre
    if (this._brune > 0.01) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = this._brune * (0.25 + 0.5 * this._vacille);
      ctx.fillStyle = "#01040a"; ctx.fillRect(0, 0, W, H);
    }
    this._bloom();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // éclair d'ouverture : le premier neurone s'allume et inonde l'écran
    const u = (this.T - this._flashEcran) / 1.1;
    if (u >= 0 && u < 1) {
      camera.projeter(this._flashX, this._flashY, this._flashZ, PROJ);
      const M = Math.max(W, H);
      const g = ctx.createRadialGradient(PROJ.sx, PROJ.sy, 0, PROJ.sx, PROJ.sy, M * (0.35 + 0.6 * sortieCubique(u)));
      const a = Math.pow(1 - u, 2.2) * 0.5;
      g.addColorStop(0, `rgba(225,250,255,${a.toFixed(4)})`);
      g.addColorStop(0.25, `rgba(120,200,255,${(a * 0.45).toFixed(4)})`);
      g.addColorStop(1, "rgba(40,110,255,0)");
      ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    this._dessinerEtiquettes(ctx, camera, dt);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  _bloom() {
    const q = this.qualite, cv = this.canvas, ctx = this.ctx;
    const s = 0.95 + this._surge * 0.45 + this.A * 0.1;
    const bH = this._bH, bA = this._bA, bB = this._bB, bC = this._bC;
    const bHx = this._bHx, bAx = this._bAx, bBx = this._bBx, bCx = this._bCx;
    // réduction par moitiés successives : un lissage bilinéaire à ×½ fait la moyenne exacte de 2 × 2 pixels
    bHx.globalCompositeOperation = "copy"; bHx.globalAlpha = 1; bHx.drawImage(cv, 0, 0, bH.width, bH.height);
    bAx.globalCompositeOperation = "copy"; bAx.globalAlpha = 1; bAx.drawImage(bH, 0, 0, bA.width, bA.height);
    bBx.globalCompositeOperation = "copy"; bBx.globalAlpha = 1; bBx.drawImage(bA, 0, 0, bB.width, bB.height);
    // élever au carré : seules les zones vraiment lumineuses débordent (le noir reste noir)
    bBx.globalCompositeOperation = "multiply"; bBx.drawImage(bA, 0, 0, bB.width, bB.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    const lissage = ctx.imageSmoothingQuality;
    ctx.imageSmoothingQuality = "low";
    ctx.globalAlpha = borne(0.78 * s, 0, 1); ctx.drawImage(bB, 0, 0, cv.width, cv.height);
    if (q > 0) {
      bCx.globalCompositeOperation = "copy"; bCx.globalAlpha = 1; bCx.drawImage(bB, 0, 0, bC.width, bC.height);
      ctx.globalAlpha = borne(0.8 * s, 0, 1); ctx.drawImage(bC, 0, 0, cv.width, cv.height);
    }
    ctx.imageSmoothingQuality = lissage;
  }

  /* ---------------------------------------------------------------- sol : anneaux, ombres, tiges */

  _dessinerSol(ctx, camera) {
    const r0 = this._racine;
    if (!r0) return;
    const it = this._intro, age = it.t0 === null ? 0 : this.T - it.t0;
    const ga = this.calme ? 1 : borne((age - 0.2) / 1.6, 0, 1);
    if (ga <= 0) return;
    const col = melanger(C_SOL, AMB_ANNEAU, this.A, [0, 0, 0]);
    const cs = rgb(col);
    const E = Math.max(300, this._etendue + 60);
    const anneaux = [0.34, 0.67, 1, 1.16];
    ctx.lineWidth = 1;
    ctx.strokeStyle = cs;
    for (let k = 0; k < anneaux.length; k++) {
      const ex = this.calme ? 1 : sortieCubique(borne((age - 0.3 - k * 0.15) / 1.6, 0, 1));
      const R = anneaux[k] * E * ex;
      if (R < 2) continue;
      ctx.globalAlpha = (k === 3 ? 0.07 : k === 1 ? 0.045 : 0.035) * ga;
      if (k === 1) ctx.setLineDash([3, 7]);
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * TAU;
        camera.projeter(r0.rx + Math.cos(a) * R, r0.ry + Math.sin(a) * R, 0, PROJ);
        if (i) ctx.lineTo(PROJ.sx, PROJ.sy); else ctx.moveTo(PROJ.sx, PROJ.sy);
      }
      ctx.stroke();
      if (k === 1) ctx.setLineDash([]);
    }
    // graduations sur l'anneau extérieur (repère de rotation)
    const RT = anneaux[3] * E;
    ctx.globalAlpha = 0.09 * ga;
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU, l = i % 6 === 0 ? 26 : 10;
      camera.projeter(r0.rx + Math.cos(a) * RT, r0.ry + Math.sin(a) * RT, 0, PROJ);
      ctx.moveTo(PROJ.sx, PROJ.sy);
      camera.projeter(r0.rx + Math.cos(a) * (RT - l), r0.ry + Math.sin(a) * (RT - l), 0, PROJ);
      ctx.lineTo(PROJ.sx, PROJ.sy);
    }
    ctx.stroke();
    const sp = Math.sin(camera.pitch);
    // territoires : une nappe de lumière de la couleur du groupe sous chaque groupe du premier niveau
    const O = this._ordre;
    for (const v of O) if (v.chef === v) { v.tSx = 0; v.tSy = 0; v.tN = 0; v.tR = 0; v.tVie = 0; }
    for (const v of O) {
      const c = v.chef;
      if (!c || c.retrait || v.retrait || v.vis <= 0.05) continue;
      c.tSx += v.rx; c.tSy += v.ry; c.tN++; c.tVie += Math.max(v.vie, v.wOff * 0.5, v.wEt * 0.3, v.wInc * 0.3);
    }
    for (const v of O) {
      const c = v.chef;
      if (!c || !c.tN || v.retrait || v.vis <= 0.05) continue;
      const d = Math.hypot(v.rx - c.tSx / c.tN, v.ry - c.tSy / c.tN);
      if (d > c.tR) c.tR = d;
    }
    for (const c of O) {
      if (c.chef !== c || c.tN < 2 || !c.visible) continue;
      const R = c.tR + 70;
      camera.projeter(c.tSx / c.tN, c.tSy / c.tN, 0, PROJ);
      const rx = R * PROJ.s * 1.25, ry = rx * sp;
      const sprite = lueur("halo", c.wOff > 0.5 && c.vie < 0.2 ? C_ROUGE : c.haloA);
      const a = ga * c.dim * Math.min(1, c.vis) * (0.09 + 0.12 * (c.tVie / c.tN)) * (c.tN > 6 ? 1 : 0.75);
      if (sprite && a > 0.004) { ctx.globalAlpha = a; ctx.drawImage(sprite, PROJ.sx - rx, PROJ.sy - ry, rx * 2, ry * 2); }
    }
    // orbites des invités autour de leur hyperviseur (un ou deux anneaux décalés)
    ctx.lineWidth = 1;
    for (const v of O) {
      if (!v.orbites || !v.visible || v.retrait) continue;
      ctx.strokeStyle = rgb(v.anneauA);
      for (let k = 0; k < v.orbites.length; k++) {
        const R = v.orbites[k] * Math.min(1, v.vis);
        if (R < 4) continue;
        ctx.globalAlpha = ga * v.dim * (k ? 0.08 : 0.11) * (0.4 + 0.6 * v.vie);
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * TAU;
          camera.projeter(v.rx + Math.cos(a) * R, v.ry + Math.sin(a) * R, HAUTEURS_ORBITE, PROJ);
          if (i) ctx.lineTo(PROJ.sx, PROJ.sy); else ctx.moveTo(PROJ.sx, PROJ.sy);
        }
        ctx.stroke();
      }
    }
    // ombre au sol et tige lumineuse sous chaque nœud : donne la hauteur, donc la profondeur
    for (const v of this._ordre) {
      if (!v.visible || v.vis <= 0.02) continue;
      const majeur = MAJEURS.has(v.type);
      const a = v.dim * v.brume * Math.min(1, v.vis) * ga * (0.35 + 0.65 * Math.max(v.vie, v.wOff * 0.6, v.wInc * 0.4, v.wEt * 0.3));
      if (a < 0.01) continue;
      const c = v.wOff > 0.5 ? C_ROUGE : v.vie > 0.1 ? v.haloA : C_GRIS;
      const rr = Math.max(1.2, (RAYON[v.type] || 7) * v.bs * (majeur ? 1.9 : 1.5));
      const sprite = lueur("halo", c, rr * 4.4);
      if (sprite) { ctx.globalAlpha = a * (majeur ? 0.22 : 0.12); ctx.drawImage(sprite, v.bx - rr * 2.2, v.by - rr * 2.2 * sp, rr * 4.4, rr * 4.4 * sp); }
      if (v.type === "site") continue;
      ctx.strokeStyle = rgb(c);
      ctx.lineWidth = majeur ? 1 : 0.7;
      ctx.globalAlpha = a * (majeur ? 0.16 : 0.07);
      ctx.beginPath(); ctx.moveTo(v.bx, v.by); ctx.lineTo(v.sx, v.sy + v.r * 0.6); ctx.stroke();
      if (majeur) {
        // de près, l'ellipse au sol s'efface : repère de profondeur en vue d'ensemble, pas un cerceau géant
        ctx.globalAlpha = a * 0.22 / (1 + Math.max(0, v.bs - 1.1));
        ctx.beginPath(); ctx.ellipse(v.bx, v.by, rr, Math.max(0.3, rr * sp), 0, 0, TAU); ctx.stroke();
      }
    }
  }

  _dessinerOndes(ctx, camera) {
    const T = this.T;
    for (const o of this._ondes) {
      if (!o.actif) continue;
      const u = (T - o.t0) / o.d;
      if (u < 0 || u > 1) continue;
      const R = Math.max(0.1, o.R * sortieCubique(u));
      ctx.strokeStyle = rgb(o.col);
      ctx.lineWidth = 2.4 * (1 - u) + 0.4;
      ctx.globalAlpha = Math.pow(1 - u, 2) * 0.5;
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * TAU;
        camera.projeter(o.x + Math.cos(a) * R, o.y + Math.sin(a) * R, o.z, PROJ);
        if (i) ctx.lineTo(PROJ.sx, PROJ.sy); else ctx.moveTo(PROJ.sx, PROJ.sy);
      }
      ctx.stroke();
      ctx.globalAlpha *= 0.25;
      ctx.lineWidth = 7 * (1 - u) + 1;
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------- axones */

  _chemin(ctx, geo, t0, t1) {
    const N = geo.n;
    pointSurLien(geo, t0, 0, PA);
    ctx.moveTo(PA.x, PA.y);
    const i0 = Math.ceil(t0 * N), i1 = Math.floor(t1 * N);
    for (let i = i0; i <= i1; i++) ctx.lineTo(geo.px[i], geo.py[i]);
    pointSurLien(geo, t1, 0, PA);
    ctx.lineTo(PA.x, PA.y);
  }

  _dessinerLiens(ctx) {
    const T = this.T, calme = this.calme;
    for (const lv of this._liens.values()) {
      if (lv.reveal <= 0) continue;
      const a = lv.a, b = lv.b, geo = lv.geo;
      if (a.vis <= 0 && b.vis <= 0) continue;
      if (!a.visible && !b.visible) continue;
      // l'axone part de la membrane, pas du centre : les carrefours (pve, ~30 axones) ne virent pas au blanc
      const t0 = Math.max(lv.sortant ? 0 : 1 - lv.reveal, geo.coupeA), t1 = Math.min(lv.sortant ? lv.reveal : 1, 1 - geo.coupeB);
      if (t1 <= t0) continue;
      const fondu = (lv.retrait ? Math.max(0, 1 - (T - lv.retrait) / 0.6) : 1) * Math.min(a.vis > 0 ? 1 : 0.3, b.vis > 0 ? 1 : 0.3);
      const dim = lv.dim * fondu * Math.min(a.brume, b.brume) * Math.max(0.35, Math.min(a.dim, b.dim) * 1.2);
      if (dim < 0.01) continue;
      const ksc = borne(geo.s / 0.6, 0.4, 1.45);
      const r = Math.max(lv.rf, lv.rr), hl = lv.hl;
      const tete = lv.reveal < 1 ? (lv.sortant ? t1 : t0) : -1;

      if (lv.l.type === "usb") {
        const c = melanger(C_USB, AMB_ANNEAU, this.A, [0, 0, 0]);
        ctx.setLineDash([0.1, 4.2 * ksc]);
        ctx.lineDashOffset = calme ? 0 : -T * (10 + this.A * 30);
        ctx.lineWidth = 1.6 * ksc; ctx.strokeStyle = rgb(c);
        ctx.globalAlpha = (0.5 + 0.3 * hl) * dim * Math.max(0.3, lv.wOn);
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
        if (!calme && lv.reveal >= 1) {
          // sondage NUT : un petit point remonte de l'onduleur vers PVE
          const per = this.A > 0.5 ? 0.6 : 2.2, u = (T % per) / per;
          pointSurLien(geo, lv.sortant ? 1 - u : u, 0, PA);
          const sp = lueur("tete", c, 8);
          if (sp) { const rr = 3.4 * ksc; ctx.globalAlpha = 0.7 * dim * Math.sin(u * Math.PI); ctx.drawImage(sp, PA.x - rr, PA.y - rr, rr * 2, rr * 2); }
        }
        continue;
      }
      // éteint exprès : pointillé gris très discret
      if (lv.wEt > 0.01) {
        ctx.setLineDash([3 * ksc, 5 * ksc]); ctx.lineWidth = 0.9 * ksc; ctx.strokeStyle = rgb(C_GRIS);
        ctx.globalAlpha = 0.5 * lv.wEt * dim;
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1); ctx.stroke(); ctx.setLineDash([]);
      }
      // inconnu : pointillé bleu-gris qui glisse lentement
      if (lv.wInc > 0.01) {
        ctx.setLineDash([1, 4.5 * ksc]); ctx.lineDashOffset = calme ? 0 : -T * 4;
        ctx.lineWidth = 1.3 * ksc; ctx.strokeStyle = rgb(C_INCONNU);
        ctx.globalAlpha = 0.6 * lv.wInc * dim;
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      // panne : axone rouge qui pulse au rythme du cœur de l'enfant
      if (lv.wOff > 0.01) {
        const enfant = lv.sortant ? b : a;
        const hb = calme ? 0.5 : battement(T * 0.42 + enfant.ph);
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1);
        ctx.strokeStyle = rgb(C_ROUGE);
        ctx.lineWidth = (4.5 + 3.5 * hb) * ksc; ctx.globalAlpha = (0.09 + 0.16 * hb) * lv.wOff * dim; ctx.stroke();
        ctx.lineWidth = 1.4 * ksc; ctx.globalAlpha = (0.42 + 0.45 * hb) * lv.wOff * dim; ctx.stroke();
        if (!calme && lv.reveal >= 1) {
          // un signal rouge descend vers l'élément tombé
          const u = ((T * 0.55 + lv.ph) % 1);
          pointSurLien(geo, lv.sortant ? u : 1 - u, 0, PA);
          const sp = lueur("tete", C_ROUGE, 10);
          if (sp) { const rr = 4.5 * ksc; ctx.globalAlpha = 0.8 * lv.wOff * dim * Math.sin(u * Math.PI); ctx.drawImage(sp, PA.x - rr, PA.y - rr, rr * 2, rr * 2); }
        }
      }
      // connexion perdue : l'axone MikroTik ↔ PVE bat en rouge, vite
      if (lv.wPerdu > 0.01) {
        const hb = calme ? 0.5 : battement(T * 0.8);
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1);
        ctx.strokeStyle = rgb(C_ROUGE);
        ctx.lineWidth = (5 + 4 * hb) * ksc; ctx.globalAlpha = (0.08 + 0.16 * hb) * lv.wPerdu * dim; ctx.stroke();
        ctx.lineWidth = 1.4 * ksc; ctx.globalAlpha = (0.4 + 0.45 * hb) * lv.wPerdu * dim; ctx.stroke();
      }
      // éteint ou mort pendant le fondu : trace grise
      const vie = lv.lumiere;
      if (vie < 0.99 && lv.wOn > 0.01) {
        ctx.setLineDash([3 * ksc, 5 * ksc]); ctx.lineWidth = 1 * ksc; ctx.strokeStyle = rgb(C_MORT);
        ctx.globalAlpha = (1 - vie) * 0.45 * dim * lv.wOn;
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1); ctx.stroke(); ctx.setLineDash([]);
      }
      if (vie > 0.01) {
        const boost = 1 + hl * 1.4;
        const halo = melanger(lv.halo, AMB_HALO, this.A * 0.5, PB_COUL), coeur = melanger(lv.coeur, AMB_ANNEAU, this.A * 0.5, PB_COUL2);
        ctx.beginPath(); this._chemin(ctx, geo, t0, t1);
        ctx.strokeStyle = rgb(halo); ctx.lineWidth = (3.5 + 7 * r) * ksc;
        ctx.globalAlpha = (0.035 + 0.07 * r) * vie * dim * boost; ctx.stroke();
        ctx.strokeStyle = rgb(coeur); ctx.lineWidth = (0.7 + 1.4 * r) * Math.min(ksc, 1.6);
        ctx.globalAlpha = (0.16 + 0.3 * r) * vie * dim * boost; ctx.stroke();
        if (r > 0.55) { ctx.strokeStyle = rgb(geo.cDesc); ctx.lineWidth = (1.6 + 3 * r) * Math.min(ksc, 1.6); ctx.globalAlpha = (r - 0.55) * 0.55 * vie * dim; ctx.stroke(); }
        if (hl > 0.02) { ctx.strokeStyle = rgb(geo.cDesc); ctx.lineWidth = 1.2 * Math.min(ksc, 1.6); ctx.globalAlpha = 0.4 * hl * vie; ctx.stroke(); }
      }
      if (tete >= 0) {
        // l'axone pousse : une tête lumineuse trace le chemin
        pointSurLien(geo, tete, 0, PA);
        const sp = lueur("tete", vie > 0.01 || lv.etat === "on" ? geo.cDesc : lv.etat === "off" ? C_ROUGE : C_GRIS, 24);
        if (sp) { const rr = 9 * Math.min(ksc, 1.6); ctx.globalAlpha = 0.95 * fondu; ctx.drawImage(sp, PA.x - rr, PA.y - rr, rr * 2, rr * 2); }
      }
      if ((lv.l.type === "wan" || lv.id === "mikrotik>box") && this._surge > 0.05 && !calme && vie > 0.5) this._eclair(ctx, lv, ksc);
    }
  }

  _eclair(ctx, lv, ksc) {
    const geo = lv.geo, amp = 10 * this._surge * ksc;
    for (let passe = 0; passe < 2; passe++) {
      const J = passe ? lv.jag2 : lv.jag;
      ctx.beginPath();
      for (let i = 0; i <= N_SEG; i++) {
        const u = i / N_SEG, o = J[i] * amp * Math.sin(Math.PI * u);
        pointSurLien(geo, u, o, PA);
        if (i) ctx.lineTo(PA.x, PA.y); else ctx.moveTo(PA.x, PA.y);
      }
      ctx.strokeStyle = rgb(lv.halo); ctx.lineWidth = 5 * ksc; ctx.globalAlpha = 0.12 * this._surge * lv.dim; ctx.stroke();
      ctx.strokeStyle = passe ? rgb(geo.cDesc) : "#ffffff"; ctx.lineWidth = (passe ? 0.8 : 1.2) * ksc;
      ctx.globalAlpha = (passe ? 0.35 : 0.6) * this._surge * lv.dim; ctx.stroke();
    }
  }

  _dessinerCometes(ctx) {
    const T = this.T;
    const th = this._pensee;
    if (th) {
      const s = th.segs[th.i];
      if (s) {
        pointSurLien(s.lv.geo, s.dir > 0 ? th.u : 1 - th.u, 0, PA);
        const tr = th.trace;
        if (th.nt >= tr.length) { tr.copyWithin(0, 2); th.nt -= 2; }
        tr[th.nt++] = PA.x; tr[th.nt++] = PA.y;
        if (th.nt >= 4) {
          ctx.beginPath(); ctx.moveTo(tr[0], tr[1]);
          for (let i = 2; i < th.nt; i += 2) ctx.lineTo(tr[i], tr[i + 1]);
          ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.globalAlpha = 0.65; ctx.stroke();
          ctx.strokeStyle = rgb(this._cDesc); ctx.lineWidth = 6; ctx.globalAlpha = 0.18; ctx.stroke();
        }
        const ksc = borne(s.lv.geo.s / 0.6, 0.5, 1.8);
        const sb = lueur("tete", BLANC, 22 * ksc), sh = lueur("halo", s.vers.soma, 68 * ksc);
        if (sb) { const r = 11 * ksc; ctx.globalAlpha = 1; ctx.drawImage(sb, PA.x - r, PA.y - r, r * 2, r * 2); }
        if (sh) { const r = 34 * ksc; ctx.globalAlpha = 0.7; ctx.drawImage(sh, PA.x - r, PA.y - r, r * 2, r * 2); }
      }
    }
    // comètes : tête brillante + traînée le long de l'axone, accélère en chemin
    for (const c of this._cometes) {
      if (!c.actif || T < c.t0) continue;
      const geo = c.lv.geo, ksc = borne(geo.s / 0.6, 0.5, 1.8);
      const lin = borne((T - c.t0) / c.duree, 0, 1);
      const u = lin * (0.55 + 0.45 * lin);
      const spH = lueur("tete", c.col, 9 * c.taille * ksc), spW = lueur("tete", BLANC, 14 * c.taille * ksc), spG = lueur("halo", c.col, 52 * c.taille * ksc);
      if (!spH) continue;
      const tl = 0.22;
      for (let j = 7; j >= 0; j--) {
        const uu = u - (tl * j) / 7;
        if (uu < 0) continue;
        pointSurLien(geo, c.dir > 0 ? uu : 1 - uu, 0, PA);
        const f = 1 - j / 8, r = (j ? 4.2 : 7) * c.taille * f * ksc;
        ctx.globalAlpha = (j ? 0.55 : 1) * f;
        ctx.drawImage(j ? spH : spW, PA.x - r, PA.y - r, r * 2, r * 2);
      }
      pointSurLien(geo, c.dir > 0 ? u : 1 - u, 0, PA);
      const r = 26 * c.taille * ksc;
      ctx.globalAlpha = 0.55; ctx.drawImage(spG, PA.x - r, PA.y - r, r * 2, r * 2);
    }
  }

  /* ---------------------------------------------------------------- neurones */

  _dendrites(ctx, v, x, y, r, pousse, alpha, col, bouts, ux, uy, vx, vy) {
    const D = v.dendrites;
    if (!D.length || alpha < 0.01) return;
    ctx.globalAlpha = alpha; ctx.strokeStyle = rgb(col); ctx.lineWidth = Math.max(0.3, r * 0.1);
    ctx.beginPath();
    const T = this.T, calme = this.calme;
    let nb = 0;
    for (const d of D) {
      const a = d.a + (calme ? 0 : Math.sin(T * 0.6 + d.ph) * 0.07);
      const L = r * d.l * pousse;
      // direction posée dans le plan du sol : les dendrites tournent et s'aplatissent avec la caméra
      const ca = Math.cos(a), sa = Math.sin(a);
      const ex = ca * ux + sa * vx, ey = ca * uy + sa * vy;
      const ab = a + d.courbe * 0.5, cb = Math.cos(ab), sb = Math.sin(ab);
      const fx = cb * ux + sb * vx, fy = cb * uy + sb * vy;
      const x0 = x + ex * r * 0.85, y0 = y + ey * r * 0.85, x1 = x + ex * (r + L), y1 = y + ey * (r + L);
      const mr = r + L * 0.5, cx = x + fx * mr, cy = y + fy * mr;
      ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1);
      if (d.fourche) {
        const ft = d.fourche.a, it = 1 - ft;
        const qx = it * it * x0 + 2 * it * ft * cx + ft * ft * x1, qy = it * it * y0 + 2 * it * ft * cy + ft * ft * y1;
        const fa = a + d.fourche.da, fl = L * d.fourche.l;
        ctx.moveTo(qx, qy); ctx.lineTo(qx + (Math.cos(fa) * ux + Math.sin(fa) * vx) * fl, qy + (Math.cos(fa) * uy + Math.sin(fa) * vy) * fl);
      }
      if (bouts && nb < BOUTS.length) { BOUTS[nb++] = x1; BOUTS[nb++] = y1; }
    }
    ctx.stroke();
    if (bouts) {
      const sp = lueur("tete", col, r * 0.64);
      if (sp) for (let i = 0; i < nb; i += 2) { const rr = r * 0.32; ctx.globalAlpha = alpha * 0.9; ctx.drawImage(sp, BOUTS[i] - rr, BOUTS[i + 1] - rr, rr * 2, rr * 2); }
    }
  }

  _arc(ctx, x, y, rad, frac, col, lw, a) {
    if (frac <= 0.002 || a <= 0.004 || rad <= 0.5) return;
    const f = Math.min(frac, 0.9995), s = -Math.PI / 2, e = s + TAU * f;
    ctx.strokeStyle = rgb(col);
    ctx.globalAlpha = a * 0.25; ctx.lineWidth = lw * 2.6; ctx.beginPath(); ctx.arc(x, y, rad, s, e); ctx.stroke();
    ctx.globalAlpha = a; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(x, y, rad, s, e); ctx.stroke();
    const sp = lueur("tete", col, lw * 6.8);
    if (sp) { const r = lw * 3.4; ctx.drawImage(sp, x + Math.cos(e) * rad - r, y + Math.sin(e) * rad - r, r * 2, r * 2); }
  }

  _piste(ctx, x, y, rad, lw, a, pointille) {
    if (a <= 0.004 || rad <= 0.5) return;
    ctx.globalAlpha = a; ctx.strokeStyle = "rgb(140,190,255)"; ctx.lineWidth = lw;
    if (pointille) ctx.setLineDash([0.5, 2.4]);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.stroke();
    if (pointille) ctx.setLineDash([]);
  }

  _dessinerNoeuds(ctx, camera) {
    const T = this.T, calme = this.calme, k = camera.k;
    const cyw = Math.cos(camera.yaw), syw = Math.sin(camera.yaw), sp = Math.sin(camera.pitch);
    // vecteurs écran des axes x et y du monde (dendrites posées sur la table)
    const ux = cyw, uy = syw * sp, vx = syw, vy = -cyw * sp;
    const zoomCt = sstep(1.05, 1.4, k / this._kVue);
    // tri par profondeur (du fond vers l'avant), tableau réutilisé
    const tri = this._tri;
    tri.length = 0;
    for (const v of this._ordre) if (v.visible) tri.push(v);
    tri.sort(parProfondeur);
    const brune = this._brune > 0 ? 1 - this._brune * 0.85 * this._vacille : 1;
    for (const v of tri) {
      const x = v.sx, y = v.sy, r = v.r;
      const vie = v.vieV * brune * (1 - 0.75 * v.wPerdu);
      const dim = v.dim * v.brume * (v.retrait ? v.vis : 1);
      const respir = calme ? 1 : 1 + 0.06 * Math.sin(T * 1.25 + v.ph);
      const fl = v.flash * (1 - 0.85 * v.wPerdu);
      const onduleur = v.type === "onduleur", surBat = onduleur && this.A > 0.02;
      let hb = 0;
      if (surBat) hb = calme ? 0.5 : Math.pow(Math.max(0, Math.sin(T * TAU * 1.05)), 10) + 0.6 * Math.pow(Math.max(0, Math.sin(T * TAU * 1.05 - 0.7)), 10);
      // dendrites
      if (v.dendrites.length) {
        const dc = melanger(C_MORT, v.dendA, vie, PB_COUL);
        const pousse = (0.3 + 0.7 * v.vie) * sortieCubique(v.retrait ? v.vis : v.born) * (1 + 0.12 * v.ret);
        this._dendrites(ctx, v, x, y, r, pousse, (0.12 + 0.3 * vie + fl * 0.25 + 0.2 * v.ret) * dim * Math.min(1, v.vis) * (1 - 0.6 * v.wInc),
          dc, vie > 0.3 && v.type !== "ct" && v.type !== "vm" && v.type !== "appareil", ux, uy, vx, vy);
      }
      // panne : cœur rouge sang qui bat lentement
      if (v.wOff > 0.01) {
        const hbo = calme ? 0.5 : 0.25 + 0.75 * battement(T * 0.42 + v.ph);
        ctx.globalAlpha = 0.5 * v.wOff * dim; ctx.fillStyle = rgb(C_MORT);
        ctx.beginPath(); ctx.arc(x, y, r * 0.95, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.6 * v.wOff * dim; ctx.strokeStyle = "rgb(110,120,138)"; ctx.lineWidth = Math.max(0.3, r * 0.1);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        // rouge visible au premier coup d'œil, même pour un petit CT vu de loin
        const g = lueur("halo", C_ROUGE, Math.max(r * 9, 30)), c = lueur("coeur", C_ROUGE, Math.max(r * 2.6, 10));
        if (g) { const R = Math.max(r * (4.6 + 1.8 * hbo), 15 + 7 * hbo); ctx.globalAlpha = v.wOff * dim * (0.3 + 0.42 * hbo); ctx.drawImage(g, x - R, y - R, R * 2, R * 2); }
        if (c) { const R = Math.max(r * 1.3, 5); ctx.globalAlpha = v.wOff * dim * (0.55 + 0.45 * hbo); ctx.drawImage(c, x - R, y - R, R * 2, R * 2); }
        ctx.globalAlpha = v.wOff * dim * (0.25 + 0.5 * hbo); ctx.strokeStyle = rgb(C_ROUGE); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, Math.max(r * 1.75, 6) + 2 * hbo, 0, TAU); ctx.stroke();
      }
      // éteint exprès : soma gris, sans lueur
      if (v.wEt > 0.01) {
        ctx.globalAlpha = 0.3 * v.wEt * dim; ctx.fillStyle = rgb(C_GRIS);
        ctx.beginPath(); ctx.arc(x, y, r * 0.9, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.55 * v.wEt * dim; ctx.strokeStyle = "rgb(120,130,146)"; ctx.lineWidth = Math.max(0.3, r * 0.1);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
      }
      // inconnu : contour pointillé bleu-gris qui tourne lentement
      if (v.wInc > 0.01) {
        ctx.globalAlpha = 0.16 * v.wInc * dim; ctx.fillStyle = rgb(C_INCONNU);
        ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, TAU); ctx.fill();
        ctx.setLineDash([Math.max(1, r * 0.35), Math.max(1.5, r * 0.4)]);
        ctx.lineDashOffset = calme ? 0 : -T * r * 0.6;
        ctx.globalAlpha = 0.85 * v.wInc * dim; ctx.strokeStyle = rgb(C_INCONNU); ctx.lineWidth = Math.max(0.6, r * 0.14);
        ctx.beginPath(); ctx.arc(x, y, r * 1.12, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      // vivant : halo, membrane, noyau
      if (vie > 0.01) {
        // un carrefour (pve, ~30 axones) garde un halo plus sobre : sinon il vire au blanc et noie son étiquette
        const sobre = 0.5 + 0.5 * v.moyeu;
        // de très près, la lueur ne mange pas l'écran (plafond en pixels) : on lit toujours l'étiquette
        const gR = Math.min(r * (4.6 * sobre + 0.6 + fl * 2.4 + hb * 3) * respir * (v.type === "site" ? 0.8 : 1), 70 + r * 1.6);
        const g = lueur("halo", v.haloA, gR * 2), c = lueur("coeur", v.somaA, r * 3.7);
        if (g) { ctx.globalAlpha = Math.min(1, (0.42 * vie * sobre + fl * 0.32 + hb * 0.4) * dim); ctx.drawImage(g, x - gR, y - gR, gR * 2, gR * 2); }
        ctx.globalAlpha = Math.min(1, (0.5 * vie + fl * 0.2) * dim); ctx.strokeStyle = rgb(v.somaA); ctx.lineWidth = Math.max(0.25, r * 0.11);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        if (c) { const R = r * ((1.85 - 0.45 * (1 - v.moyeu)) + fl * 0.6 + hb * 0.5); ctx.globalAlpha = Math.min(1, (0.82 * vie + fl * 0.3) * dim); ctx.drawImage(c, x - R, y - R, R * 2, R * 2); }
      }
      // anneaux d'allumage
      for (let i = 0; i < 4; i++) {
        const age = T - v.anneaux[i];
        if (age < 0 || age > 1.3) continue;
        const u = age / 1.3;
        ctx.globalAlpha = Math.pow(1 - u, 2) * 0.7 * dim;
        ctx.strokeStyle = rgb(v.etat === "on" ? this._cDesc : v.etat === "off" ? C_ROUGE : [150, 160, 176]);
        ctx.lineWidth = 1.4 * (1 - u) + 0.3;
        ctx.beginPath(); ctx.arc(x, y, r * (1.2 + sortieCubique(u) * 5), 0, TAU); ctx.stroke();
      }
      // connexion perdue : PVE et MikroTik battent en rouge par-dessus leur dernier état connu
      if (v.wPerdu > 0.01) {
        const hbo = calme ? 0.6 : 0.3 + 0.7 * battement(T * 0.8 + v.ph * 0.1);
        const g = lueur("halo", C_ROUGE, r * 8.4), c = lueur("coeur", C_ROUGE, r * 2.6);
        if (g) { const R = r * (4.2 + 1.6 * hbo); ctx.globalAlpha = v.wPerdu * (0.25 + 0.45 * hbo); ctx.drawImage(g, x - R, y - R, R * 2, R * 2); }
        if (c) { const R = r * (1.3 + 0.4 * hbo); ctx.globalAlpha = v.wPerdu * (0.5 + 0.5 * hbo); ctx.drawImage(c, x - R, y - R, R * 2, R * 2); }
        ctx.globalAlpha = v.wPerdu * (0.35 + 0.5 * hbo); ctx.strokeStyle = rgb(C_ROUGE); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, r * (1.5 + 0.5 * hbo), 0, TAU); ctx.stroke();
      }
      // implosion à la panne : un anneau rouge se referme sur le soma
      const da = T - v.mortT;
      if (da >= 0 && da < 0.85) {
        const u = da / 0.85, e = u * u * u;
        ctx.globalAlpha = Math.sin(Math.PI * u) * 0.75 * dim; ctx.strokeStyle = rgb(C_ROUGE); ctx.lineWidth = 0.6 + 1.6 * u;
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r * (5.5 - 4.6 * e)), 0, TAU); ctx.stroke();
        const c = lueur("coeur", C_ROUGE, r * 6);
        if (u > 0.8 && c) { const R = r * 3 * (1 - u) * 5; ctx.globalAlpha = Math.min(1, (1 - u) * 5 * dim); ctx.drawImage(c, x - R, y - R, R * 2, R * 2); }
      }
      // recherche : sonar
      if (this.correspondances && this.correspondances.has(v.id)) {
        // deux ondes décalées + une lueur qui bat : on repère le résultat d'un coup d'œil
        const rs = Math.max(r, 4), sg = lueur("halo", this._cDesc, rs * 10);
        ctx.strokeStyle = rgb(this._cDesc); ctx.lineWidth = 1.6;
        for (let k = 0; k < 2; k++) {
          const u = calme ? 0.35 + 0.3 * k : (T * 0.62 + v.ph * 0.16 + k * 0.5) % 1;
          ctx.globalAlpha = Math.pow(1 - u, 1.5) * 0.95;
          ctx.beginPath(); ctx.arc(x, y, rs * 1.6 * (1.05 + u * 2.6) + 4, 0, TAU); ctx.stroke();
        }
        if (sg) { const R = rs * 5, b = calme ? 0.5 : 0.5 + 0.5 * Math.sin(T * 4); ctx.globalAlpha = 0.25 + 0.25 * b; ctx.drawImage(sg, x - R, y - R, R * 2, R * 2); }
      }
      // réticule de survol / sélection : quatre arcs qui se resserrent et tournent
      if (v.ret > 0.01) {
        const e = sortieCubique(borne(v.ret, 0, 1)), rr = r * 1.6 * lerp(2.1, 1.32, e) + 4;
        const rot = calme ? 0.4 : T * 0.9 + v.ph, gap = 0.36;
        ctx.strokeStyle = rgb(v.etat === "off" ? [255, 120, 140] : v.somaA); ctx.lineWidth = 1.1; ctx.globalAlpha = 0.85 * v.ret;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a0 = rot + (i * Math.PI) / 2 + gap, a1 = rot + ((i + 1) * Math.PI) / 2 - gap;
          ctx.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr); ctx.arc(x, y, rr, a0, a1);
        }
        ctx.stroke();
        if (v.id === this._selection) {
          const b = calme ? 0.5 : 0.5 + 0.5 * Math.sin(T * 2.2);
          ctx.globalAlpha = (0.18 + 0.2 * b) * v.ret; ctx.lineWidth = 0.8; ctx.setLineDash([1.5, 5]); ctx.lineDashOffset = calme ? 0 : T * 8;
          ctx.beginPath(); ctx.arc(x, y, rr + 5 + b * 2, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
      }
      // décorations et jauges par type
      const ga = sstep(0.4, 1, v.retrait ? v.vis : v.born) * dim;
      if (ga > 0) this._decorations(ctx, v, x, y, r, vie, ga, zoomCt);
    }
    // impacts : petit anneau à l'arrivée d'une impulsion forte
    for (const im of this._impacts) {
      if (!im.actif) continue;
      const u = (T - im.t0) / 0.55, v = im.v;
      if (u < 0 || u > 1 || !v.visible) continue;
      ctx.globalAlpha = (1 - u) * 0.6 * v.dim; ctx.strokeStyle = rgb(im.col); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(v.sx, v.sy, v.r * (1.1 + u * 2.4), 0, TAU); ctx.stroke();
    }
  }

  _decorations(ctx, v, x, y, r, vie, ga, zoomCt) {
    const T = this.T, calme = this.calme, t = v.type, g = v.g;
    const cpuCol = (c) => melanger(v.anneauA, C_CHAUD, sstep(0.72, 0.95, c), PB_COUL2);
    if (t === "routeur") {
      ctx.globalAlpha = 0.3 * ga * (0.3 + 0.7 * vie); ctx.strokeStyle = rgb(v.anneauA); ctx.lineWidth = 0.7;
      ctx.setLineDash([2, 4]); ctx.lineDashOffset = calme ? 0 : -T * 6;
      ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      const sa = calme ? 0.6 : T * 0.7, s1 = lueur("tete", v.somaA, 8), s2 = lueur("tete", v.haloA, 8);
      if (s1 && s2) {
        ctx.globalAlpha = 0.9 * ga * vie;
        ctx.drawImage(s1, x + Math.cos(sa) * r * 2.1 - 3.2, y + Math.sin(sa) * r * 2.1 - 3.2, 6.4, 6.4);
        ctx.drawImage(s2, x + Math.cos(sa + Math.PI) * r * 2.1 - 3.2, y + Math.sin(sa + Math.PI) * r * 2.1 - 3.2, 6.4, 6.4);
      }
      this._piste(ctx, x, y, r * 1.5, 1.6, 0.1 * ga, false);
      this._arc(ctx, x, y, r * 1.5, g.cpu, cpuCol(g.cpu), 1.6, 0.9 * ga * vie);
    } else if (t === "internet") {
      ctx.strokeStyle = rgb(v.somaA); ctx.lineWidth = 0.6;
      for (let i = 0; i < 3; i++) {
        const ph = (calme ? 0.4 : T * 0.35) + (i * Math.PI) / 3;
        ctx.globalAlpha = 0.35 * ga * vie;
        ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, r * 1.05 * Math.abs(Math.cos(ph))), r * 1.05, 0, 0, TAU); ctx.stroke();
      }
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.05, r * 0.32, 0, 0, TAU); ctx.stroke();
      const sg = lueur("halo", v.somaA);
      if (this._surge > 0.02 && sg) { const R = r * (6 + 6 * this._surge); ctx.globalAlpha = 0.5 * this._surge; ctx.drawImage(sg, x - R, y - R, R * 2, R * 2); }
    } else if (t === "hyperviseur") {
      this._piste(ctx, x, y, r + 5 * v.s + 2, 2.4, 0.16 * ga, true);
      this._piste(ctx, x, y, r + 10 * v.s + 3, 2.4, 0.16 * ga, true);
      this._arc(ctx, x, y, r + 5 * v.s + 2, g.cpu, cpuCol(g.cpu), 2.2, 0.95 * ga * vie);
      this._arc(ctx, x, y, r + 10 * v.s + 3, g.ram, v.haloA, 2.2, 0.95 * ga * vie);
    } else if (t === "sauvegarde" || t === "nas" || t === "nas-vm") {
      const rr = r + 5 * v.s + 2;
      this._piste(ctx, x, y, rr, 2, 0.16 * ga, true);
      const c = melanger(v.anneauA, g.disque > 0.9 ? C_CHAUD : [150, 255, 230], g.disque > 0.9 ? 0.7 : 0.25 * (1 - this.A), PB_COUL2);
      this._arc(ctx, x, y, rr, g.disque, c, 2, 0.95 * ga * Math.max(0.25, vie));
      if (t === "nas-vm" && (zoomCt > 0.01 || v.ret > 0.05)) this._arc(ctx, x, y, rr + 4, g.cpu, cpuCol(g.cpu), 1.1, 0.8 * Math.max(zoomCt, v.ret) * ga * vie);
    } else if (t === "onduleur") {
      const bc = g.bat < 0.25 ? C_ROUGE : v.anneauA;
      const rr = r + 5 * v.s + 2;
      this._piste(ctx, x, y, rr, 2, 0.16 * ga, false);
      this._arc(ctx, x, y, rr, g.bat, bc, 2, 0.95 * ga);
      // pochoir : éclair (secteur) ou batterie qui se vide
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.85 * ga * Math.max(0.3, vie); ctx.fillStyle = "#01040a";
      const s = r * 0.55;
      ctx.beginPath();
      if (this.A < 0.5) {
        ctx.moveTo(x + 0.15 * s, y - s); ctx.lineTo(x - 0.5 * s, y + 0.12 * s); ctx.lineTo(x - 0.02 * s, y + 0.12 * s);
        ctx.lineTo(x - 0.18 * s, y + s); ctx.lineTo(x + 0.5 * s, y - 0.12 * s); ctx.lineTo(x + 0.02 * s, y - 0.12 * s); ctx.closePath(); ctx.fill();
      } else {
        ctx.rect(x - 0.8 * s, y - 0.42 * s, 1.45 * s, 0.84 * s); ctx.rect(x + 0.65 * s, y - 0.18 * s, 0.17 * s, 0.36 * s); ctx.fill();
        ctx.globalAlpha = 0.9 * ga; ctx.fillStyle = rgb(AMB_ANNEAU);
        ctx.fillRect(x - 0.66 * s, y - 0.28 * s, 1.17 * s * borne(g.bat, 0, 1), 0.56 * s);
      }
      ctx.globalCompositeOperation = "lighter";
    } else if ((t === "ct" || t === "vm") && (zoomCt > 0.01 || v.ret > 0.05)) {
      const za = Math.max(zoomCt, v.ret) * ga * vie;
      this._arc(ctx, x, y, r + 2.6 * Math.max(0.6, v.s), g.cpu, cpuCol(g.cpu), 1.1, 0.9 * za);
      this._arc(ctx, x, y, r + 4.8 * Math.max(0.6, v.s), g.ram, v.haloA, 1.1, 0.8 * za);
    }
  }

  _dessinerEtincelles(ctx, camera) {
    const E = this._et, T = this.T;
    for (let i = 0; i < E.n; i++) {
      const u = (T - E.t0[i]) / E.d[i];
      if (u < 0 || u > 1 || !E.sp[i]) continue;
      camera.projeter(E.x[i], E.y[i], E.z[i], PROJ);
      const r = E.sz[i] * (1 - u * 0.5) * borne(PROJ.s, 0.4, 2.4) + 0.4;
      ctx.globalAlpha = Math.pow(1 - u, 1.6) * 0.9;
      ctx.drawImage(E.sp[i], PROJ.sx - r, PROJ.sy - r, r * 2, r * 2);
    }
  }

  /* ---------------------------------------------------------------- étiquettes (zoom sémantique) */

  _texteJauge(v) {
    const n = v.n, j = n.jauges || {};
    if (v.etat !== "on") return "";
    switch (v.type) {
      case "routeur": {
        const w = this._liens.get("mikrotik>box");
        return `CPU ${fmtPct(j.cpu)}${w ? ` · WAN ↓${NB}${fmtDebit(w.l.montant)}` : ""}`;
      }
      case "internet": {
        const w = this._liens.get("mikrotik>box");
        return w ? `↓${NB}${fmtDebit(w.l.montant)} · ↑${NB}${fmtDebit(w.l.descendant)}` : "";
      }
      case "hyperviseur": return [fini(j.cpu) ? `CPU ${fmtPct(j.cpu)}` : "", fmtRam(j.ram)].filter(Boolean).join(" · ");
      case "sauvegarde": case "nas": case "nas-vm": return fmtStockage(j.disque);
      case "onduleur":
        if (j.secteur === false) return `Batterie ${fmtPct((j.batterie || 0) / 100)}${fini(j.autonomie) ? ` · ${fmtDuree(j.autonomie)}` : ""}`;
        return `Secteur · ${fmtPct((fini(j.batterie) ? j.batterie : 0) / 100)}${fini(j.tension) ? ` · ${NF0.format(j.tension)}${NB}V` : ""}`;
      case "pc": { const l = v.lienParent; return l ? `↓${NB}${fmtDebit(l.l.descendant)}` : ""; }
      default: return "";
    }
  }

  _texteEtat(v) {
    if (v.wPerdu > 0.5) return "connexion perdue";
    if (v.etat === "off") return "en panne";
    if (v.etat === "eteint") return "éteint";
    if (v.etat === "inconnu") return "état inconnu";
    return "";
  }

  /** Lignes de détail d'un CT/VM (zoom proche), ajoutées à `out` par ordre d'importance. */
  _lignesDetail(v, out) {
    const n = v.n, j = n.jauges || {}, d = n.details || {};
    const vmid = fini(Number(d.vmid)) ? Number(d.vmid) : (/^(?:ct|vm)-(\d+)$/.exec(v.id) || [])[1];
    if (v.etat === "on") {
      const g = [fini(j.cpu) ? `CPU ${fmtPct(j.cpu)}` : "", fmtRam(j.ram)].filter(Boolean).join(" · ");
      if (g) out.push(g);
    }
    out.push(`${v.type === "ct" ? "CT" : "VM"}${vmid !== undefined ? " " + vmid : ""}${n.ip ? " · " + n.ip : ""}`);
    if (v.etat === "on") {
      const l = v.lienParent;
      if (l && (fini(l.l.descendant) || fini(l.l.montant))) out.push(`↓${NB}${fmtDebit(l.l.descendant)} · ↑${NB}${fmtDebit(l.l.montant)}`);
      if (fini(d.uptime) && d.uptime > 0) out.push(`en ligne depuis ${fmtDuree(d.uptime)}`);
    }
    return out;
  }

  /** Rayon encombrant d'un nœud à l'écran (soma + jauges et décorations) : les étiquettes passent au-delà. */
  _rayonEcran(v) {
    const t = v.type, r = v.r;
    if (t === "routeur") return r * 2.15 + 2;
    if (t === "hyperviseur") return r + 10 * v.s + 6;
    if (t === "sauvegarde" || t === "nas" || t === "nas-vm" || t === "onduleur") return r + 5 * v.s + 5;
    if (t === "internet") return r * 1.3 + 2;
    return Math.max(r + 2, 3.5);
  }

  /** Largeur (px) d'un texte dans une police, mesurée une seule fois. */
  _largeur(ctx, police, texte) {
    const cle = police + "\u0001" + texte;
    let w = this._largeurs.get(cle);
    if (w === undefined) {
      if (this._largeurs.size > 3000) this._largeurs.clear();
      ctx.font = police;
      w = ctx.measureText(texte).width;
      this._largeurs.set(cle, w);
    }
    return w;
  }

  /**
   * Étiquettes face caméra, placées sans chevauchement (etiquettes.js) : chacune essaie d'abord le côté
   * opposé à son parent (vers l'extérieur), ne couvre aucun autre nœud, et se raccourcit (moins de lignes)
   * plutôt que de disparaître. Zoom sémantique relatif à la vue d'ensemble (`_kVue`).
   */
  _dessinerEtiquettes(ctx, camera, dt) {
    // pendant l'entrée, la caméra part de très près : on s'en tient aux noms (pas de détails qui défilent)
    const z = this._intro.fini ? camera.k / this._kVue : Math.min(1, camera.k / this._kVue);
    ctx.globalCompositeOperation = "source-over";
    ctx.textBaseline = "top"; ctx.lineJoin = "round";
    // vue d'ensemble : noms des machines et des CT ; en zoomant : IP, puis sites, puis détails des CT
    const aCt = sstep(0.42, 0.58, z), aApp = sstep(0.55, 0.75, z), aIp = sstep(0.8, 1, z);
    const aSite = sstep(1.2, 1.45, z), aDet = sstep(1.45, 1.7, z);
    const D = this._demandes, O = this._obstacles, V = this._dVisuels;
    D.length = 0; O.length = 0; V.length = 0;
    const ch = this._chaine;
    const sitesObstacles = aSite > 0.3;
    for (const v of this._ordre) {
      if (!v.visible || v.vis < 0.05 || v.retrait) { v.labV = Math.max(0, v.labV - dt * 6); continue; }
      const t = v.type, majeur = MAJEURS.has(t), site = t === "site", app = t === "appareil";
      const ob = v.obs;
      ob.x = v.sx; ob.y = v.sy; ob.r = this._rayonEcran(v);
      if (v.vis > 0.3 && (!site || sitesObstacles)) O.push(ob);
      const force = v.id === this._survol || v.id === this._selection || (ch && ch.has(v.id)) || (!!this.correspondances && this.correspondances.has(v.id));
      let a = majeur ? 1 : site ? aSite : app ? aApp : aCt;
      if (force) a = 1;
      a *= sstep(0.35, 1, v.born) * (0.18 + 0.82 * v.dim) * (0.6 + 0.4 * v.brume);
      v.labA = a;
      if (a < 0.02) { v.labV = Math.max(0, v.labV - dt * 6); continue; }
      // lignes par ordre d'importance : la variante k garde les nb premières
      const L = v.lab, lignes = L.lignes;
      lignes.length = 0;
      const etat = this._texteEtat(v);
      L.etat = etat;
      if (etat) lignes.push(etat);
      if (majeur) {
        const jg = this._texteJauge(v);
        if (jg) lignes.push(jg);
        if ((aIp > 0.02 || force) && v.n.ip) lignes.push(v.n.ip);
      } else if ((t === "ct" || t === "vm") && (aDet > 0.02 || force)) this._lignesDetail(v, lignes);
      L.nom = String(v.n.nom || v.id);
      L.majeur = majeur; L.site = site;
      const fNom = majeur ? F_MAJEUR : site ? F_SITE : F_CT, hNom = majeur ? H_MAJEUR : H_NOM;
      const wNom = this._largeur(ctx, fNom, L.nom);
      const vars = v.vars || (v.vars = [{ w: 0, h: 0, nb: 0 }, { w: 0, h: 0, nb: 0 }, { w: 0, h: 0, nb: 0 }, { w: 0, h: 0, nb: 0 }]);
      const dem = v.dem, vs = dem.variantes;
      vs.length = 0;
      const larg = this._lgTmp || (this._lgTmp = []);
      for (let i = 0; i < lignes.length; i++) larg[i] = this._largeur(ctx, F_PETIT, lignes[i]);
      let nbPrec = -1;
      for (const nb of NB_LIGNES(lignes.length)) {
        if (nb === nbPrec) continue;
        nbPrec = nb;
        let w = wNom;
        for (let i = 0; i < nb; i++) if (larg[i] > w) w = larg[i];
        const o = vars[vs.length];
        o.w = w + 4; o.h = hNom + nb * H_LIGNE + 2; o.nb = nb;
        vs.push(o);
      }
      // côté préféré, par pas de 45° : à l'opposé du parent (vers l'extérieur de l'anneau ou de l'éventail) ;
      // pour une grosse machine, le plus grand secteur libre entre ses axones (l'étiquette ne passe pas dessus)
      dem.prefere = null;
      const p = v.parentV;
      if (!majeur && p && p.visible) {
        dem.prefere = Math.round(Math.atan2(v.sy - p.sy, v.sx - p.sx) / (Math.PI / 4)) * (Math.PI / 4);
      } else if (majeur && v.voisins.length) {
        const A = this._angTmp || (this._angTmp = []);
        A.length = 0;
        for (const o of v.voisins) if (o.visible && !o.retrait && o.vis > 0.2) A.push(Math.atan2(o.sy - v.sy, o.sx - v.sx));
        if (A.length) {
          A.sort(croissant);
          let ecartMax = 0, centre = 0;
          for (let i = 0; i < A.length; i++) {
            const a0 = A[i], a1 = i + 1 < A.length ? A[i + 1] : A[0] + TAU;
            if (a1 - a0 > ecartMax) { ecartMax = a1 - a0; centre = (a0 + a1) / 2; }
          }
          if (ecartMax > 1) dem.prefere = Math.round(centre / (Math.PI / 4)) * (Math.PI / 4);
        }
      }
      const tier = v.id === this._survol ? 9 : v.id === this._selection ? 8 : force ? 7 : majeur ? 6 : (t === "ct" || t === "vm") ? 4 : app ? 3 : 2;
      dem.priorite = tier * 100000 + (RAYON[t] || 0) * 1000 - v.ordreI;
      dem.x = v.sx; dem.y = v.sy + (1 - sortieCubique(v.born)) * 10;
      dem.r = ob.r + v.ret * 3;
      D.push(dem); V.push(v);
    }
    const res = this._placeur.placer(D, O, this._zone, this._reserves);
    const kk = Math.min(1, dt * 12);
    for (let i = 0; i < res.length; i++) {
      const r = res[i], v = V[i], L = v.lab;
      if (r.visible) {
        const tx0 = r.x0 - v.sx, ty0 = r.y0 - v.sy, tx1 = r.x1 - v.sx;
        if (!L.ok || v.labV < 0.05) { L.x0 = tx0; L.y0 = ty0; L.x1 = tx1; }
        else { L.x0 += (tx0 - L.x0) * kk; L.y0 += (ty0 - L.y0) * kk; L.x1 += (tx1 - L.x1) * kk; }
        L.ok = true; L.aligne = r.aligne; L.nb = v.vars[r.variante].nb; L.h = v.vars[r.variante].h;
        v.labV += (1 - v.labV) * Math.min(1, dt * 7);
      } else {
        v.labV = Math.max(0, v.labV - dt * 9);
        if (v.labV <= 0) L.ok = false;
      }
    }
    // dessin
    const cDetail = "rgb(140,165,200)";
    ctx.strokeStyle = "rgba(1,4,10,0.88)"; ctx.lineWidth = 3;
    for (let i = 0; i < V.length; i++) {
      const v = V[i], L = v.lab, a = v.labA * v.labV;
      if (a < 0.02 || !L.ok) continue;
      const x0 = v.sx + L.x0, x1 = v.sx + L.x1, y0 = v.sy + L.y0;
      const xa = L.aligne === "left" ? x0 + 2 : L.aligne === "right" ? x1 - 2 : (x0 + x1) / 2;
      if (L.majeur) {
        // plaque sombre sous les grosses machines : lisibles même sur un faisceau d'axones ou une lueur
        ctx.globalAlpha = a * 0.5; ctx.fillStyle = "rgb(2,6,14)";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x0 - 3, y0 - 1, x1 - x0 + 6, (L.h || 16) + 2, 6); else ctx.rect(x0 - 3, y0 - 1, x1 - x0 + 6, (L.h || 16) + 2);
        ctx.fill();
      }
      ctx.textAlign = L.aligne;
      ctx.font = L.majeur ? F_MAJEUR : L.site ? F_SITE : F_CT;
      const pal = v.pal || PAL_DEFAUT;
      const coulNom = v.etat === "on" ? rgb(melanger(L.site ? pal.descendant : pal.nom, AMB_SOMA, this.A * 0.6, PB_COUL))
        : v.etat === "off" ? "rgb(255,150,162)" : "rgb(150,158,172)";
      this._txt(ctx, L.nom, xa, y0 + 1, coulNom, a);
      let y = y0 + 1 + (L.majeur ? H_MAJEUR : H_NOM);
      if (L.nb) ctx.font = F_PETIT;
      const nb = Math.min(L.nb, L.lignes.length);
      for (let k = 0; k < nb; k++) {
        const l = L.lignes[k];
        let coul = cDetail;
        if (l === L.etat) coul = v.etat === "off" || v.wPerdu > 0.5 ? "#ff5a72" : v.etat === "inconnu" ? "#8fa9c4" : "#8a95a3";
        else if (L.majeur && l !== v.n.ip) coul = v.type === "onduleur" && this.A > 0.5 ? "#ffc77d" : rgb(melanger(pal.anneau, AMB_ANNEAU, this.A, PB_COUL2));
        this._txt(ctx, l, xa, y, coul, a * 0.92);
        y += H_LIGNE;
      }
    }
  }

  _txt(ctx, s, x, y, col, a) {
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = col;
    ctx.fillText(s, x, y);
  }

  /* ---------------------------------------------------------------- DOM : teinte ambre, bandeau batterie */

  _dom() {
    if (typeof document === "undefined") return;
    const av = Math.round(this.A * 100) / 100;
    if (av !== this._alerteCss) {
      this._alerteCss = av;
      document.documentElement.style.setProperty("--alerte", av.toFixed(2));
    }
    const el = document.getElementById("bandeau");
    if (!el) return;
    const b = this._bandeau;
    const connexion = el.classList.contains("connexion");
    const ups = this._noeuds.get("onduleur");
    const j = ups && ups.n.jauges;
    if (this._surBatterie && !connexion) {
      const min = j && fini(j.autonomie) ? Math.max(0, Math.round(j.autonomie / 60)) : null;
      const texte = min === null ? "Sur batterie" : `Sur batterie – autonomie ${min}${NB}min`;
      if (!b.visible || texte !== b.texte) {
        b.texte = texte;
        el.replaceChildren();
        const fort = document.createElement("b");
        fort.textContent = "Sur batterie";
        el.append(fort);
        if (min !== null) {
          el.append(document.createTextNode(" – autonomie "));
          const m = document.createElement("span");
          m.className = "mono";
          m.textContent = `${min}${NB}min`;
          el.append(m);
        }
        el.classList.add("batterie");
        el.hidden = false;
        if (!b.visible) { b.visible = true; void el.offsetWidth; }
        el.classList.add("visible");
      }
    } else if (b.visible) {
      b.visible = false;
      b.texte = "";
      b.fin = this.T + 0.7;
      if (!connexion) el.classList.remove("visible");
    } else if (b.fin && this.T > b.fin) {
      b.fin = 0;
      if (!connexion && el.classList.contains("batterie")) { el.classList.remove("batterie"); el.hidden = true; el.replaceChildren(); }
      else el.classList.remove("batterie");
    }
  }
}

const BOUTS = new Float32Array(32);
const PAL_DEFAUT = palette([143, 168, 200]);
const croissant = (a, b) => a - b;
/** Variantes d'une étiquette à n lignes : toutes, deux, une, le nom seul (tableaux précalculés). */
const TABLE_LIGNES = Array.from({ length: 9 }, (_, n) => [n, Math.min(n, 2), Math.min(n, 1), 0]);
const NB_LIGNES = (n) => TABLE_LIGNES[Math.min(n, 8)];
const PB_COUL = [0, 0, 0], PB_COUL2 = [0, 0, 0];
const parProfondeur = (a, b) => b.p - a.p;
