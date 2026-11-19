// Interactions avec la carte :
//   - clic droit glissé = tourner (yaw) et incliner (pitch) la vue ;
//   - molette = zoom vers le curseur ; deux doigts = pincer pour zoomer et déplacer ;
//   - clic gauche glissé dans le vide = déplacer la vue ; sur un nœud = le déplacer (mémorisé dans localStorage) ;
//   - double-clic = recentrer (tout le graphe, ou le nœud sous le curseur) ;
//   - clic = ouvrir le lien du nœud dans un nouvel onglet (site, équipement ; page Proxmox pour un CT/VM),
//     après DELAI_OUVERTURE_MS : un double-clic arrivé entre-temps annule l'ouverture et ne fait que recentrer ;
//     Maj+clic, bouton ⓘ, toucher (téléphone) ou nœud sans lien = panneau de détails ;
//   - survol = chaîne jusqu'au MikroTik illuminée (rendu.js) + infobulle verre fumé.
// Le zoom sémantique et le masquage des étiquettes qui se chevauchent sont faits par rendu.js (selon camera.k).
// Aucun texte de données n'est injecté en HTML : tout passe par textContent.

export const PROXMOX = "https://pve.lan";
const URL_SURE = /^https?:\/\/[^\s<>"'`]{1,200}$/i;
const CLE_POSITIONS = "abysse.positions.v1";
const MAX_POSITIONS = 2000;
const SEUIL_SOURIS = 4;
const SEUIL_TOUCHER = 9;
const ANTI_DOUBLE_MS = 500;
/** Attente avant d'ouvrir l'onglet d'un clic : un double-clic arrivé entre-temps l'annule (il recentre). */
export const DELAI_OUVERTURE_MS = 250;
const DELAI_INFO_MS = 650;

const fini = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------------ liens */

/** L'URL si elle est en http(s) et sans caractère dangereux, sinon null (jamais `javascript:`). */
export function urlSure(u) {
  return typeof u === "string" && URL_SURE.test(u) ? u : null;
}

function vmidDe(n) {
  const d = n && n.details;
  const v = d && Number(d.vmid);
  if (Number.isInteger(v) && v > 0) return v;
  const m = /^(?:ct|vm)-(\d+)$/.exec((n && n.id) || "");
  return m ? Number(m[1]) : null;
}

/** Lien profond vers la page du CT/VM dans l'interface Proxmox, ou null. */
export function lienProxmox(n) {
  if (!n || !["ct", "vm", "nas-vm"].includes(n.type)) return null;
  const vmid = vmidDe(n);
  if (vmid === null) return null;
  return `${PROXMOX}/#v1:0:=${n.type === "ct" ? "lxc" : "qemu"}%2F${vmid}:4:::::::`;
}

function hote(u) {
  try { return new URL(u).host; } catch { return u; }
}

/** Liens à proposer pour un nœud, le principal d'abord : [{libelle, url}]. */
export function liensDuNoeud(n) {
  if (!n) return [];
  const propre = urlSure(n.url);
  const pve = lienProxmox(n);
  const out = [];
  const ajouter = (libelle, url) => { if (url && !out.some((l) => l.url === url)) out.push({ libelle, url }); };
  if (n.type === "nas-vm") {
    ajouter(`Ouvrir ${hote(propre)}`, propre);
    ajouter("Page dans Proxmox", pve);
  } else if (n.type === "ct" || n.type === "vm") {
    ajouter("Page dans Proxmox", pve);
    ajouter(`Ouvrir ${hote(propre)}`, propre);
  } else {
    ajouter(`Ouvrir ${hote(propre)}`, propre);
  }
  return out;
}

/** Ouvre une URL sûre dans un nouvel onglet, sans lien vers cette page. */
export function ouvrirOnglet(url) {
  const u = urlSure(url);
  if (!u || typeof window === "undefined") return false;
  window.open(u, "_blank", "noopener");
  return true;
}

/* ------------------------------------------------------------------ positions mémorisées */

function stockageParDefaut() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Positions déplacées à la main : Map id → {x, y} (vide si le stockage est indisponible ou illisible). */
export function chargerPositions(stockage = stockageParDefaut()) {
  const m = new Map();
  try {
    const brut = stockage && stockage.getItem(CLE_POSITIONS);
    const o = brut ? JSON.parse(brut) : null;
    if (o && typeof o === "object") {
      for (const [id, p] of Object.entries(o)) {
        if (m.size >= MAX_POSITIONS) break;
        if (Array.isArray(p) && fini(p[0]) && fini(p[1])) m.set(id, { x: p[0], y: p[1] });
      }
    }
  } catch { /* stockage bloqué ou contenu illisible : positions calculées */ }
  return m;
}

export function sauverPositions(positions, stockage = stockageParDefaut()) {
  try {
    if (!stockage) return;
    const o = {};
    let n = 0;
    for (const [id, p] of positions) {
      if (n++ >= MAX_POSITIONS) break;
      if (p && fini(p.x) && fini(p.y)) o[id] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
    }
    stockage.setItem(CLE_POSITIONS, JSON.stringify(o));
  } catch { /* quota, navigation privée : tant pis, la position vaut pour la session */ }
}

/* ------------------------------------------------------------------ interactions */

export class Interactions {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o
   *   camera, rendu, graphe ; positions (Map id → {x, y}, mise à jour pendant un déplacement) ;
   *   infobulle (élément) ; contenuInfobulle(id) → {entete, nom, lignes: [{libelle, valeur}]} | null ;
   *   surDetails(id | null) : ouvrir / fermer le panneau.
   */
  constructor(canvas, { camera, rendu, graphe, positions = new Map(), infobulle = null, contenuInfobulle = () => null, surDetails = () => {} }) {
    this.canvas = canvas;
    this.camera = camera;
    this.rendu = rendu;
    this.graphe = graphe;
    this.positions = positions;
    this.infobulle = infobulle;
    this.contenuInfobulle = contenuInfobulle;
    this.surDetails = surDetails;
    /** Mode modifier : fonction (id, evenement) → true pour prendre la main sur le clic. */
    this.interception = null;
    /** Id du nœud survolé (ou déplacé), lu par rendu.image. */
    this.survol = null;
    this.actif = true;

    this._pointeurs = new Map();
    this._geste = null;
    this._souris = { x: 0, y: 0, dedans: false };
    this._ib = { id: null, t: null };
    this._derniereOuverture = { id: null, t: 0 };
    /** Ouverture d'onglet en attente (minuterie), annulée par un double-clic. */
    this._ouverture = null;
    /** Vrai quand le clic en cours vient d'ouvrir le panneau de détails. */
    this._detailsOuverts = false;
    this._info = { id: null, jusqua: 0, survole: false };
    this._bouton = this._creerBoutonInfo();

    const ecoute = (cible, type, f, opts) => { cible.addEventListener(type, f, opts); this._retirer.push(() => cible.removeEventListener(type, f, opts)); };
    this._retirer = [];
    ecoute(canvas, "contextmenu", (e) => e.preventDefault());
    ecoute(canvas, "pointerdown", (e) => this._bas(e));
    ecoute(canvas, "pointermove", (e) => this._bouger(e));
    ecoute(canvas, "pointerup", (e) => this._haut(e));
    ecoute(canvas, "pointercancel", (e) => this._annuler(e));
    ecoute(canvas, "pointerleave", (e) => { if (e.pointerType === "mouse" && !this._geste) this._quitter(); });
    ecoute(canvas, "dblclick", (e) => this._double(e));
    ecoute(canvas, "wheel", (e) => this._molette(e), { passive: false });
    ecoute(window, "blur", () => this._annuler(null));
  }

  detruire() {
    this._annulerOuverture();
    for (const f of this._retirer) f();
    this._retirer = [];
    if (this._bouton) this._bouton.remove();
  }

  /** À appeler à chaque image, après rendu.image : suit le nœud avec le bouton ⓘ et rafraîchit l'infobulle. */
  parImage() {
    this._majBoutonInfo();
    if (this._ib.id && this.graphe.t !== this._ib.t) this._remplirInfobulle(this._ib.id);
  }

  /** Coupe le survol et l'infobulle (changement de vue, panneau qui s'ouvre…). */
  oublierSurvol() {
    this._quitter();
    this._info.jusqua = 0;
  }

  /* ---------------------------------------------------------------- coordonnées */

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _noeud(id) {
    return id ? this.graphe.noeuds.get(id) || null : null;
  }

  /* ---------------------------------------------------------------- pointeurs */

  _bas(e) {
    if (!this.actif) return;
    const p = this._pos(e);
    this._pointeurs.set(e.pointerId, p);
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    if (this._pointeurs.size === 2) {
      // deux doigts : pincer (zoom + déplacement), on abandonne le geste à un doigt
      const [a, b] = [...this._pointeurs.values()];
      this._geste = { mode: "pincer", bouge: true, d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this._majCurseur();
      return;
    }
    if (this._pointeurs.size > 2) return;
    if (e.button === 2) {
      e.preventDefault();
      this._geste = { mode: "rotation", id: null, x0: p.x, y0: p.y, x: p.x, y: p.y, bouge: false, type: e.pointerType, maj: e.shiftKey };
    } else if (e.button === 0) {
      const id = this.rendu.noeudSous(p.x, p.y);
      this._geste = { mode: id ? "noeud" : "vue", id, x0: p.x, y0: p.y, x: p.x, y: p.y, bouge: false, type: e.pointerType, maj: e.shiftKey };
    } else {
      return;
    }
    this._masquerInfobulle();
  }

  _bouger(e) {
    if (!this.actif) return;
    const p = this._pos(e);
    if (e.pointerType === "mouse") { this._souris.x = p.x; this._souris.y = p.y; this._souris.dedans = true; }
    const g = this._geste;
    if (!g) {
      if (e.pointerType === "mouse") this._survoler(p);
      return;
    }
    if (!this._pointeurs.has(e.pointerId)) return;
    this._pointeurs.set(e.pointerId, p);

    if (g.mode === "pincer") {
      const pts = [...this._pointeurs.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (g.d > 10 && d > 10) this.camera.zoomer(d / g.d, mx, my);
      this.camera.deplacer(g.mx, g.my, mx, my);
      g.d = d; g.mx = mx; g.my = my;
      return;
    }

    if (!g.bouge) {
      const seuil = g.type === "mouse" ? SEUIL_SOURIS : SEUIL_TOUCHER;
      if (Math.hypot(p.x - g.x0, p.y - g.y0) < seuil) return;
      g.bouge = true;
      this._majCurseur();
    }
    if (g.mode === "rotation") {
      this.camera.tourner(p.x - g.x, p.y - g.y);
    } else if (g.mode === "vue") {
      this.camera.deplacer(g.x, g.y, p.x, p.y);
    } else if (g.mode === "noeud") {
      const n = this._noeud(g.id);
      if (n && fini(n.x) && fini(n.y)) {
        const a = this.camera.deprojeter(g.x, g.y), b = this.camera.deprojeter(p.x, p.y);
        n.x += b.x - a.x;
        n.y += b.y - a.y;
        this.positions.set(n.id, { x: n.x, y: n.y });
        g.deplace = true;
      }
      this.survol = g.id;
    }
    g.x = p.x; g.y = p.y;
  }

  _haut(e) {
    const g = this._geste;
    this._pointeurs.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    if (!g) return;
    if (g.mode === "pincer") {
      // on attend que tous les doigts soient levés pour éviter un saut de la vue
      if (this._pointeurs.size === 0) this._finGeste();
      return;
    }
    if (g.mode === "noeud" && g.deplace) sauverPositions(this.positions);
    this._detailsOuverts = false;
    if (!g.bouge && (g.mode === "noeud" || g.mode === "vue")) this._clic(g.mode === "noeud" ? g.id : null, e, g);
    this._finGeste();
    // le panneau vient de s'ouvrir : pas de survol (ni d'infobulle) rallumé par-dessus avant que la souris bouge
    if (e.pointerType === "mouse" && !this._detailsOuverts) this._survoler(this._pos(e));
  }

  _annuler(e) {
    if (e) this._pointeurs.delete(e.pointerId); else this._pointeurs.clear();
    const g = this._geste;
    if (g && g.mode === "noeud" && g.deplace) sauverPositions(this.positions);
    if (this._pointeurs.size === 0) this._finGeste();
  }

  _finGeste() {
    this._geste = null;
    this._majCurseur();
  }

  _majCurseur() {
    const c = this.canvas.classList, g = this._geste;
    c.toggle("rotation", !!g && g.bouge && g.mode === "rotation");
    c.toggle("deplacement", !!g && g.bouge && (g.mode === "vue" || g.mode === "noeud" || g.mode === "pincer"));
    c.toggle("sur-noeud", !g && !!this.survol);
  }

  /* ---------------------------------------------------------------- clic, double-clic, molette */

  _clic(id, e, g) {
    if (typeof this.interception === "function" && this.interception(id, e)) return;
    if (!id) { this.surDetails(null); return; }
    const n = this._noeud(id);
    if (!n) return;
    const maintenant = typeof performance !== "undefined" ? performance.now() : Date.now();
    const d = this._derniereOuverture;
    if (d.id === id && maintenant - d.t < ANTI_DOUBLE_MS) return; // second clic d'un double-clic
    d.id = id; d.t = maintenant;
    const liens = liensDuNoeud(n);
    // téléphone : pas de survol, le toucher montre d'abord les détails (le panneau a le bouton « Ouvrir »)
    if (g.maj || e.shiftKey || g.type === "touch" || !liens.length) { this._detailsOuverts = true; this.surDetails(id); return; }
    // Ouverture différée : le premier clic d'un double-clic arrive ici avant l'évènement dblclick.
    // L'activation utilisateur dure plusieurs secondes, window.open reste donc autorisé après le délai.
    this._annulerOuverture();
    const url = liens[0].url;
    this._ouverture = setTimeout(() => { this._ouverture = null; ouvrirOnglet(url); }, DELAI_OUVERTURE_MS);
  }

  _annulerOuverture() {
    if (this._ouverture !== null) { clearTimeout(this._ouverture); this._ouverture = null; }
  }

  _double(e) {
    this._annulerOuverture(); // double-clic = recentrer, jamais ouvrir d'onglet
    if (!this.actif) return;
    e.preventDefault();
    const p = this._pos(e);
    const id = this.rendu.noeudSous(p.x, p.y);
    const n = this._noeud(id);
    const duree = this.rendu.calme ? 0 : 0.9;
    // assez près pour le zoom sémantique « détails » (relatif à la vue d'ensemble, voir rendu.zoomVue)
    const kDetails = (fini(this.rendu.zoomVue) ? this.rendu.zoomVue : 0.8) * 1.8;
    if (n && fini(n.x) && fini(n.y)) this.camera.viser({ tx: n.x, ty: n.y, k: Math.max(this.camera.k, kDetails) }, duree);
    else this.rendu.recadrer(this.camera, 1.2);
  }

  _molette(e) {
    if (!this.actif) return;
    e.preventDefault();
    const p = this._pos(e);
    const unite = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight || 800 : 1;
    const dy = Math.max(-400, Math.min(400, e.deltaY * unite));
    this.camera.zoomer(Math.exp(-dy * 0.0016), p.x, p.y);
  }

  /* ---------------------------------------------------------------- survol, infobulle, bouton ⓘ */

  _survoler(p) {
    const id = this.rendu.noeudSous(p.x, p.y);
    if (id !== this.survol) {
      this.survol = id;
      this._majCurseur();
      if (id) this._remplirInfobulle(id); else this._masquerInfobulle();
    }
    if (id) {
      this._info.id = id;
      this._info.jusqua = Infinity;
      this._placerInfobulle(p.x, p.y);
    } else if (this._info.jusqua === Infinity) {
      this._info.jusqua = this._maintenant() + DELAI_INFO_MS; // le temps d'atteindre le bouton ⓘ
    }
  }

  _quitter() {
    this._souris.dedans = false;
    if (this.survol) { this.survol = null; this._majCurseur(); }
    this._masquerInfobulle();
    if (this._info.jusqua === Infinity) this._info.jusqua = this._maintenant() + DELAI_INFO_MS;
  }

  _maintenant() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  _remplirInfobulle(id) {
    const el = this.infobulle;
    if (!el) return;
    const c = this.contenuInfobulle(id);
    this._ib.id = c ? id : null;
    this._ib.t = this.graphe.t;
    if (!c) { this._masquerInfobulle(); return; }
    const k = document.createElement("div");
    k.className = "ib-k";
    k.textContent = c.entete || "";
    const nom = document.createElement("div");
    nom.className = "ib-n";
    nom.textContent = c.nom || "";
    const lignes = (c.lignes || []).map(({ libelle, valeur, classe }) => {
      const l = document.createElement("div");
      l.className = "ib-l";
      const s = document.createElement("span");
      s.textContent = libelle;
      const b = document.createElement("b");
      b.textContent = valeur;
      if (classe) b.className = classe;
      l.append(s, b);
      return l;
    });
    el.replaceChildren(k, nom, ...lignes);
    if (!el.classList.contains("visible")) { void el.offsetWidth; el.classList.add("visible"); }
  }

  _placerInfobulle(x, y) {
    const el = this.infobulle;
    if (!el || !this._ib.id) return;
    const r = this.canvas.getBoundingClientRect();
    const w = el.offsetWidth || 220, h = el.offsetHeight || 120;
    const W = window.innerWidth, H = window.innerHeight, m = 16;
    let gx = r.left + x + 18, gy = r.top + y + 18;
    if (gx + w > W - m) gx = r.left + x - w - 18;
    if (gy + h > H - m) gy = r.top + y - h - 18;
    el.style.left = `${Math.max(m, Math.min(W - w - m, gx))}px`;
    el.style.top = `${Math.max(m, Math.min(H - h - m, gy))}px`;
  }

  _masquerInfobulle() {
    const el = this.infobulle;
    this._ib.id = null;
    if (!el) return;
    el.classList.remove("visible");
    el.replaceChildren();
  }

  _creerBoutonInfo() {
    if (typeof document === "undefined") return null;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bouton-info";
    b.textContent = "ⓘ";
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    b.addEventListener("pointerenter", () => { this._info.survole = true; });
    b.addEventListener("pointerleave", () => { this._info.survole = false; this._info.jusqua = this._maintenant() + DELAI_INFO_MS; });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const id = this._info.id;
      this._info.survole = false;
      this._info.jusqua = 0;
      if (id && this._noeud(id)) this.surDetails(id);
    });
    document.body.append(b);
    return b;
  }

  _majBoutonInfo() {
    const b = this._bouton;
    if (!b) return;
    const inf = this._info;
    const visible = !!inf.id && !this._geste && this.actif && (inf.survole || this._maintenant() < inf.jusqua);
    const pos = visible ? this.rendu.ecran(inf.id) : null;
    if (!pos) {
      if (b.classList.contains("visible")) b.classList.remove("visible");
      if (!visible) inf.id = inf.survole ? inf.id : null;
      return;
    }
    const n = this._noeud(inf.id);
    const nom = n ? String(n.nom || n.id) : "";
    if (b.dataset.id !== inf.id) {
      b.dataset.id = inf.id;
      b.title = `Détails : ${nom}`;
      b.setAttribute("aria-label", `Détails : ${nom}`);
    }
    const r = this.canvas.getBoundingClientRect();
    // en haut à droite du nœud, sinon un autre coin, jamais sur l'étiquette du nœud ; en bas à droite en dernier
    // (l'infobulle s'ouvre de ce côté-là du curseur)
    const d = Math.max(9, pos.r * 1.25) + 4, T = 22;
    const coins = [[d, -d - T], [-d - T, -d - T], [-d - T, d], [d, d]];
    let [ox, oy] = coins[0];
    if (pos.lab) {
      const libre = coins.find(([cx, cy]) => {
        const x0 = pos.sx + cx, y0 = pos.sy + cy;
        return x0 + T < pos.lab.x0 || x0 > pos.lab.x1 || y0 + T < pos.lab.y0 || y0 > pos.lab.y1;
      });
      if (libre) [ox, oy] = libre;
    }
    b.style.left = `${Math.round(r.left + pos.sx + ox)}px`;
    b.style.top = `${Math.round(r.top + pos.sy + oy)}px`;
    if (!b.classList.contains("visible")) b.classList.add("visible");
  }
}
