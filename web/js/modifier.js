// Mode « modifier » : renommer, cacher / remontrer, « éteint exprès », ajouter / corriger / retirer des liens.
//
// Ouvert à tous sur le LAN (choix assumé : pas de compte, LAN et VPN seulement) : chaque saisie est d'abord vérifiée ici avec exactement la même
// règle que le serveur (abysse/reglages.py), puis envoyée à `POST /api/reglages`, qui la revalide. Les
// messages d'erreur du serveur sont affichés tels quels. Tout texte (noms, URL, messages) passe par
// `textContent` ou `.value` : jamais `innerHTML`.
//
// En mode modifier, un clic sur un nœud ouvre son menu au lieu d'ouvrir son lien (crochet
// `interactions.interception`) ; un panneau « Mode modifier » liste les éléments masqués pour les remontrer.

export const NOM_MAX = 40;
export const URL_MAX = 200;

/** Caractères que Python considère comme des espaces (`str.isspace`, `\s` de `re`) : pas tout à fait le `\s` de JS. */
const ESPACES = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Même règle que `reglages.URL_RE` : `^https?://[^\s<>"'\`]{1,200}$` (longueur en caractères, comme Python). */
const URL_RE = new RegExp(`^https?://[^${ESPACES}<>"'\`]{1,${URL_MAX}}$`, "u");
const BORDS_RE = new RegExp(`^[${ESPACES}]+|[${ESPACES}]+$`, "gu");
const CONTROLE_RE = /[\x00-\x1f\x7f]/;

const MESSAGE_URL =
  "Adresse refusée : elle doit commencer par http:// ou https://, sans espace, " +
  "guillemet ni chevron, et faire 200 caractères au plus après le schéma.";

/** `str.strip()` de Python. */
export function nettoyer(s) {
  return typeof s === "string" ? s.replace(BORDS_RE, "") : s;
}

/** Raison du refus d'un nom (message du serveur), ou null s'il est accepté. */
export function raisonNom(nom) {
  if (typeof nom !== "string" || !nettoyer(nom)) return "Le nom ne peut pas être vide.";
  const n = nettoyer(nom);
  if ([...n].length > NOM_MAX) return `Le nom ne doit pas dépasser ${NOM_MAX} caractères.`;
  if (n.includes("<") || n.includes(">")) return "Le nom ne doit contenir ni « < » ni « > ».";
  if (CONTROLE_RE.test(n)) return "Le nom contient des caractères de contrôle.";
  return null;
}

/** Raison du refus d'une adresse (message du serveur), ou null si elle est acceptée. */
export function raisonUrl(url) {
  return typeof url === "string" && URL_RE.test(url) ? null : MESSAGE_URL;
}

export const nomValide = (nom) => raisonNom(nom) === null;
export const urlValide = (url) => raisonUrl(url) === null;

/* ------------------------------------------------------------------ réglages */

const estSite = (n) => !!n && (n.type === "site" || /^(?:site|lien)-/.test(n.id || ""));
const SANS_ETEINT = new Set(["site", "appareil"]);

/** Réglages de l'API ramenés à une forme sûre : {noms, caches, eteints_expres, liens}. */
export function normaliserReglages(r) {
  const o = r && typeof r === "object" ? r : {};
  const chaines = (l) => (Array.isArray(l) ? l.filter((x) => typeof x === "string") : []);
  const noms = {};
  if (o.noms && typeof o.noms === "object") {
    for (const [k, v] of Object.entries(o.noms)) if (typeof v === "string") noms[k] = v;
  }
  return {
    noms,
    caches: chaines(o.caches),
    eteints_expres: chaines(o.eteints_expres),
    liens: Array.isArray(o.liens) ? o.liens.filter((l) => l && typeof l === "object") : [],
  };
}

function compterDescendants(graphe, id) {
  if (!graphe || typeof graphe.enfants !== "function") return 0;
  let n = 0;
  const vus = new Set([id]);
  const pile = [id];
  while (pile.length) {
    for (const e of graphe.enfants(pile.pop()) || []) {
      if (vus.has(e)) continue;
      vus.add(e);
      pile.push(e);
      n++;
    }
  }
  return n;
}

