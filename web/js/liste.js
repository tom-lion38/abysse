// Onglet Liste : tous les éléments et leurs liens, groupés par machine (MikroTik, pve, PBS, …),
// recherche instantanée insensible à la casse et aux accents (nom, IP, URL), pastille d'état.
//
// `normaliser`, `filtrer`, `entreesDepuis`, `grouper` et `decouper` sont des fonctions pures (testées sous Node).
// Le DOM est construit avec createElement + textContent ; les termes trouvés sont surlignés par des <mark>
// créés en DOM : jamais d'innerHTML avec du texte de données.

import { liensDuNoeud } from "./interactions.js";
import { GROUPES } from "./couleurs.js";

const RACINE = "mikrotik";
/** Ordre des groupes ; les autres machines suivent par ordre alphabétique. */
const ORDRE_MACHINES = ["mikrotik", "pve", "pbs", "synology", "box"];
/** Rattachés directement au MikroTik sans être des machines à eux seuls : rangés avec lui. */
const TYPES_SANS_GROUPE = new Set(["appareil", "pc"]);
const ETATS_CONNUS = new Set(["on", "off", "eteint", "inconnu"]);
export const ETATS_TEXTE = Object.freeze({ on: "En ligne", off: "En panne", eteint: "Éteint", inconnu: "État inconnu" });

const COLLATION = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/* ------------------------------------------------------------------ recherche */

const LIGATURES = { "œ": "oe", "æ": "ae", "ß": "ss" };

/** Minuscules, sans accents ni signes diacritiques : « Rénovation » → « renovation ». */
export function normaliser(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[œæß]/g, (c) => LIGATURES[c]);
}

function termes(requete) {
  return normaliser(requete).split(/\s+/).filter(Boolean);
}

function texteRecherche(e) {
  return normaliser([e.nom, e.ip, e.url].filter((v) => typeof v === "string" && v).join(" "));
}

/** Entrées dont le nom, l'IP ou l'URL contiennent tous les mots de la requête (vide = toutes). */
export function filtrer(entrees, requete) {
  const liste = Array.isArray(entrees) ? entrees : [];
  const mots = termes(requete);
  if (!mots.length) return liste.slice();
  return liste.filter((e) => {
    const h = texteRecherche(e);
    return mots.every((m) => h.includes(m));
  });
}

/**
 * Découpe `texte` en segments [{texte, mark}] : `mark` vrai sur les mots de la requête trouvés
 * (sans tenir compte des accents ni de la casse). Le texte d'origine est conservé tel quel.
 */
export function decouper(texte, requete) {
  const s = texte === null || texte === undefined ? "" : String(texte);
  if (!s) return [];
  const mots = termes(requete);
  if (!mots.length) return [{ texte: s, mark: false }];

  const car = Array.from(s);
  let norm = "";
  const origine = []; // indice UTF-16 dans `norm` → indice du caractère d'origine
  car.forEach((c, i) => {
    const n = normaliser(c);
    norm += n;
    for (let k = 0; k < n.length; k++) origine.push(i);
  });

  const marque = new Array(car.length).fill(false);
  for (const m of mots) {
    let p = norm.indexOf(m);
    while (p !== -1) {
      for (let k = p; k < p + m.length; k++) marque[origine[k]] = true;
      p = norm.indexOf(m, p + 1);
    }
  }

  const out = [];
  for (let i = 0; i < car.length; i++) {
    const der = out[out.length - 1];
    if (der && der.mark === marque[i]) der.texte += car[i];
    else out.push({ texte: car[i], mark: marque[i] });
  }
  return out;
}

/* ------------------------------------------------------------------ entrées */

function vmid(n) {
  const v = Number(n.details && n.details.vmid);
  if (Number.isInteger(v) && v > 0) return v;
  const m = /^(?:ct|vm)-(\d+)$/.exec(n.id || "");
  return m ? Number(m[1]) : Infinity;
}

/** Rang de tri des enfants : équipements, puis CT/VM par numéro, puis sites par nom. */
function rang(n) {
  if (n.type === "ct" || n.type === "vm" || n.type === "nas-vm") return 1;
  if (n.type === "site") return 2;
  return 0;
}

