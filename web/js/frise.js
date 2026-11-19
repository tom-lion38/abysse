// Frise du temps (bas de la carte) : direct + historique, des « pings » à chaque changement, leur taille suit
// l'importance (1 appareil · 2 CT/site · 3 VM/NAS/PBS/sauvegarde/stockage · 4 PVE/MikroTik/WAN/batterie).
//
//   const frise = new Frise(el, { surInstant: (inst) => …, surDirect: () => … });
//   frise.charger(de, a);   // GET /api/historique?de=&a=  (secondes Unix)
//   frise.ajouter(evt);     // évènement reçu en direct (SSE)
//   frise.recharger(depuis); // après une reconnexion du flux : relit l'historique depuis `depuis` (s)
//
// 24 h affichées par défaut ; molette = zoom (10 min → 30 jours), Maj+molette ou glisser sur les graduations =
// défiler ; clic sur un ping = rejoue le moment (instantané d'avant puis d'après : la carte anime le changement) ;
// clic ou glisser sur la piste = curseur → GET /api/instant?t= puis `surInstant(inst)` ; bouton « Direct ».
// Les fonctions exportées hors `Frise` sont pures (testées sous Node). Tout texte passe par textContent.

export const JOUR = 86400;
export const FENETRE_MAX = 30 * JOUR;
export const FENETRE_MIN = 600;
export const FENETRE_DEFAUT = JOUR;
const MARGE_DROITE = 0.015;           // part de la fenêtre laissée à droite de « maintenant »
const ECART_GRADUATIONS = 70;         // px minimum entre deux graduations
const PAS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, JOUR, 2 * JOUR, 7 * JOUR];
const RAYONS = [4, 7, 11, 18];
/** 1 gris-rose · 2 violet clair · 3 orange · 4 rouge vif (avec onde). */
export const COULEURS_PING = Object.freeze(["#c79bb4", "#c3a6ff", "#ff9a3c", "#ff3b4e"]);
/** Natures « bonne nouvelle » : ping en anneau creux plutôt que plein. */
const RETOURS = new Set(["retour", "secteur", "apparition"]);

const fini = (v) => typeof v === "number" && Number.isFinite(v);
const borne = (v, a, b) => (v < a ? a : v > b ? b : v);
const deux = (n) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ fonctions pures */

/** Rayon du ping (px) selon l'importance 1-4 : 4, 7, 11, 18. */
export function rayonPing(importance) {
  const n = Math.round(Number(importance));
  return RAYONS[(Number.isFinite(n) ? borne(n, 1, 4) : 1) - 1];
}

/** Temps (s) → abscisse (px) dans une piste de `largeur` px couvrant [de, a]. */
export function tVersX(t, de, a, largeur) {
  return a > de ? ((t - de) / (a - de)) * largeur : 0;
}

/** Abscisse (px) → temps (s), réciproque de `tVersX`. */
export function xVersT(x, de, a, largeur) {
  return largeur > 0 ? de + (x / largeur) * (a - de) : de;
}

const FMT_INSTANT = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const FMT_COMPLET = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Secondes Unix → « 25/10 23:14 » (heure locale). */
export function formatInstant(t) {
  return FMT_INSTANT.format(new Date(t * 1000)).replace(",", "");
}

/** Secondes Unix → « samedi 25 octobre à 23:14:30 ». */
export function formatComplet(t) {
  return FMT_COMPLET.format(new Date(t * 1000));
}

