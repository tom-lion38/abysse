// Disposition déterministe du graphe sur le plan (x, y), hauteur z par niveau.
//   - MikroTik en (0, 0) ;
//   - niveau 1 en secteurs par groupe autour du MikroTik, séparés par des allées vides ; le plus gros
//     groupe (pve) part vers ANGLE_PRINCIPAL, c'est-à-dire à droite dans la vue par défaut de la caméra ;
//   - CT/VM en deux anneaux décalés autour de pve, triés par vmid, avec une brèche face au MikroTik
//     (l'axone d'arrivée passe sans croiser personne ; l'onduleur, branché en USB, s'y loge) ;
//   - sites en éventail autour de leur CT (vers l'extérieur ; ceux de l'anneau intérieur passent au-delà
//     de l'anneau extérieur) ; Internet prolonge l'axe MikroTik → box ;
//   - relaxation anti-chevauchement (ordre fixe, aucun hasard) ;
//   - un nœud déjà posé ne bouge plus : un nouveau venu éclot près de son parent et se fait une place.

import { YAW_DEFAUT } from "./camera.js";

export const HAUTEURS = [120, 70, 35, 15];
/** Distance minimale garantie entre deux nœuds (hors couples fixés par l'utilisateur). */
export const ECART_MIN = 18;
/** Direction (rad) du plus gros groupe : le yaw par défaut de la caméra la met à droite de l'écran. */
export const ANGLE_PRINCIPAL = YAW_DEFAUT;

const RACINE = "mikrotik";
const TAU = Math.PI * 2;
/** Ordre des groupes du premier niveau, dans le sens trigonométrique à partir du groupe principal. */
const ORDRE_GROUPES = ["pve", "pbs", "synology", "internet", "appareils", "truenas", "onduleur", "ha", "reseau"];
const RANG_TYPE = ["routeur", "hyperviseur", "sauvegarde", "nas", "nas-vm", "box", "internet", "domotique", "switch",
  "onduleur", "pc", "appareil", "ct", "vm", "site"];
const RAYONS = { routeur: 34, hyperviseur: 30, box: 24, internet: 24, sauvegarde: 24, nas: 24, "nas-vm": 20,
  onduleur: 18, domotique: 18, pc: 16, switch: 15, ct: 16, vm: 16, appareil: 12, site: 11 };
const INVITES = new Set(["ct", "vm", "nas-vm"]);
/** Feuilles dont l'étiquette (nom + IP + jauge) est large : on leur réserve de la place sur les côtés. */
const ETIQUETTE_LARGE = new Set(["internet", "domotique", "switch", "appareil", "pc", "onduleur", "nas", "sauvegarde", "box"]);
const PLACE_ETIQUETTE = 22;
/** Enfants d'un anneau logés dans la brèche (près du parent) plutôt que sur l'anneau. */
const DANS_BRECHE = new Set(["onduleur"]);

const D_NIVEAU1 = 230;       // distance MikroTik → équipements de niveau 1
const L_EVENTAIL = 100;      // équipement → enfants en éventail
const L_SITES = 58;          // CT → sites
const OUVERTURE_MAX = 2.4;   // ouverture maximale d'un éventail (rad)
const SEUIL_ANNEAU = 7;      // à partir de ce nombre d'enfants : anneau (pve)
const SEUIL_DEUX_ANNEAUX = 12;
const R_ANNEAU = 205;        // rayon minimal de l'anneau (intérieur)
const DECALAGE = 56;         // écart entre l'anneau intérieur et l'anneau extérieur
const BRECHE = 0.8;          // ouverture (rad) laissée face au parent
const ALLEE = 0.2;           // allée (rad) minimale entre deux groupes du premier niveau
const ITERATIONS = 900;
const ITER_SANS_RAPPEL = 250;