function comparerNoeuds(a, b) {
  const ra = rang(a), rb = rang(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    const d = vmid(a) - vmid(b);
    if (d) return d;
  }
  return COLLATION.compare(String(a.nom || a.id), String(b.nom || b.id)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Machine (id) à laquelle rattacher un nœud, et sa profondeur sous elle. */
function machineDe(graphe, id) {
  const ch = graphe.chaine(id);
  if (!ch.length) return { machineId: id, profondeur: 0 };
  if (ch[ch.length - 1] !== RACINE) return { machineId: ch[ch.length - 1], profondeur: ch.length - 1 };
  if (ch.length === 1) return { machineId: RACINE, profondeur: 0 };
  const haut = graphe.noeuds.get(ch[ch.length - 2]);
  if (haut && TYPES_SANS_GROUPE.has(haut.type)) return { machineId: RACINE, profondeur: ch.length - 1 };
  return { machineId: haut ? haut.id : id, profondeur: ch.length - 2 };
}

function ipDe(n, graphe) {
  if (typeof n.ip === "string" && n.ip) return n.ip;
  // un site n'a pas d'IP propre : celle de son CT (l'amont du proxy) le rend trouvable par IP
  if (n.type === "site") {
    const p = graphe.noeuds.get(n.parent);
    if (p && typeof p.ip === "string" && p.ip) return p.ip;
  }
  return null;
}

function rangMachine(id) {
  const i = ORDRE_MACHINES.indexOf(id);
  return i === -1 ? ORDRE_MACHINES.length : i;
}

/**
 * Une entrée par nœud du graphe, groupées par machine (blocs contigus, la machine en tête de son bloc,
 * puis ses descendants en profondeur : CT/VM par numéro, chaque CT suivi de ses sites) :
 * [{id, nom, url, ip, etat, machine, machineId, profondeur, type, groupe}].
 */
export function entreesDepuis(graphe) {
  if (!graphe || !(graphe.noeuds instanceof Map)) return [];
  const infos = new Map();
  for (const n of graphe.noeuds.values()) infos.set(n.id, machineDe(graphe, n.id));

  const entree = (n) => {
    const { machineId, profondeur } = infos.get(n.id);
    const m = graphe.noeuds.get(machineId);
    const lien = liensDuNoeud(n)[0];
    return {
      id: n.id,
      nom: typeof n.nom === "string" && n.nom ? n.nom : n.id,
      url: lien ? lien.url : null,
      ip: ipDe(n, graphe),
      etat: ETATS_CONNUS.has(n.etat) ? n.etat : "inconnu",
      machine: m && typeof m.nom === "string" && m.nom ? m.nom : machineId,
      machineId,
      profondeur,
      type: typeof n.type === "string" ? n.type : "",
      groupe: typeof n.groupe === "string" ? n.groupe : "",
    };
  };

  const machines = [...new Set([...infos.values()].map((i) => i.machineId))];
  const nomMachine = (id) => {
    const m = graphe.noeuds.get(id);
    return String((m && m.nom) || id);
  };
  machines.sort((a, b) => rangMachine(a) - rangMachine(b) || COLLATION.compare(nomMachine(a), nomMachine(b)));

  const out = [];
  const places = new Set();
  const parcourir = (id, machineId) => {
    const n = graphe.noeuds.get(id);
    if (!n || places.has(id) || infos.get(id).machineId !== machineId) return;
    places.add(id);
    out.push(entree(n));
    const enfants = graphe.enfants(id).map((e) => graphe.noeuds.get(e)).filter(Boolean).sort(comparerNoeuds);
    for (const e of enfants) parcourir(e.id, machineId);
  };
  for (const m of machines) {
    parcourir(m, m);
    // filet de sécurité : nœuds du bloc non atteints par le parcours (boucle de parents, par exemple)
    const restes = [...graphe.noeuds.values()].filter((n) => !places.has(n.id) && infos.get(n.id).machineId === m);
    for (const n of restes.sort(comparerNoeuds)) {
      places.add(n.id);
      out.push(entree(n));
    }
  }
  return out;
}

/** Regroupe des entrées contiguës par machine : [{machineId, machine, entrees}]. */
export function grouper(entrees) {
  const out = [];
  const index = new Map();
  for (const e of Array.isArray(entrees) ? entrees : []) {
    let g = index.get(e.machineId);
    if (!g) {
      g = { machineId: e.machineId, machine: e.machine, entrees: [] };
      index.set(e.machineId, g);
      out.push(g);
    }
    g.entrees.push(e);
  }
  return out;
}

/** Texte court de l'URL (sans schéma ni barre finale), ou null s'il n'apprend rien de plus que le nom. */
export function urlCourte(e) {
  if (!e || !e.url) return null;
  if (/^https:\/\/pve\.lan\/#v1:/.test(e.url)) return "Page Proxmox";
  const court = e.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return normaliser(court) === normaliser(e.nom) || court === e.ip ? null : court;
}

/* ------------------------------------------------------------------ DOM */

function el(tag, classe, texte) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texte !== undefined && texte !== null) n.textContent = texte;
  return n;
}

/** Remplit `noeud` avec le texte, les mots de la requête dans des <mark> (DOM, pas de HTML). */
function poserSurligne(noeud, texte, requete) {
  const morceaux = decouper(texte, requete);
  noeud.replaceChildren(...morceaux.map((m) => (m.mark ? el("mark", null, m.texte) : document.createTextNode(m.texte))));
}

function poserEtat(pastille, etat) {
  const c = `pastille etat-${etat}`;
  if (pastille.className !== c) pastille.className = c;
  const t = ETATS_TEXTE[etat];
  if (pastille.title !== t) pastille.title = t;
}

/** État d'une ligne : pastille, son texte pour les lecteurs d'écran, et `data-etat` (couleur du nom en CSS). */
function poserEtatLigne(l, etat) {
  poserEtat(l.pastille, etat);
  if (l.ligne.dataset.etat !== etat) l.ligne.dataset.etat = etat;
  const t = ETATS_TEXTE[etat];
  if (l.pastille.getAttribute("aria-label") !== t) l.pastille.setAttribute("aria-label", t);
}

const pluriel = (n, un, plusieurs) => `${n}${" "}${n > 1 ? plusieurs : un}`;

export class Liste {
  /**
   * @param {HTMLElement} racine  conteneur `#liste`
   * @param {{surDetails?: (id: string) => void, ouvrir?: (url: string) => void}} options
   */
  constructor(racine, { surDetails = null, ouvrir = null } = {}) {
    this.racine = racine;
    this.surDetails = typeof surDetails === "function" ? surDetails : null;
    this.ouvrir = typeof ouvrir === "function" ? ouvrir : (url) => window.open(url, "_blank", "noopener");
    this._graphe = null;
    this._signature = null;
    this._lignes = new Map();   // id → {ligne, pastille}
    this._tetes = new Map();    // machineId → {pastille, nb}
    this._resultats = [];

    const cadre = el("div", "vl-cadre");
    const tete = el("div", "vl-tete");
    const etiquette = el("label", "sr", "Rechercher dans la liste");
    etiquette.htmlFor = "listeRecherche";
    this.champ = el("input", "vl-recherche");
    this.champ.id = "listeRecherche";
    this.champ.type = "search";
    this.champ.placeholder = "Rechercher un nom, une IP, une adresse…";
    this.champ.autocomplete = "off";
    this.champ.spellcheck = false;
    this.champ.setAttribute("enterkeyhint", "go");
    this.champ.setAttribute("aria-describedby", "listeCompte");
    this.compte = el("span", "vl-compte");
    this.compte.id = "listeCompte";
    this.compte.setAttribute("aria-live", "polite");
    const aide = el("span", "vl-aide", "Entrée ouvre le premier résultat · Échap revient à la carte");
    tete.append(etiquette, this.champ, this.compte, aide);

    this.grille = el("div", "vl-grille");
    this.vide = el("p", "vl-vide", "En attente des données…");
    cadre.append(tete, this.grille, this.vide);
    racine.replaceChildren(cadre);

    this.champ.addEventListener("input", () => this._rendre(true));
    this.champ.addEventListener("keydown", (e) => this._clavier(e));
  }

  /** Met la liste à jour depuis le graphe (bon marché si rien n'a changé que les états). */
  afficher(graphe) {
    if (graphe) this._graphe = graphe;
    if (this.racine.hidden) { this._signature = null; return; }
    this._rendre(false);
  }

  /** Donne le focus au champ de recherche (raccourci `/`). */
  focus() {
    if (this._graphe && this._signature === null) this._rendre(false);
    this.champ.focus({ preventScroll: true });
    this.champ.select();
  }

  get requete() { return this.champ.value; }

  _clavier(e) {
    if (e.key === "Enter") {
      const premier = this._resultats[0];
      if (!premier) return;
      e.preventDefault();
      if (premier.url) this.ouvrir(premier.url);
      else if (this.surDetails) this.surDetails(premier.id);
    } else if (e.key === "ArrowDown") {
      const lien = this.grille.querySelector(".vl-nom");
      if (lien) { e.preventDefault(); lien.focus(); }
    }
  }

  _rendre(force) {
    const toutes = entreesDepuis(this._graphe);
    const q = this.champ.value;
    const res = filtrer(toutes, q);
    this._resultats = res;
    const signature = q + "\u0003" + res.map((e) =>
      [e.id, e.nom, e.url, e.ip, e.machineId, e.machine, e.profondeur].join("\u0001")).join("\u0002");

    if (!force && signature === this._signature) {
      for (const e of res) {
        const l = this._lignes.get(e.id);
        if (l) poserEtatLigne(l, e.etat);
        const t = this._tetes.get(e.id);
        if (t) poserEtat(t.pastille, e.etat);
      }
      return;
    }
    this._signature = signature;
    this._construire(toutes, res, q);
  }

  _construire(toutes, res, q) {
    this._lignes = new Map();
    this._tetes = new Map();
    const blocs = [];
    for (const g of grouper(res)) blocs.push(this._groupe(g, q));
    this.grille.replaceChildren(...blocs);

    const n = res.length;
    this.compte.textContent = q.trim() ? pluriel(n, "résultat", "résultats") : pluriel(n, "élément", "éléments");
    this.vide.hidden = n > 0;
    if (!n) {
      this.vide.textContent = !toutes.length ? "En attente des données…" : `Aucun résultat pour « ${q.trim()} ».`;
    }
  }

  _groupe(g, q) {
    const sec = el("section", "vl-groupe");
    const graphe = this._graphe;
    const machine = graphe && graphe.noeuds.get(g.machineId);
    const teinte = machine && GROUPES[machine.groupe];
    if (teinte) sec.style.setProperty("--teinte", teinte);

    const h = el("h2");
    const pastille = el("i");
    pastille.setAttribute("aria-hidden", "true");
    poserEtat(pastille, machine && ETATS_CONNUS.has(machine.etat) ? machine.etat : "inconnu");
    this._tetes.set(g.machineId, { pastille });
    const titre = el("span", "vl-titre");
    poserSurligne(titre, g.machine, q);
    const nb = el("span", "vl-nb", String(g.entrees.length));
    nb.title = pluriel(g.entrees.length, "élément", "éléments");
    h.append(pastille, titre, nb);
    sec.append(h);

    for (const e of g.entrees) sec.append(this._ligne(e, q));
    return sec;
  }

  _ligne(e, q) {
    const ligne = el("div", "vl-ligne");
    ligne.dataset.id = e.id;
    if (e.profondeur > 0) ligne.style.setProperty("--profondeur", String(Math.min(e.profondeur, 4)));

    const pastille = el("i");
    pastille.setAttribute("role", "img");
    const l = { ligne, pastille };
    poserEtatLigne(l, e.etat);
    this._lignes.set(e.id, l);

    const texte = el("div", "vl-texte");
    let nom;
    if (e.url) {
      nom = el("a", "vl-nom");
      nom.href = e.url;
      nom.target = "_blank";
      nom.rel = "noopener noreferrer";
      nom.title = e.url;
    } else {
      nom = el("button", "vl-nom vl-sans-lien");
      nom.type = "button";
      nom.title = "Voir les détails";
      if (this.surDetails) nom.addEventListener("click", () => this.surDetails(e.id));
    }
    poserSurligne(nom, e.nom, q);
    texte.append(nom);
    const court = urlCourte(e);
    if (court) {
      const u = el("span", "vl-url");
      poserSurligne(u, court, q);
      texte.append(u);
    }

    const fin = el("span", "vl-fin");
    if (e.ip) {
      const ip = el("span", "vl-ip");
      poserSurligne(ip, e.ip, q);
      fin.append(ip);
    }
    if (this.surDetails) {
      const info = el("button", "vl-info", "i");
      info.type = "button";
      info.title = "Détails";
      info.setAttribute("aria-label", `Détails de ${e.nom}`);
      info.addEventListener("click", () => this.surDetails(e.id));
      fin.append(info);
    }

    ligne.append(pastille, texte, fin);
    return ligne;
  }
}