function minuitLocal(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/**
 * Graduations de la piste : [{t, x, texte, majeure}] espacées d'au moins ~70 px, calées sur l'heure locale ;
 * « 14:00 » pour les heures, « 25/10 » à minuit (graduation majeure).
 */
export function graduations(de, a, largeur) {
  if (!(a > de) || !(largeur > 0)) return [];
  const span = a - de;
  const pas = PAS.find((p) => (p / span) * largeur >= ECART_GRADUATIONS) || PAS[PAS.length - 1];
  const out = [];
  const pousser = (t) => {
    const d = new Date(t * 1000);
    const minuit = d.getHours() === 0 && d.getMinutes() === 0;
    out.push({
      t, x: tVersX(t, de, a, largeur), majeure: minuit,
      texte: minuit || pas >= JOUR ? `${deux(d.getDate())}/${deux(d.getMonth() + 1)}` : `${deux(d.getHours())}:${deux(d.getMinutes())}`,
    });
  };
  if (pas < JOUR) {
    // pas réguliers depuis chaque minuit local (un changement d'heure ne décale que la journée concernée)
    let jour = minuitLocal(de);
    for (let garde = 0; jour <= a && garde < 400; garde++) {
      const d = new Date(jour * 1000);
      d.setDate(d.getDate() + 1);
      const suivant = d.getTime() / 1000;
      for (let t = jour; t < suivant && t <= a; t += pas) if (t >= de) pousser(t);
      jour = suivant;
    }
  } else {
    const n = Math.round(pas / JOUR);
    const d = new Date(minuitLocal(de) * 1000);
    // jours alignés sur un multiple de n depuis une date fixe, pour que les graduations ne « dansent » pas
    const index = Math.floor(d.getTime() / 1000 / JOUR);
    d.setDate(d.getDate() - (((index % n) + n) % n));
    for (let garde = 0; garde < 400; garde++) {
      const t = d.getTime() / 1000;
      if (t > a) break;
      if (t >= de) pousser(t);
      d.setDate(d.getDate() + n);
    }
  }
  return out;
}

/** Le ping sous le pointeur (le plus important, puis le plus proche), ou null. */
export function pingSous(pings, x, y) {
  let meilleur = null, imp = -1, dist = Infinity;
  for (const p of pings || []) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d > Math.max(p.r, 6) + 3) continue;
    const i = Number(p.evt && p.evt.importance) || 0;
    if (i > imp || (i === imp && d < dist)) { meilleur = p; imp = i; dist = d; }
  }
  return meilleur;
}

/**
 * Fenêtre affichée bornée : largeur entre 10 min et 30 jours (centrée), jamais au-delà de « maintenant »
 * (plus une petite marge) ni avant 30 jours.
 */
export function bornerVue(de, a, maintenant) {
  let span = fini(a - de) ? borne(a - de, FENETRE_MIN, FENETRE_MAX) : FENETRE_DEFAUT;
  if (span !== a - de) {
    const c = fini(de + a) ? (de + a) / 2 : maintenant - span / 2;
    de = c - span / 2;
    a = c + span / 2;
  }
  const maxA = maintenant + span * MARGE_DROITE;
  if (a > maxA) { a = maxA; de = a - span; }
  const minDe = maintenant - FENETRE_MAX;
  if (de < minDe) { de = minDe; a = de + span; }
  return { de, a };
}

const cle = (e) => `${e.t}|${e.id}|${e.nature}`;
const evtValide = (e) => e && typeof e === "object" && fini(e.t);

/** Réunit deux listes d'évènements sans doublon (même t, id, nature), triées par date. */
export function fusionner(existants, nouveaux) {
  const m = new Map();
  for (const e of existants || []) if (evtValide(e)) m.set(cle(e), e);
  for (const e of nouveaux || []) if (evtValide(e)) m.set(cle(e), e);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/* ------------------------------------------------------------------ composant */

function el(tag, classe, texte) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texte !== undefined && texte !== null) n.textContent = texte;
  return n;
}

const ECHELLES = [["24 h", JOUR], ["7 j", 7 * JOUR], ["30 j", 30 * JOUR]];
const DECALAGE_APRES = 12;        // s : l'instantané « d'après » (un instantané toutes les 10 s)
const DECALAGE_APRES_ANCIEN = 65; // au-delà de 48 h, il n'en reste qu'un par minute
const DELAI_REJEU_MS = 900;       // entre l'instantané d'avant et celui d'après
const INTERVALLE_REQUETE_MS = 120;
const MARGE_HORLOGE = 60;         // s : tolère une horloge du navigateur en retard sur celle du serveur