const fini = (v) => typeof v === "number" && Number.isFinite(v);
const comparer = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function niveauDe(n) {
  const v = Math.trunc(Number(n.niveau));
  return Number.isFinite(v) ? Math.min(HAUTEURS.length - 1, Math.max(0, v)) : 2;
}
function rayonDe(n) {
  return RAYONS[n.type] ?? (n.id === RACINE ? 34 : 14);
}
function ecart(a, b) {
  return Math.max(ECART_MIN, a + b + 2);
}
function vmidDe(n) {
  const v = n.details && Number(n.details.vmid);
  if (Number.isFinite(v)) return v;
  const m = /^(?:ct|vm)-(\d+)$/.exec(n.id);
  return m ? Number(m[1]) : null;
}
function rangType(n) {
  const r = RANG_TYPE.indexOf(n.type);
  return r < 0 ? RANG_TYPE.length : r;
}
/** Ordre stable des enfants : les non-invités d'abord (par type puis id), puis les CT/VM par vmid. */
function trier(noeuds) {
  const l = noeuds.slice().sort((a, b) => {
    const va = vmidDe(a), vb = vmidDe(b);
    const ia = INVITES.has(a.type) && va !== null;
    const ib = INVITES.has(b.type) && vb !== null;
    if (ia !== ib) return ia ? 1 : -1;
    if (ia && ib && va !== vb) return va - vb;
    return comparer(rangType(a), rangType(b)) || comparer(a.id, b.id);
  });
  // Internet au milieu de l'éventail de la box : il prolonge l'axe MikroTik → box
  const i = l.findIndex((n) => n.type === "internet");
  if (i >= 0 && l.length > 1) {
    const [inet] = l.splice(i, 1);
    l.splice(Math.floor(l.length / 2), 0, inet);
  }
  return l;
}
function rangGroupe(g) {
  const i = ORDRE_GROUPES.indexOf(g);
  return i < 0 ? ORDRE_GROUPES.length : i;
}
const estSite = (n) => n.type === "site";

/* ------------------------------------------------------------------ arbre idéal */

/** Arbre couvrant : MikroTik (s'il existe) + orphelins (parent absent ou boucle) rattachés au centre. */
function construireArbre(graphe) {
  const enfants = new Map();
  for (const n of graphe.noeuds.values()) enfants.set(n.id, []);
  for (const n of graphe.noeuds.values()) {
    if (n.id !== RACINE && typeof n.parent === "string" && n.parent !== n.id && enfants.has(n.parent)) {
      enfants.get(n.parent).push(n);
    }
  }
  const atteints = new Set();
  const marquer = (id) => {
    const pile = [id];
    while (pile.length) {
      const c = pile.pop();
      if (atteints.has(c)) continue;
      atteints.add(c);
      for (const e of enfants.get(c)) pile.push(e.id);
    }
  };
  const centre = graphe.noeuds.get(RACINE) || null;
  if (centre) marquer(RACINE);
  // orphelins : parent absent (caché), pas de parent, ou boucle jamais atteinte depuis le MikroTik
  const orphelins = [];
  const ids = [...graphe.noeuds.keys()].sort(comparer);
  for (const id of ids) {
    const n = graphe.noeuds.get(id);
    if (atteints.has(id)) continue;
    const parentOk = typeof n.parent === "string" && n.parent !== id && graphe.noeuds.has(n.parent);
    if (!parentOk) { orphelins.push(n); marquer(id); }
  }
  for (const id of ids) {
    if (!atteints.has(id)) { orphelins.push(graphe.noeuds.get(id)); marquer(id); }
  }
  // dans une boucle, l'orphelin choisi ne doit pas se retrouver enfant d'un autre membre
  const estOrphelin = new Set(orphelins.map((n) => n.id));
  for (const [id, l] of enfants) enfants.set(id, trier(l.filter((e) => !estOrphelin.has(e.id))));
  const premiers = centre ? [...enfants.get(RACINE), ...orphelins] : orphelins;
  return { enfants, centre, premiers };
}

/** Répartition des enfants d'un parent en anneau : {anneau, breche, sites}. */
function partagerAnneau(enf) {
  const anneau = [], breche = [], sites = [];
  for (const c of enf) {
    if (estSite(c)) sites.push(c);
    else if (DANS_BRECHE.has(c.type)) breche.push(c);
    else anneau.push(c);
  }
  return { anneau, breche, sites };
}

/**
 * Encombrement d'un sous-arbre : w = demi-largeur latérale, e = portée radiale, mode = feuille | éventail | anneau.
 * `allonge` : longueur ajoutée aux liens vers les enfants (sites d'un CT de l'anneau intérieur).
 */