/**
 * Actions proposées dans le menu d'un nœud, dans l'ordre :
 * [{cle, action, libelle, valeur?, retablir?, confirmer?}] (`action` = action du serveur).
 */
export function actionsDuNoeud(n, reglages = null, graphe = null) {
  if (!n || typeof n.id !== "string") return [];
  const r = normaliserReglages(reglages);
  const out = [{ cle: "renommer", action: "renommer", libelle: "Renommer…" }];
  if (Object.prototype.hasOwnProperty.call(r.noms, n.id)) {
    out.push({ cle: "retablir", action: "renommer", retablir: true, libelle: "Rétablir le nom d’origine" });
  }
  const d = compterDescendants(graphe, n.id);
  out.push({
    cle: "cacher", action: "cacher",
    libelle: d ? `Cacher (avec ${d} élément${d > 1 ? "s" : ""} rattaché${d > 1 ? "s" : ""})` : "Cacher",
  });
  if (estSite(n)) {
    out.push({ cle: "modifier_lien", action: "modifier_lien", libelle: "Modifier le lien…" });
    const manuel = n.id.startsWith("lien-");
    out.push({
      cle: "retirer_lien", action: "retirer_lien", confirmer: manuel,
      libelle: manuel ? "Supprimer ce lien" : "Retirer ce site (il passe dans « Masqués »)",
    });
    return out;
  }
  if (!SANS_ETEINT.has(n.type)) {
    const deja = r.eteints_expres.includes(n.id);
    out.push({
      cle: "eteint_expres", action: "eteint_expres", valeur: !deja,
      libelle: deja ? "Retirer « éteint exprès »" : "Marquer « éteint exprès »",
    });
  }
  if (n.type !== "appareil") out.push({ cle: "ajouter_lien", action: "ajouter_lien", libelle: "+ lien" });
  return out;
}

/* ------------------------------------------------------------------ serveur */

const fetchParDefaut = (...a) => globalThis.fetch(...a);

/** Envoie une modification : {ok: true, reglages} ou {ok: false, erreur} (message du serveur tel quel). */
export async function envoyerModif(modif, requete = fetchParDefaut) {
  let rep;
  try {
    rep = await requete("/api/reglages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modif),
      cache: "no-store",
    });
  } catch {
    return { ok: false, erreur: "Le serveur ne répond pas : modification non enregistrée." };
  }
  let corps = null;
  try { corps = await rep.json(); } catch { corps = null; }
  if (rep.ok) return { ok: true, reglages: corps };
  if (corps && typeof corps.erreur === "string" && corps.erreur) return { ok: false, erreur: corps.erreur };
  return { ok: false, erreur: `Le serveur a refusé la modification (erreur ${rep.status}).` };
}

/** Réglages actuels (`GET /api/reglages`), ou null si le serveur ne répond pas. */
export async function chargerReglages(requete = fetchParDefaut) {
  try {
    const rep = await requete("/api/reglages", { cache: "no-store" });
    return rep.ok ? await rep.json() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ interface */

function el(tag, classe = "", texte = null) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte !== null && texte !== undefined) e.textContent = String(texte);
  return e;
}

function bouton(texte, classe = "", type = "button") {
  const b = el("button", classe, texte);
  b.type = type;
  b.setAttribute("type", type);
  return b;
}

function dans(noeud, conteneur) {
  for (let n = noeud; n; n = n.parentNode) if (n === conteneur) return true;
  return false;
}

const fini = (v) => typeof v === "number" && Number.isFinite(v);