export class Frise {
  /**
   * @param {HTMLElement} racine `footer#frise`
   * @param {{surInstant?: (inst: object, t: number) => void, surDirect?: () => void,
   *          fetch?: typeof fetch, maintenant?: () => number}} options
   */
  constructor(racine, { surInstant = () => {}, surDirect = () => {}, fetch: f = null, maintenant = null } = {}) {
    this.racine = racine;
    this.surInstant = surInstant;
    this.surDirect = surDirect;
    this._fetch = f || ((...args) => globalThis.fetch(...args));
    this._maintenant = maintenant || (() => Date.now() / 1000);
    this.evenements = [];
    this.bornes = [null, null];
    this.direct = true;
    this.curseur = null;
    this._suivre = true;
    const m = this._maintenant();
    this.vue = bornerVue(m - FENETRE_DEFAUT, m, m);
    this._chargeDe = null;
    this._chargeA = null;
    this._sequence = 0;
    this._coupure = 0;               // dernière annulation (Direct, rejeu) : les réponses plus anciennes sont jetées
    this._pompePlanifiee = false;
    this._enVol = false;
    this._enAttente = null;
    this._dernierEnvoi = 0;
    this._minuterieRejeu = 0;
    this._minuterieChargement = 0;
    this._minuterieRecharge = 0;
    this._relance = 10000;
    this._apparitions = new Map();
    this._pings = [];
    this._survol = null;
    this._pointeur = null;
    this._geste = null;
    this._sale = true;
    this._derniereImage = 0;
    this._calme = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    this._construire();
    this._ecouter();
    this._majEtat();
    const boucle = (t) => { this._image(t); requestAnimationFrame(boucle); };
    requestAnimationFrame(boucle);
  }

  /* ---------------- API */

  /** Charge les évènements de [de, a] (secondes) et affiche cette fenêtre. */
  charger(de, a) {
    const m = this._maintenant();
    this.vue = bornerVue(de, a, m);
    this._suivre = this.vue.a >= m - (this.vue.a - this.vue.de) * 0.01;
    this._sale = true;
    this._majEchelles();
    return this._charger(this.vue.de, Math.max(this.vue.a, a));
  }

  /** Ajoute un évènement reçu en direct (le ping éclot). */
  ajouter(evt) {
    if (!evtValide(evt)) return;
    const k = cle(evt);
    if (!this.evenements.some((e) => cle(e) === k)) this._apparitions.set(k, performance.now());
    this.evenements = fusionner(this.evenements, [evt]);
    this._sale = true;
  }

  /**
   * Après une reconnexion du flux : relit `/api/historique` de `depuis` (secondes ; défaut : début de la fenêtre
   * affichée) jusqu'à maintenant, sans déplacer la vue. Récupère les évènements émis pendant la coupure et le
   * ping « Abysse injoignable N min », que le serveur écrit dans l'historique à son redémarrage sans le pousser
   * dans le flux. Les nouveaux pings éclosent. En cas d'échec, retente sur la même plage.
   */
  recharger(depuis = null) {
    const m = this._maintenant();
    const de = Math.min(m, Math.max(fini(depuis) ? depuis : this.vue.de, m - FENETRE_MAX));
    clearTimeout(this._minuterieRecharge);
    return this._charger(de, m + MARGE_HORLOGE, {
      eclore: true,
      relancer: (ms) => { this._minuterieRecharge = setTimeout(() => this.recharger(de), ms); },
    });
  }

  /** Revient au direct (comme le bouton). */
  retourDirect() {
    if (this.direct) return;
    this._coupure = ++this._sequence;
    clearTimeout(this._minuterieRejeu);
    this._enAttente = null;
    this.direct = true;
    this.curseur = null;
    this._suivre = true;
    this._recalerSurMaintenant();
    this._majEtat();
    this.surDirect();
  }

  /** Revoit l'instant `t` (secondes) : curseur, badge, puis `surInstant` avec l'instantané enregistré. */
  revoir(t) {
    if (!fini(t)) return;
    const m = this._maintenant();
    if (t >= m - 2) { this.retourDirect(); return; }
    this._sequence++;
    clearTimeout(this._minuterieRejeu);
    this.direct = false;
    this.curseur = t;
    this._majEtat();
    this._enAttente = { t, seq: this._sequence };
    this._pomper();
  }