function mesurer(id, arbre, graphe, cache, pile = new Set()) {
  if (cache.has(id)) return cache.get(id);
  const n = graphe.noeuds.get(id);
  const r = rayonDe(n);
  const enf = pile.has(id) ? [] : arbre.enfants.get(id) || [];
  pile.add(id);
  let m;
  if (!enf.length) {
    m = { w: r + (ETIQUETTE_LARGE.has(n.type) ? PLACE_ETIQUETTE : 0), e: r, mode: "feuille" };
  } else {
    const ms = enf.map((c) => mesurer(c.id, arbre, graphe, cache, pile));
    const { anneau, breche, sites } = partagerAnneau(enf);
    if (anneau.length + breche.length >= SEUIL_ANNEAU && anneau.length) {
      const mA = anneau.map((c) => mesurer(c.id, arbre, graphe, cache, pile));
      const wMax = Math.max(...mA.map((c) => c.w));
      const deux = anneau.length >= SEUIL_DEUX_ANNEAUX;
      const pas = (TAU - BRECHE) / anneau.length;
      // deux voisins du même anneau sont à 2 pas (anneaux décalés) ou à 1 pas
      const R1 = Math.max(R_ANNEAU, r + wMax + 40, (2 * wMax + 8) / ((deux ? 2 : 1) * pas),
        sites.length ? L_SITES + 11 + wMax + 30 : 0, breche.length ? r + 70 + Math.max(...breche.map((c) => rayonDe(c))) : 0);
      const R2 = deux ? R1 + DECALAGE : R1;
      let e = R2;
      anneau.forEach((c, i) => {
        const interieur = deux && i % 2 === 0;
        const mc = mA[i];
        e = Math.max(e, (interieur ? R1 : R2) + mc.e + (interieur && mc.mode !== "feuille" ? DECALAGE : 0));
      });
      m = { w: e, e, mode: "anneau", R1, R2, deux, pas, sommeSites: Math.max(0, sites.length - 1) * 24 };
    } else {
      const L0 = enf[0].type === "site" ? L_SITES : L_EVENTAIL;
      let somme = 0;
      for (let i = 1; i < ms.length; i++) somme += ms[i - 1].w + ms[i].w + 6;
      const L = Math.max(L0, somme / OUVERTURE_MAX, r + Math.max(...ms.map((c) => c.w)) + 12);
      const demi = Math.min(Math.PI / 2, somme / L / 2);
      const w = Math.max(r, L * Math.sin(demi) + Math.max(...ms.map((c) => c.w)));
      m = { w, e: L + Math.max(...ms.map((c) => c.e)), mode: "eventail", L, somme };
    }
  }
  pile.delete(id);
  cache.set(id, m);
  return m;
}

/** Pose le sous-arbre de `id` (déjà posé dans `ideal`, regardant vers l'angle `theta`). */
function poserSousArbre(id, theta, arbre, graphe, cache, ideal) {
  const pile = [[id, theta, 0]];
  const faits = new Set();
  while (pile.length) {
    const [pid, th, allonge] = pile.pop();
    if (faits.has(pid)) continue;
    faits.add(pid);
    const enf = arbre.enfants.get(pid) || [];
    if (!enf.length) continue;
    const p = ideal.get(pid);
    const m = mesurer(pid, arbre, graphe, cache);
    const poser = (c, a, d, plus = 0) => {
      ideal.set(c.id, { x: p.x + d * Math.cos(a), y: p.y + d * Math.sin(a) });
      pile.push([c.id, a, plus]);
    };
    if (m.mode === "anneau") {
      const { anneau, breche, sites } = partagerAnneau(enf);
      const versParent = th + Math.PI;
      // invités : de part et d'autre de la brèche, dans l'ordre des vmid
      anneau.forEach((c, i) => {
        const a = versParent + BRECHE / 2 + m.pas * (i + 0.5);
        const interieur = m.deux && i % 2 === 0;
        poser(c, a, interieur ? m.R1 : m.R2, interieur ? DECALAGE : 0);
      });
      // dans la brèche, près du parent, en quinconce de part et d'autre de l'axone d'arrivée
      breche.forEach((c, j) => {
        const cote = j % 2 === 0 ? 1 : -1;
        const a = versParent + cote * (0.42 + 0.3 * Math.floor(j / 2));
        poser(c, a, Math.max(rayonDe(graphe.noeuds.get(pid)) + rayonDe(c) + 40, m.R1 * 0.55));
      });
      // sites directs : petit éventail à l'intérieur de l'anneau, à l'opposé du parent
      sites.forEach((c, k) => poser(c, th + (k * 24 - m.sommeSites / 2) / L_SITES, L_SITES));
    } else {
      let cumul = 0;
      enf.forEach((c, i) => {
        if (i > 0) cumul += cache.get(enf[i - 1].id).w + cache.get(c.id).w + 6;
        poser(c, th + (cumul - m.somme / 2) / m.L, m.L + allonge);
      });
    }
  }
}