export class ModeModifier {
  /**
   * @param {object} o
   *   bouton : bouton « Modifier » de la barre (bascule le mode, porte `aria-pressed`) ;
   *   interactions : objet dont on remplit `interception` ; graphe ; rendu (pour `ecran(id)`) ; canvas ;
   *   racine : où poser le menu et le panneau « Masqués » (document.body) ; corps : reçoit `mode-modifier` ;
   *   requete : fetch (injectable pour les tests) ; annoncer(texte) : lecteurs d'écran ;
   *   surChange(reglages) : appelé après chaque modification enregistrée.
   */
  constructor({
    bouton: boutonModifier = null, interactions = null, graphe = null, rendu = null, canvas = null,
    racine = null, corps = null, requete = fetchParDefaut, annoncer = () => {}, surChange = () => {},
  } = {}) {
    this.bouton = boutonModifier;
    this.interactions = interactions;
    this.graphe = graphe;
    this.rendu = rendu;
    this.canvas = canvas;
    this.racine = racine || document.body;
    this.corps = corps || document.body;
    this.requete = requete;
    this.annoncer = annoncer;
    this.surChange = surChange;

    this.actif = false;
    this.reglages = normaliserReglages(null);
    /** Dernière opération asynchrone (chargement, envoi) : les tests l'attendent. */
    this.pret = Promise.resolve();
    this._cible = null;
    this._formulaire = null; // {type, nom, url, parent}
    this._confirmer = null;
    this._envoi = false;
    this._version = 0;
    /** Noms vus dans le graphe : un nœud masqué n'est plus dans l'instantané. */
    this._noms = new Map();

    this._intercepter = (id, e) => this._surClic(id, e);
    this._surPointeur = (e) => {
      if (!this._menu.hidden && !dans(e.target, this._menu)) this.fermerMenu();
    };

    this._construire();
    if (this.bouton) {
      this.bouton.setAttribute("aria-pressed", "false");
      this.bouton.addEventListener("click", () => this.basculer());
    }
  }

  /* ---------------------------------------------------------------- activation */

  activer() {
    if (this.actif) return this.pret;
    this.actif = true;
    this.corps.classList.add("mode-modifier");
    if (this.bouton) this.bouton.setAttribute("aria-pressed", "true");
    if (this.interactions) this.interactions.interception = this._intercepter;
    if (typeof document.addEventListener === "function") document.addEventListener("pointerdown", this._surPointeur, true);
    this._retenirNoms();
    this._majMasques();
    this.annoncer("Mode modifier activé : cliquez sur un élément de la carte pour le modifier.");
    const version = this._version;
    return this._lancer(chargerReglages(this.requete).then((r) => {
      if (r && version === this._version) {
        this.reglages = normaliserReglages(r);
        this._majMasques();
      }
    }));
  }

  desactiver() {
    if (!this.actif) return;
    this.actif = false;
    this.corps.classList.remove("mode-modifier");
    if (this.bouton) this.bouton.setAttribute("aria-pressed", "false");
    if (this.interactions && this.interactions.interception === this._intercepter) this.interactions.interception = null;
    if (typeof document.removeEventListener === "function") document.removeEventListener("pointerdown", this._surPointeur, true);
    this.fermerMenu();
    this._masques.hidden = true;
    this.annoncer("Mode modifier terminé.");
  }

  basculer() {
    if (this.actif) this.desactiver();
    else this.activer();
  }

  _lancer(p) {
    this.pret = Promise.resolve(p).catch((e) => console.error(e));
    return this.pret;
  }

  _retenirNoms() {
    if (!this.graphe || !this.graphe.noeuds) return;
    for (const n of this.graphe.noeuds.values()) if (n && typeof n.nom === "string") this._noms.set(n.id, n.nom);
  }

  _nomDe(id) {
    const n = this.graphe && this.graphe.noeuds ? this.graphe.noeuds.get(id) : null;
    if (n && typeof n.nom === "string" && n.nom) return n.nom;
    return this._noms.get(id) || this.reglages.noms[id] || id;
  }

  /* ---------------------------------------------------------------- construction du DOM */