  /** Rejoue un évènement : instantané juste avant, puis juste après (la carte anime le changement). */
  rejouer(evt) {
    if (!evtValide(evt)) return;
    this._coupure = ++this._sequence;
    const seq = this._sequence;
    clearTimeout(this._minuterieRejeu);
    this._enAttente = null;
    this.direct = false;
    this.curseur = evt.t;
    this._majEtat(evt);
    const ancien = this._maintenant() - evt.t > 47 * 3600;
    const apresT = Math.min(evt.t + (ancien ? DECALAGE_APRES_ANCIEN : DECALAGE_APRES), this._maintenant());
    Promise.all([this._instant(evt.t - 1), this._instant(apresT)]).then(([avant, apres]) => {
      if (seq !== this._sequence) return;
      if (!avant && !apres) { this._majEtat(evt, "aucun"); return; }
      if (avant && apres) {
        this.surInstant(avant, evt.t - 1);
        this._minuterieRejeu = setTimeout(() => {
          if (seq === this._sequence) this.surInstant(apres, apresT);
        }, DELAI_REJEU_MS);
      } else {
        this.surInstant(avant || apres, avant ? evt.t - 1 : apresT);
      }
    });
  }

  /* ---------------- réseau */

  async _charger(de, a, { eclore = false, relancer = null } = {}) {
    try {
      const r = await this._fetch(`/api/historique?de=${encodeURIComponent(de.toFixed(3))}&a=${encodeURIComponent(a.toFixed(3))}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      if (d && Array.isArray(d.evenements)) {
        if (eclore) {
          const connus = new Set(this.evenements.map(cle));
          const now = performance.now();
          for (const e of d.evenements) {
            // seulement les pings visibles : une éclosion jamais dessinée garderait la frise animée pour rien
            if (evtValide(e) && !connus.has(cle(e)) && e.t >= this.vue.de && e.t <= this.vue.a) this._apparitions.set(cle(e), now);
          }
        }
        this.evenements = fusionner(this.evenements, d.evenements);
      }
      if (d && Array.isArray(d.bornes)) this.bornes = [fini(d.bornes[0]) ? d.bornes[0] : null, fini(d.bornes[1]) ? d.bornes[1] : null];
      this._chargeDe = this._chargeDe === null ? de : Math.min(this._chargeDe, de);
      this._chargeA = this._chargeA === null ? a : Math.max(this._chargeA, a);
      this._relance = 10000;
      this._sale = true;
      return true;
    } catch {
      // serveur injoignable : on retentera (la détection de perte de connexion est faite par donnees.js)
      if (relancer) relancer(this._relance);
      else {
        clearTimeout(this._minuterieChargement);
        this._minuterieChargement = setTimeout(() => this._completer(true), this._relance);
      }
      this._relance = Math.min(60000, this._relance * 2);
      return false;
    }
  }

  /** Charge ce qui manque à gauche de la fenêtre (la droite arrive en direct). */
  _completer(toutDeSuite = false) {
    clearTimeout(this._minuterieChargement);
    const go = () => {
      const { de, a } = this.vue;
      if (this._chargeDe === null) this._charger(de, Math.max(a, this._maintenant()));
      else if (de < this._chargeDe - 1) this._charger(de, this._chargeDe);
    };
    if (toutDeSuite) go();
    else this._minuterieChargement = setTimeout(go, 300);
  }

  async _instant(t) {
    try {
      const r = await this._fetch(`/api/instant?t=${encodeURIComponent(t.toFixed(3))}`, { cache: "no-store" });
      if (!r.ok) return null;
      const inst = await r.json();
      return inst && typeof inst === "object" && Array.isArray(inst.noeuds) ? inst : null;
    } catch {
      return null;
    }
  }

  /** Une requête `/api/instant` à la fois ; en glissant, seule la dernière position compte. */
  _pomper() {
    if (this._enVol || !this._enAttente || this._pompePlanifiee) return;
    const attente = performance.now() - this._dernierEnvoi;
    if (attente < INTERVALLE_REQUETE_MS) {
      this._pompePlanifiee = true;
      setTimeout(() => { this._pompePlanifiee = false; this._pomper(); }, INTERVALLE_REQUETE_MS - attente);
      return;
    }
    const { t, seq } = this._enAttente;
    this._enAttente = null;
    this._enVol = true;
    this._dernierEnvoi = performance.now();
    this._instant(t).then((inst) => {
      this._enVol = false;
      // les requêtes partent une à une : une réponse est jetée seulement si Direct ou un rejeu est passé depuis
      if (seq > this._coupure && !this.direct) {
        if (inst) { this.surInstant(inst, t); this._majEtat(); }
        else this._majEtat(null, "aucun");
      }
      this._pomper();
    });
  }

  /* ---------------- DOM */

  _construire() {
    const r = this.racine;
    const gauche = el("div", "fr-gauche");
    this.boutonDirect = el("button", "fr-direct");
    this.boutonDirect.type = "button";
    this.boutonDirect.append(el("i", "fr-point"), el("span", null, "Direct"));
    this.boutonDirect.title = "Revenir au direct";
    this.badge = el("span", "fr-badge");
    this.badge.setAttribute("aria-live", "polite");
    gauche.append(this.boutonDirect, this.badge);

    this.piste = el("div", "fr-piste");
    this.canvas = el("canvas", "fr-canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "slider");
    this.canvas.setAttribute("aria-label", "Frise du temps : flèches pour remonter le temps, Maj + flèches pour défiler, + et − pour zoomer");
    this.canvas.setAttribute("aria-valuemin", "0");
    this.canvas.setAttribute("aria-valuemax", "100");
    this.info = el("div", "fr-info");
    this.info.setAttribute("role", "tooltip");
    this.piste.append(this.canvas, this.info);

    const droite = el("div", "fr-echelles");
    droite.setAttribute("role", "group");
    droite.setAttribute("aria-label", "Durée affichée");
    this.boutonsEchelle = ECHELLES.map(([texte, span]) => {
      const b = el("button", "fr-echelle", texte);
      b.type = "button";
      b.dataset.span = String(span);
      b.title = `Afficher ${texte.replace("h", "heures").replace("j", "jours")}`;
      b.addEventListener("click", () => this._echelle(span));
      return b;
    });
    droite.append(...this.boutonsEchelle);

    r.replaceChildren(gauche, this.piste, droite);
    this.ctx = this.canvas.getContext("2d");
    this._dimensionner();
    this._majEchelles();
  }

  _dimensionner() {
    const rect = this.piste.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.largeur = Math.max(1, rect.width);
    this.hauteur = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.largeur * dpr);
    this.canvas.height = Math.round(this.hauteur * dpr);
    this._dpr = dpr;
    this._sale = true;
  }

  _ecouter() {
    if (typeof ResizeObserver === "function") new ResizeObserver(() => this._dimensionner()).observe(this.piste);
    else window.addEventListener("resize", () => this._dimensionner());

    this.boutonDirect.addEventListener("click", () => {
      if (this.direct) this._recalerSurMaintenant();
      else this.retourDirect();
    });

    const c = this.canvas;
    c.addEventListener("wheel", (e) => this._molette(e), { passive: false });
    c.addEventListener("pointerdown", (e) => this._appui(e));
    c.addEventListener("pointermove", (e) => this._mouvement(e));
    c.addEventListener("pointerup", (e) => this._relache(e));
    c.addEventListener("pointercancel", () => { this._geste = null; });
    c.addEventListener("pointerleave", () => { this._pointeur = null; this._survol = null; this._majInfo(); this._sale = true; });
    c.addEventListener("keydown", (e) => this._clavier(e));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  get _yPing() { return Math.round(this.hauteur * 0.42); }
  get _yAxe() { return this.hauteur - 14; }

  _surAxe(y) { return y >= this.hauteur - 20; }

  _molette(e) {
    e.preventDefault();
    const { x } = this._pos(e);
    const { de, a } = this.vue;
    const span = a - de;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const delta = e.deltaMode === 1 ? (horizontal ? e.deltaX : e.deltaY) * 16 : horizontal ? e.deltaX : e.deltaY;
    if (e.shiftKey || horizontal) {
      this._deplacerVue((delta / this.largeur) * span);
    } else {
      const t = xVersT(x, de, a, this.largeur);
      const f = Math.exp(borne(delta, -200, 200) * 0.0018);
      const ns = borne(span * f, FENETRE_MIN, FENETRE_MAX);
      const k = (t - de) / span;
      this._poserVue(t - k * ns, t - k * ns + ns);
    }
  }

  _deplacerVue(dt) {
    this._poserVue(this.vue.de + dt, this.vue.a + dt);
  }

  _poserVue(de, a) {
    const m = this._maintenant();
    this.vue = bornerVue(de, a, m);
    const span = this.vue.a - this.vue.de;
    this._suivre = this.vue.a >= m + span * MARGE_DROITE * 0.5;
    this._sale = true;
    this._majEchelles();
    this._completer();
  }

  _recalerSurMaintenant() {
    const m = this._maintenant();
    const span = this.vue.a - this.vue.de;
    this._poserVue(m + span * MARGE_DROITE - span, m + span * MARGE_DROITE);
    this._suivre = true;
  }

  _echelle(span) {
    const m = this._maintenant();
    // centré sur le curseur en revoir, collé au direct sinon
    if (!this.direct && fini(this.curseur) && this.curseur < m - span / 2) {
      this._poserVue(this.curseur - span / 2, this.curseur + span / 2);
    } else {
      this._poserVue(m - span * (1 - MARGE_DROITE), m + span * MARGE_DROITE);
      this._suivre = true;
    }
  }

  _majEchelles() {
    const span = this.vue.a - this.vue.de;
    for (const b of this.boutonsEchelle || []) {
      const actif = Math.abs(Number(b.dataset.span) - span) < span * 0.02;
      b.setAttribute("aria-pressed", String(actif));
    }
  }

  _appui(e) {
    if (e.button !== 0) return;
    const p = this._pos(e);
    const ping = this._surAxe(p.y) ? null : pingSous(this._pings, p.x, p.y);
    this._geste = { x0: p.x, de0: this.vue.de, a0: this.vue.a, ping, mode: this._surAxe(p.y) ? "defiler" : "curseur", bouge: false };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointeur déjà parti */ }
  }

  _mouvement(e) {
    const p = this._pos(e);
    this._pointeur = p;
    const g = this._geste;
    if (g) {
      if (!g.bouge && Math.abs(p.x - g.x0) < 4) return;
      g.bouge = true;
      if (g.mode === "defiler") {
        const span = g.a0 - g.de0;
        const dt = -((p.x - g.x0) / this.largeur) * span;
        this._poserVue(g.de0 + dt, g.a0 + dt);
      } else {
        this.revoir(xVersT(borne(p.x, 0, this.largeur), this.vue.de, this.vue.a, this.largeur));
      }
      this._majInfo();
      return;
    }
    const s = this._surAxe(p.y) ? null : pingSous(this._pings, p.x, p.y);
    if (s !== this._survol) { this._survol = s; this._sale = true; }
    this.canvas.style.cursor = s ? "pointer" : this._surAxe(p.y) ? "grab" : "col-resize";
    this._majInfo();
  }

  _relache(e) {
    const g = this._geste;
    this._geste = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    if (!g || g.bouge) return;
    const p = this._pos(e);
    if (g.ping) this.rejouer(g.ping.evt);
    else if (g.mode === "curseur") this.revoir(xVersT(borne(p.x, 0, this.largeur), this.vue.de, this.vue.a, this.largeur));
  }

  _clavier(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const span = this.vue.a - this.vue.de;
    const m = this._maintenant();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const sens = e.key === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) { this._deplacerVue(sens * span * 0.1); return; }
      const depart = this.direct || !fini(this.curseur) ? m : this.curseur;
      const t = depart + sens * span / 48;
      if (t >= m) { this.retourDirect(); return; }
      this.revoir(t);
      if (t < this.vue.de) this._deplacerVue(t - this.vue.de - span * 0.1);
    } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "−") {
      e.preventDefault();
      const f = e.key === "+" || e.key === "=" ? 0.6 : 1 / 0.6;
      const c = !this.direct && fini(this.curseur) ? this.curseur : Math.min(m, (this.vue.de + this.vue.a) / 2);
      const k = (c - this.vue.de) / span;
      const ns = borne(span * f, FENETRE_MIN, FENETRE_MAX);
      this._poserVue(c - k * ns, c - k * ns + ns);
    } else if (e.key === "End") {
      e.preventDefault();
      this.retourDirect();
      this._recalerSurMaintenant();
    }
  }

  /** Badge « Revoir · 25/10 23:14 », bouton Direct, valeur ARIA. */
  _majEtat(evt = null, probleme = null) {
    this.racine.classList.toggle("revoir", !this.direct);
    this.boutonDirect.setAttribute("aria-pressed", String(this.direct));
    if (this.direct) {
      this.badge.textContent = "";
      this.badge.hidden = true;
      this.canvas.setAttribute("aria-valuetext", "En direct");
    } else {
      const quand = formatInstant(this.curseur);
      let texte = `Revoir · ${quand}`;
      if (probleme === "aucun") texte += " · aucun enregistrement";
      this.badge.textContent = texte;
      this.badge.title = evt && typeof evt.texte === "string" ? `${evt.texte} — ${formatComplet(evt.t)}` : formatComplet(this.curseur);
      this.badge.hidden = false;
      this.canvas.setAttribute("aria-valuetext", quand);
    }
    const span = this.vue.a - this.vue.de;
    const t = this.direct ? this._maintenant() : this.curseur;
    this.canvas.setAttribute("aria-valuenow", String(Math.round(borne((t - this.vue.de) / span, 0, 1) * 100)));
    this._sale = true;
  }

  /** Infobulle : texte du ping survolé, ou l'heure sous le pointeur. */
  _majInfo() {
    const p = this._pointeur;
    if (!p) { this.info.classList.remove("visible"); return; }
    let x = p.x, titre, sous = null, couleur = null;
    if (this._survol) {
      const e = this._survol.evt;
      x = this._survol.x;
      titre = typeof e.texte === "string" && e.texte ? e.texte : String(e.nom || e.id || "Évènement");
      sous = formatComplet(e.t);
      couleur = COULEURS_PING[rayonPingIndex(e.importance)];
    } else {
      if (this._surAxe(p.y) && !this._geste) { this.info.classList.remove("visible"); return; }
      titre = formatInstant(xVersT(borne(p.x, 0, this.largeur), this.vue.de, this.vue.a, this.largeur));
    }
    const t = el("b", null, titre);
    if (couleur) t.style.color = couleur;
    this.info.replaceChildren(t, ...(sous ? [el("span", null, sous)] : []));
    this.info.style.left = `${borne(x, 70, Math.max(70, this.largeur - 70))}px`;
    this.info.classList.add("visible");
  }

  /* ---------------- dessin */

  _image(t) {
    const m = this._maintenant();
    if (this._suivre) {
      const span = this.vue.a - this.vue.de;
      const a = m + span * MARGE_DROITE;
      if (Math.abs(a - this.vue.a) > span / Math.max(1, this.largeur) * 0.5) {
        this.vue = { de: a - span, a };
        this._sale = true;
      }
    }
    const anime = !this._calme && (this._apparitions.size > 0 || this.direct || this._pings.some((p) => p.evt.importance >= 4));
    if (!this._sale && !(anime && t - this._derniereImage >= 33)) return;
    if (this.racine.hidden) return;
    this._derniereImage = t;
    this._sale = false;
    this._dessiner(t / 1000, m);
  }

  _dessiner(s, m) {
    const ctx = this.ctx, L = this.largeur, H = this.hauteur, dpr = this._dpr;
    const { de, a } = this.vue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L, H);
    const y = this._yPing;
    const xm = tVersX(m, de, a, L);

    // graduations
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";
    let finTexte = -Infinity;
    for (const g of graduations(de, a, L)) {
      ctx.fillStyle = g.majeure ? "rgba(160, 220, 255, .16)" : "rgba(140, 200, 255, .07)";
      ctx.fillRect(Math.round(g.x), g.majeure ? 6 : y - 6, 1, g.majeure ? H - 22 : 12);
      // un texte qui chevaucherait le précédent (piste étroite, téléphone) est sauté
      const demi = ctx.measureText(g.texte).width / 2;
      if (g.x - demi < finTexte + 6) continue;
      finTexte = g.x + demi;
      ctx.fillStyle = g.majeure ? "rgba(200, 230, 255, .72)" : "rgba(130, 160, 195, .62)";
      ctx.fillText(g.texte, g.x, H - 5);
    }

    // piste : plus lumineuse là où des instantanés permettent de rejouer
    const fond = ctx.createLinearGradient(0, 0, L, 0);
    fond.addColorStop(0, "rgba(120, 180, 255, 0)");
    fond.addColorStop(0.08, "rgba(120, 180, 255, .16)");
    fond.addColorStop(1, "rgba(120, 220, 255, .22)");
    ctx.fillStyle = fond;
    ctx.fillRect(0, y, Math.min(L, xm), 1);
    const [b0, b1] = this.bornes;
    if (fini(b0)) {
      const x0 = borne(tVersX(b0, de, a, L), 0, L), x1 = borne(tVersX(fini(b1) ? Math.max(b1, m) : m, de, a, L), 0, L);
      if (x1 > x0) {
        ctx.fillStyle = "rgba(140, 230, 255, .30)";
        ctx.fillRect(x0, y - 0.5, x1 - x0, 2);
      }
    }

    // pings (les petits d'abord, les gros par-dessus)
    const pings = [];
    const marge = 20 / L * (a - de);
    for (const e of this.evenements) {
      if (e.t < de - marge) continue;
      if (e.t > a + marge) break;
      pings.push({ x: tVersX(e.t, de, a, L), y, r: rayonPing(e.importance), evt: e });
    }
    pings.sort((p, q) => rayonPing(p.evt.importance) - rayonPing(q.evt.importance));
    this._pings = pings;
    const now = performance.now();
    for (const p of pings) this._ping(ctx, p, s, now);

    // maintenant
    if (xm >= 0 && xm <= L + 2) {
      const g = ctx.createLinearGradient(0, 4, 0, H - 18);
      g.addColorStop(0, "rgba(127, 231, 255, 0)");
      g.addColorStop(0.5, this.direct ? "rgba(127, 231, 255, .85)" : "rgba(127, 231, 255, .35)");
      g.addColorStop(1, "rgba(127, 231, 255, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(Math.round(xm) - 1, 4, 2, H - 22);
      if (this.direct) {
        const pulse = this._calme ? 0.5 : (Math.sin(s * 3) + 1) / 2;
        ctx.beginPath();
        ctx.arc(xm, y, 3 + pulse * 2, 0, Math.PI * 2);
        ctx.fillStyle = "#bff6ff";
        ctx.shadowColor = "#49d8ff";
        ctx.shadowBlur = 10 + pulse * 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // curseur de revoir
    if (!this.direct && fini(this.curseur)) {
      const xc = tVersX(this.curseur, de, a, L);
      if (xc >= -2 && xc <= L + 2) {
        ctx.fillStyle = "rgba(255, 226, 184, .9)";
        ctx.fillRect(Math.round(xc) - 1, 2, 2, H - 18);
        ctx.beginPath();
        ctx.moveTo(xc - 5, 1);
        ctx.lineTo(xc + 5, 1);
        ctx.lineTo(xc, 7);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  _ping(ctx, p, s, now) {
    const e = p.evt;
    const i = rayonPingIndex(e.importance);
    const couleur = COULEURS_PING[i];
    const k = cle(e);
    let r = p.r, alpha = 1;
    const debut = this._apparitions.get(k);
    if (debut !== undefined) {
      const f = (now - debut) / 700;
      if (f >= 1 || this._calme) this._apparitions.delete(k);
      else {
        const ease = 1 - Math.pow(1 - f, 3);
        r = p.r * (0.2 + 0.8 * ease) * (1 + 0.35 * Math.sin(f * Math.PI));
        alpha = ease;
        // anneau d'éclosion
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + f * 22, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(couleur, 0.6 * (1 - f));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // onde des pings énormes
    if (i === 3 && !this._calme) {
      for (let n = 0; n < 2; n++) {
        const f = ((s + n * 1.2 + (e.t % 7)) % 2.4) / 2.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + f * 16, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(couleur, 0.45 * (1 - f));
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    } else if (i === 3) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(couleur, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const survole = this._survol && this._survol.evt === e;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.9);
    g.addColorStop(0, hexA(couleur, (survole ? 0.5 : 0.28) * alpha));
    g.addColorStop(1, hexA(couleur, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
    if (RETOURS.has(e.nature)) {
      ctx.fillStyle = hexA(couleur, 0.12 * alpha);
      ctx.fill();
      ctx.strokeStyle = hexA(couleur, 0.95 * alpha);
      ctx.lineWidth = i >= 2 ? 2 : 1.4;
      ctx.stroke();
    } else {
      const c = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, 0, p.x, p.y, r);
      c.addColorStop(0, hexA("#ffffff", 0.9 * alpha));
      c.addColorStop(0.35, hexA(couleur, 0.95 * alpha));
      c.addColorStop(1, hexA(couleur, 0.55 * alpha));
      ctx.fillStyle = c;
      ctx.fill();
    }
    if (survole) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, .8)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function rayonPingIndex(importance) {
  const n = Math.round(Number(importance));
  return (Number.isFinite(n) ? borne(n, 1, 4) : 1) - 1;
}

function hexA(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${borne(a, 0, 1).toFixed(3)})`;
}