/** Positions idéales de tout le graphe (sans tenir compte de ce qui est déjà posé). */
function positionsIdeales(graphe) {
  const arbre = construireArbre(graphe);
  const cache = new Map();
  const ideal = new Map();
  const rCentre = arbre.centre ? rayonDe(arbre.centre) : 0;
  if (arbre.centre) ideal.set(RACINE, { x: 0, y: 0 });

  // secteurs : un par groupe, dans un ordre fixe
  const parGroupe = new Map();
  for (const n of arbre.premiers) {
    const g = typeof n.groupe === "string" ? n.groupe : "";
    if (!parGroupe.has(g)) parGroupe.set(g, []);
    parGroupe.get(g).push(n);
  }
  const unites = [...parGroupe.entries()]
    .sort(([a], [b]) => comparer(rangGroupe(a), rangGroupe(b)) || comparer(a, b))
    .map(([, l]) => trier(l));
  if (!unites.length) return { ideal, arbre };

  // besoin angulaire de chaque membre ; on éloigne tout le monde tant que ça ne tient pas sur le cercle
  let echelle = 1, membres = [];
  const allees = unites.length > 1 ? unites.length * ALLEE : 0;
  for (let essai = 0; essai < 40; essai++) {
    membres = [];
    let total = 0;
    for (const [u, liste] of unites.entries()) {
      const feuilles = liste.filter((n) => mesurer(n.id, arbre, graphe, cache).mode === "feuille").length;
      let rangee = 0;
      for (const n of liste) {
        const m = mesurer(n.id, arbre, graphe, cache);
        const feuille = m.mode === "feuille";
        let d = Math.max(D_NIVEAU1, m.e + rCentre + 70) * echelle;
        const deuxRangs = feuille && feuilles > 3;
        if (deuxRangs) d += (rangee++ % 2) * 46 * echelle;
        const besoin = 2 * Math.asin(Math.min(0.98, (Math.max(m.w, m.e * (feuille ? 1 : 0.85)) + 10) / d)) * (deuxRangs ? 0.55 : 1);
        membres.push({ n, u, d, besoin });
        total += besoin;
      }
    }
    if (total + allees <= TAU * 0.92) break;
    echelle *= 1.12;
  }
  const total = membres.reduce((s, m) => s + m.besoin, 0);
  const reste = Math.max(0, TAU - total);
  const entreUnites = unites.length > 1 ? Math.max(ALLEE, (0.6 * reste) / unites.length) : 0;
  const parMembre = Math.max(0, reste - entreUnites * unites.length) / membres.length;
  let a = 0, centreU0 = null, uPrec = -1, debutU = 0;
  const angles = [];
  for (const m of membres) {
    if (m.u !== uPrec) {
      if (uPrec === 0) centreU0 = (debutU + a) / 2;
      if (uPrec >= 0) a += entreUnites;
      debutU = a;
      uPrec = m.u;
    }
    const largeur = m.besoin + parMembre;
    angles.push(a + largeur / 2);
    a += largeur;
  }
  if (centreU0 === null) centreU0 = (debutU + a) / 2;
  const rotation = ANGLE_PRINCIPAL - centreU0; // le premier groupe (pve) à droite dans la vue par défaut
  membres.forEach((m, i) => {
    const th = angles[i] + rotation;
    ideal.set(m.n.id, { x: m.d * Math.cos(th), y: m.d * Math.sin(th) });
    poserSousArbre(m.n.id, th, arbre, graphe, cache, ideal);
  });
  return { ideal, arbre };
}

/* ------------------------------------------------------------------ relaxation */