  _construire() {
    // menu d'un nœud
    const m = el("div", "menu-modifier");
    m.setAttribute("role", "dialog");
    m.hidden = true;
    this._titre = el("div", "mm-titre");
    this._sousTitre = el("div", "mm-id");
    this._actions = el("div", "mm-actions");
    this._form = el("form", "mm-form");
    this._form.setAttribute("novalidate", "");
    this._form.hidden = true;
    this._erreur = el("div", "erreur");
    this._erreur.setAttribute("role", "alert");
    this._erreur.hidden = true;
    m.append(this._titre, this._sousTitre, this._actions, this._form, this._erreur);
    this._form.addEventListener("submit", (e) => { e.preventDefault(); this.soumettre(); });
    m.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (this._formulaire) this._montrerActions(); else this.fermerMenu();
    });
    this._menu = m;

    // panneau « Mode modifier » + liste des masqués
    const s = el("section", "masques");
    s.setAttribute("aria-label", "Mode modifier : éléments masqués");
    s.hidden = true;
    const entete = el("div", "masques-entete");
    const terminer = bouton("Terminer", "masques-terminer");
    terminer.addEventListener("click", () => this.desactiver());
    entete.append(el("b", "", "Mode modifier"), terminer);
    const aide = el("p", "masques-aide", "Cliquez sur un élément de la carte pour le renommer, le cacher, le marquer « éteint exprès » ou lui ajouter un lien.");
    this._titreMasques = el("h3", "masques-titre", "Masqués");
    this._listeMasques = el("ul", "masques-liste");
    this._videMasques = el("p", "masques-vide", "Aucun élément masqué.");
    this._erreurMasques = el("p", "erreur masques-erreur");
    this._erreurMasques.setAttribute("role", "alert");
    this._erreurMasques.hidden = true;
    s.append(entete, aide, this._titreMasques, this._listeMasques, this._videMasques, this._erreurMasques);
    this._masques = s;

    this.racine.append(m, s);
  }

  _majMasques() {
    if (!this.actif) { this._masques.hidden = true; return; }
    this._masques.hidden = false;
    const ids = [...this.reglages.caches].sort((a, b) => this._nomDe(a).localeCompare(this._nomDe(b), "fr"));
    this._titreMasques.textContent = ids.length ? `Masqués (${ids.length})` : "Masqués";
    const lignes = ids.map((id) => {
      const li = el("li", "masque-ligne");
      const nom = this._nomDe(id);
      const texte = el("span", "masque-nom", nom);
      li.append(texte);
      if (nom !== id) li.append(el("span", "masque-id", id));
      const b = bouton("Montrer", "masque-montrer");
      b.setAttribute("aria-label", `Montrer ${nom}`);
      b.addEventListener("click", () => this._lancer(this._envoyer({ action: "montrer", id }, b)));
      li.append(b);
      return li;
    });
    this._listeMasques.replaceChildren(...lignes);
    this._listeMasques.hidden = !ids.length;
    this._videMasques.hidden = ids.length > 0;
  }

  /* ---------------------------------------------------------------- menu */

  _surClic(id, e) {
    if (!this.actif) return false;
    if (!id) { this.fermerMenu(); return false; }
    if (!this.graphe || !this.graphe.noeuds || !this.graphe.noeuds.has(id)) return false;
    this.ouvrirMenu(id, e);
    return true;
  }

  get menuOuvert() { return !this._menu.hidden; }

  ouvrirMenu(id, e = null) {
    const n = this.graphe.noeuds.get(id);
    if (!n) return;
    this._cible = id;
    this._noms.set(id, n.nom || id);
    this._titre.textContent = n.nom || id;
    this._sousTitre.textContent = id;
    this._menu.setAttribute("aria-label", `Modifier ${n.nom || id}`);
    this._montrerActions();
    this._menu.hidden = false;
    this._placer(id, e);
    const premier = this._actions.children[0];
    if (premier) premier.focus({ preventScroll: true });
  }

  fermerMenu() {
    this._menu.hidden = true;
    this._cible = null;
    this._formulaire = null;
    this._confirmer = null;
    this._form.replaceChildren();
    this._form.hidden = true;
    this._effacerErreur();
  }

  _placer(id, e) {
    let x = e && fini(e.clientX) ? e.clientX : null;
    let y = e && fini(e.clientY) ? e.clientY : null;
    if (x === null || y === null) {
      const p = this.rendu && typeof this.rendu.ecran === "function" ? this.rendu.ecran(id) : null;
      const r = this.canvas && typeof this.canvas.getBoundingClientRect === "function" ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
      x = p ? r.left + p.sx + p.r : 120;
      y = p ? r.top + p.sy : 120;
    }
    const w = (typeof window !== "undefined" && fini(window.innerWidth)) ? window.innerWidth : 1280;
    const h = (typeof window !== "undefined" && fini(window.innerHeight)) ? window.innerHeight : 800;
    const m = this._menu.getBoundingClientRect ? this._menu.getBoundingClientRect() : { width: 240, height: 220 };
    const larg = fini(m.width) && m.width > 0 ? m.width : 240;
    const haut = fini(m.height) && m.height > 0 ? m.height : 220;
    const gauche = Math.max(8, Math.min(x + 14, w - larg - 8));
    const dessus = Math.max(8, Math.min(y + 10, h - haut - 8));
    this._menu.style.left = `${Math.round(gauche)}px`;
    this._menu.style.top = `${Math.round(dessus)}px`;
  }

  _montrerActions() {
    const n = this.graphe.noeuds.get(this._cible);
    this._formulaire = null;
    this._confirmer = null;
    this._form.replaceChildren();
    this._form.hidden = true;
    this._effacerErreur();
    const boutons = actionsDuNoeud(n, this.reglages, this.graphe).map((a) => {
      const b = bouton(a.libelle, "mm-action");
      b.dataset.action = a.cle;
      b.addEventListener("click", () => this.executer(a.cle));
      return b;
    });
    this._actions.replaceChildren(...boutons);
    this._actions.hidden = false;
  }

  /** Lance l'action `cle` du menu sur le nœud ouvert (formulaire ou envoi direct). */
  executer(cle) {
    const id = this._cible;
    const n = id && this.graphe.noeuds.get(id);
    if (!n) return this.pret;
    const a = actionsDuNoeud(n, this.reglages, this.graphe).find((x) => x.cle === cle);
    if (!a) return this.pret;
    if (cle === "renommer" || cle === "ajouter_lien" || cle === "modifier_lien") {
      this._ouvrirFormulaire(cle, n);
      return this.pret;
    }
    const b = [...this._actions.children].find((x) => x.dataset.action === cle) || null;
    if (a.confirmer && this._confirmer !== cle) {
      this._confirmer = cle;
      if (b) b.textContent = "Confirmer la suppression";
      return this.pret;
    }
    const modif = { action: a.action, id };
    if (cle === "retablir") modif.nom = null;
    if (cle === "eteint_expres") modif.valeur = a.valeur;
    return this._lancer(this._envoyer(modif, b));
  }

  /* ---------------------------------------------------------------- formulaires */

  _champ(libelle, valeur, { placeholder = "", mode = "text" } = {}) {
    const l = el("label", "mm-champ");
    l.append(el("span", "mm-libelle", libelle));
    const c = el("input", "champ");
    c.type = "text";
    c.setAttribute("type", "text");
    c.setAttribute("autocomplete", "off");
    c.setAttribute("spellcheck", "false");
    if (mode !== "text") c.setAttribute("inputmode", mode);
    if (placeholder) c.setAttribute("placeholder", placeholder);
    c.value = valeur || "";
    l.append(c);
    this._form.append(l);
    return c;
  }

  _choixParent(n) {
    const l = el("label", "mm-champ");
    l.append(el("span", "mm-libelle", "Rattaché à"));
    const s = el("select", "champ");
    const candidats = [...this.graphe.noeuds.values()]
      .filter((x) => x && !estSite(x) && x.type !== "appareil")
      .sort((a, b) => String(a.nom || a.id).localeCompare(String(b.nom || b.id), "fr"));
    for (const x of candidats) {
      const o = el("option", "", x.nom && x.nom !== x.id ? `${x.nom} (${x.id})` : x.id);
      o.value = x.id;
      o.setAttribute("value", x.id);
      s.append(o);
    }
    s.value = n.parent || "";
    l.append(s);
    this._form.append(l);
    return s;
  }

  _ouvrirFormulaire(type, n) {
    this._form.replaceChildren();
    this._effacerErreur();
    const f = { type, nom: null, url: null, parent: null };
    if (type === "renommer") {
      f.nom = this._champ("Nouveau nom", n.nom || "");
    } else if (type === "ajouter_lien") {
      f.nom = this._champ("Nom du lien", "", { placeholder: "Mon site" });
      f.url = this._champ("Adresse", "", { placeholder: "https://…", mode: "url" });
    } else {
      f.nom = this._champ("Nom", n.nom || "");
      f.url = this._champ("Adresse", n.url || "", { placeholder: "https://…", mode: "url" });
      f.parent = this._choixParent(n);
    }
    const ligne = el("div", "mm-boutons");
    const annuler = bouton("Annuler", "mm-annuler");
    annuler.addEventListener("click", () => this._montrerActions());
    f.valider = bouton(type === "ajouter_lien" ? "Ajouter" : "Enregistrer", "mm-valider", "submit");
    ligne.append(annuler, f.valider);
    this._form.append(ligne);
    this._formulaire = f;
    this._actions.hidden = true;
    this._form.hidden = false;
    f.nom.focus({ preventScroll: true });
    if (typeof f.nom.select === "function" && type !== "ajouter_lien") f.nom.select();
  }

  /** Valide puis envoie le formulaire ouvert. */
  soumettre() {
    const f = this._formulaire;
    const id = this._cible;
    const n = id && this.graphe.noeuds.get(id);
    if (!f || !n || this._envoi) return this.pret;
    const nom = nettoyer(f.nom ? f.nom.value : "");
    const url = nettoyer(f.url ? f.url.value : "");
    let modif = null;
    let raison = null;

    if (f.type === "renommer") {
      raison = raisonNom(nom);
      if (!raison && nom === n.nom) { this.fermerMenu(); return this.pret; }
      modif = { action: "renommer", id, nom };
    } else if (f.type === "ajouter_lien") {
      raison = raisonNom(nom) || raisonUrl(url);
      modif = { action: "ajouter_lien", nom, url, parent: id };
    } else {
      modif = { action: "modifier_lien", id };
      if (nom !== (n.nom || "")) { raison = raisonNom(nom); modif.nom = nom; }
      if (!raison && url !== (n.url || "")) { raison = raisonUrl(url); modif.url = url; }
      const parent = f.parent ? f.parent.value : "";
      if (!raison && parent && parent !== n.parent) modif.parent = parent;
      if (!raison && Object.keys(modif).length === 2) raison = "Rien à modifier : indiquez un nom, une adresse ou un parent.";
    }
    if (raison) {
      this._montrerErreur(raison);
      return this.pret;
    }
    return this._lancer(this._envoyer(modif, f.valider));
  }

  /* ---------------------------------------------------------------- envoi */

  async _envoyer(modif, declencheur = null) {
    if (this._envoi) return;
    this._envoi = true;
    if (declencheur) declencheur.disabled = true;
    this._effacerErreur();
    if (modif.id) this._noms.set(modif.id, this._nomDe(modif.id));
    try {
      const r = await envoyerModif(modif, this.requete);
      if (!r.ok) {
        this._montrerErreur(r.erreur, declencheur);
        return;
      }
      this._version++;
      if (r.reglages) this.reglages = normaliserReglages(r.reglages);
      if (this._menu.hidden === false) this.fermerMenu();
      this._majMasques();
      this.annoncer("Modification enregistrée.");
      try { this.surChange(this.reglages); } catch (e) { console.error(e); }
    } finally {
      this._envoi = false;
      if (declencheur) declencheur.disabled = false;
    }
  }

  _montrerErreur(texte, declencheur = null) {
    // message du serveur affiché tel quel, en texte
    const cible = declencheur && dans(declencheur, this._masques) ? this._erreurMasques : this._erreur;
    cible.textContent = String(texte);
    cible.hidden = false;
  }

  _effacerErreur() {
    for (const e of [this._erreur, this._erreurMasques]) {
      e.textContent = "";
      e.hidden = true;
    }
  }
}