function relaxer(liste, mobile, cibles) {
  const N = liste.length;
  const xs = new Float64Array(N), ys = new Float64Array(N), rs = new Float64Array(N);
  const cx = new Float64Array(N), cy = new Float64Array(N);
  const mob = new Uint8Array(N);
  let nbMobiles = 0;
  liste.forEach((n, i) => {
    xs[i] = n.x; ys[i] = n.y; rs[i] = rayonDe(n);
    if (mobile.has(n.id)) {
      mob[i] = 1; nbMobiles++;
      const c = cibles.get(n.id);
      cx[i] = c.x; cy[i] = c.y;
    }
  });
  if (!nbMobiles) return;
  for (let it = 0; it < ITERATIONS + 2000; it++) {
    let pire = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (!mob[i] && !mob[j]) continue;
        const s = ecart(rs[i], rs[j]);
        let dx = xs[j] - xs[i], dy = ys[j] - ys[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= s * s) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-9) {
          // superposés : direction fixe tirée des indices (aucun hasard)
          const ang = ((i * 7919 + j * 104729) % 360) * (Math.PI / 180);
          dx = Math.cos(ang); dy = Math.sin(ang); d = 0;
        } else {
          dx /= d; dy /= d;
        }
        const recouvrement = s - d;
        if (recouvrement > pire) pire = recouvrement;
        const pousse = recouvrement + 0.01;
        if (mob[i] && mob[j]) {
          xs[i] -= dx * pousse / 2; ys[i] -= dy * pousse / 2;
          xs[j] += dx * pousse / 2; ys[j] += dy * pousse / 2;
        } else if (mob[i]) {
          xs[i] -= dx * pousse; ys[i] -= dy * pousse;
        } else {
          xs[j] += dx * pousse; ys[j] += dy * pousse;
        }
      }
    }
    if (pire <= 0) break;
    if (it < ITERATIONS - ITER_SANS_RAPPEL) {
      // léger rappel vers la place idéale : garde la structure (anneaux, éventails)
      for (let i = 0; i < N; i++) {
        if (!mob[i]) continue;
        xs[i] += (cx[i] - xs[i]) * 0.02;
        ys[i] += (cy[i] - ys[i]) * 0.02;
      }
    }
  }
  liste.forEach((n, i) => {
    if (mob[i]) { n.x = xs[i]; n.y = ys[i]; }
  });
}

/* ------------------------------------------------------------------ point d'entrée */

/**
 * Pose les nœuds de `graphe` (x, y, z écrits sur les nœuds).
 * `sauvegarde` : positions mémorisées par le navigateur (nœuds déplacés à la main), prioritaires.
 * Déterministe ; un nœud déjà posé (x, y finis) n'est jamais déplacé.
 */
export function disposer(graphe, sauvegarde = new Map()) {
  if (!graphe || !graphe.noeuds || !graphe.noeuds.size) return;
  const lireSauvegarde = (id) => {
    const p = sauvegarde && typeof sauvegarde.get === "function" ? sauvegarde.get(id) : null;
    return p && fini(p.x) && fini(p.y) ? p : null;
  };

  const aPoser = [];
  for (const n of graphe.noeuds.values()) {
    n.z = HAUTEURS[niveauDe(n)];
    const s = lireSauvegarde(n.id);
    if (s) { n.x = s.x; n.y = s.y; continue; }
    if (!fini(n.x) || !fini(n.y)) aPoser.push(n);
  }
  if (!aPoser.length) return;

  const { ideal, arbre } = positionsIdeales(graphe);
  const nouveaux = new Set(aPoser.map((n) => n.id));
  const cibles = new Map();

  // parcours en largeur de l'arbre idéal : chaque nouveau venu se place par rapport à la position réelle de son parent
  const file = [];
  if (arbre.centre) file.push(RACINE);
  for (const n of arbre.premiers) file.push(n.id);
  const vus = new Set();
  for (let i = 0; i < file.length; i++) {
    const id = file[i];
    if (vus.has(id)) continue;
    vus.add(id);
    for (const e of arbre.enfants.get(id) || []) file.push(e.id);
    if (!nouveaux.has(id)) continue;
    const n = graphe.noeuds.get(id);
    const ici = ideal.get(id) || { x: 0, y: 0 };
    let cible = { x: ici.x, y: ici.y };
    if (id === RACINE) cible = { x: 0, y: 0 };
    else {
      const parent = typeof n.parent === "string" ? graphe.noeuds.get(n.parent) : null;
      const ip = parent && ideal.get(parent.id);
      const pp = parent && (cibles.get(parent.id) || (fini(parent.x) && fini(parent.y) ? parent : null));
      if (ip && pp) cible = { x: pp.x + ici.x - ip.x, y: pp.y + ici.y - ip.y };
    }
    if (!fini(cible.x) || !fini(cible.y)) cible = { x: 0, y: 0 };
    cibles.set(id, cible);
  }
  for (const n of aPoser) {
    const c = cibles.get(n.id) || { x: 0, y: 0 };
    cibles.set(n.id, c);
    n.x = c.x;
    n.y = c.y;
  }

  const mobiles = new Set(nouveaux);
  mobiles.delete(RACINE); // le MikroTik reste en (0, 0)
  const liste = [...graphe.noeuds.values()].sort((a, b) => comparer(a.id, b.id));
  relaxer(liste, mobiles, cibles);
  for (const n of aPoser) {
    if (!fini(n.x) || !fini(n.y)) { n.x = cibles.get(n.id).x; n.y = cibles.get(n.id).y; }
  }
}
