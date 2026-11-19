// Panneau de détails d'un nœud (verre fumé, à droite ; en bas sur téléphone) et contenu de l'infobulle.
// `descriptionNoeud` est une fonction pure (testée sous Node) ; le DOM est construit avec createElement +
// textContent uniquement, et mis à jour en place à chaque instantané (les jauges glissent, le défilement reste).

import { debit, octetsSur, duree, pourcent } from "./donnees.js";
import { liensDuNoeud, urlSure } from "./interactions.js";

const NB = " ";
const GIO = 1073741824;
const NF0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fini = (v) => typeof v === "number" && Number.isFinite(v);
const borne = (v, a, b) => (v < a ? a : v > b ? b : v);

export const TYPES = Object.freeze({
  routeur: "Routeur", internet: "Accès Internet", box: "Box opérateur", hyperviseur: "Hyperviseur Proxmox",
  sauvegarde: "Serveur de sauvegarde", nas: "NAS", "nas-vm": "NAS · machine virtuelle", onduleur: "Onduleur",
  pc: "Ordinateur", domotique: "Domotique", switch: "Commutateur", appareil: "Appareil", ct: "Conteneur LXC",
  vm: "Machine virtuelle", site: "Site",
});

export const ETATS = Object.freeze({ on: "En ligne", off: "En panne", eteint: "Éteint", inconnu: "État inconnu" });

const etatDe = (n) => (n && Object.hasOwn(ETATS, n.etat) ? n.etat : "inconnu");

/** RAM en Gio (affichée « Go », comme sur la carte) : « 38 / 125 Go ». */
function ram(d) {
  if (!d || !fini(d.u) || !fini(d.t) || d.t <= 0) return null;
  const f = (v) => (v >= 10 ? NF0 : NF1).format(v);
  return `${f(d.u / GIO)} / ${f(d.t / GIO)}${NB}Go`;
}

const niveau = (frac, alerte, critique) => (frac >= critique ? "critique" : frac >= alerte ? "alerte" : "");

function vmid(n) {
  const v = Number(n.details && n.details.vmid);
  if (Number.isInteger(v) && v > 0) return v;
  const m = /^(?:ct|vm)-(\d+)$/.exec(n.id || "");
  return m ? Number(m[1]) : null;
}

/** Lien du nœud vers son parent (débit reçu = descendant), ou le WAN pour le MikroTik. */
function lienDebit(n, graphe) {
  if (!graphe || !graphe.liens) return null;
  if (n.id === "mikrotik") {
    const w = graphe.liens.get("mikrotik>box");
    return w ? { recu: w.montant, envoye: w.descendant, wan: true } : null;
  }
  for (const l of graphe.liens.values()) {
    if (l.vers === n.id && l.de === n.parent) return { recu: l.descendant, envoye: l.montant, wan: false };
  }
  for (const l of graphe.liens.values()) {
    if (l.de === n.id && l.vers === n.parent) return { recu: l.montant, envoye: l.descendant, wan: false };
  }
  return null;
}

/**
 * Tout ce que le panneau affiche pour un nœud, en texte prêt à poser via textContent :
 * {id, nom, type, typeTexte, sous, etat, etatTexte, jauges: [{cle, libelle, valeur, frac, niveau}],
 *  lignes: [{cle, libelle, valeur, classe?}], sauvegardes: [{nom, ok}], enfants: [{id, nom, etat}], liens: [{libelle, url}]}.
 */
export function descriptionNoeud(n, graphe = null) {
  if (!n || typeof n !== "object") return null;
  const j = n.jauges || {};
  const d = n.details || {};
  const etat = etatDe(n);
  const id = vmid(n);
  const typeTexte = TYPES[n.type] || "Élément";
  const sous = [];
  if ((n.type === "ct" || n.type === "vm" || n.type === "nas-vm") && id !== null) sous.push(`${n.type === "ct" ? "CT" : "VM"} ${id}`);
  if (n.ip) sous.push(String(n.ip));
  if (n.type === "site" && urlSure(n.url)) sous.push(n.url.replace(/^https?:\/\//i, ""));

  const jauges = [];
  if (fini(j.cpu)) {
    const f = borne(j.cpu, 0, 1);
    jauges.push({ cle: "cpu", libelle: "Processeur", valeur: pourcent(j.cpu), frac: f, niveau: niveau(f, 0.75, 0.9) });
  }
  const r = ram(j.ram);
  if (r) {
    const f = borne(j.ram.u / j.ram.t, 0, 1);
    jauges.push({ cle: "ram", libelle: "Mémoire", valeur: r, frac: f, niveau: niveau(f, 0.8, 0.92) });
  }
  if (j.disque && fini(j.disque.u) && fini(j.disque.t) && j.disque.t > 0) {
    const f = borne(j.disque.u / j.disque.t, 0, 1);
    jauges.push({ cle: "disque", libelle: "Stockage", valeur: `${octetsSur(j.disque.u, j.disque.t)} · ${pourcent(f)}`, frac: f, niveau: niveau(f, 0.8, 0.9) });
  }
  if (fini(j.batterie)) {
    const f = borne(j.batterie / 100, 0, 1);
    jauges.push({ cle: "batterie", libelle: "Batterie", valeur: pourcent(f), frac: f, niveau: f <= 0.2 ? "critique" : f <= 0.5 ? "alerte" : "" });
  }

  const lignes = [];
  const ligne = (cle, libelle, valeur, classe) => { if (valeur !== null && valeur !== undefined && valeur !== "") lignes.push({ cle, libelle, valeur: String(valeur), ...(classe ? { classe } : {}) }); };
  if (typeof j.secteur === "boolean") ligne("secteur", "Alimentation", j.secteur ? "Secteur" : "Sur batterie", j.secteur ? "etat-on" : "etat-off");
  if (fini(j.autonomie)) ligne("autonomie", "Autonomie", duree(j.autonomie));
  if (fini(j.tension)) ligne("tension", "Tension secteur", `${NF0.format(j.tension)}${NB}V`);
  if (n.ip) ligne("ip", "IP", n.ip);
  const flux = lienDebit(n, graphe);
  if (flux && (fini(flux.recu) || fini(flux.envoye))) {
    ligne("recu", flux.wan ? "WAN reçu ↓" : "Reçu ↓", debit(flux.recu));
    ligne("envoye", flux.wan ? "WAN envoyé ↑" : "Envoyé ↑", debit(flux.envoye));
  }
  if (fini(d.uptime) && d.uptime > 0 && etat === "on") ligne("uptime", "En ligne depuis", duree(d.uptime));
  if (typeof d.version === "string") ligne("version", "Version", d.version);
  if (typeof d.statut === "string") ligne("statut", "Statut NUT", d.statut);
  if (typeof d.sante === "string") ligne("sante", "Santé du pool", d.sante);
  if (typeof d.pool === "string") ligne("pool", "Pool", d.pool);
  if (typeof d.fabricant === "string") ligne("fabricant", "Fabricant", d.fabricant);
  if (typeof d.mac === "string") ligne("mac", "Adresse MAC", d.mac);
  if (typeof d.port === "string") ligne("port", "Port du MikroTik", d.port);
  if (typeof d.amont === "string") ligne("amont", "Amont (Caddy)", d.amont);
  const parent = graphe && n.parent ? graphe.noeuds.get(n.parent) : null;
  if (parent) ligne("parent", "Rattaché à", parent.nom || parent.id);

  const sauvegardes = [];
  if (d.sauvegardes && typeof d.sauvegardes === "object") {
    for (const [nom, v] of Object.entries(d.sauvegardes)) sauvegardes.push({ nom, ok: Number(v) >= 1 });
  }

  const enfants = [];
  if (graphe && typeof graphe.enfants === "function") {
    for (const e of graphe.enfants(n.id)) {
      const c = graphe.noeuds.get(e);
      if (c) enfants.push({ id: c.id, nom: String(c.nom || c.id), etat: etatDe(c) });
    }
  }

  return {
    id: n.id, nom: String(n.nom || n.id), type: n.type, typeTexte, sous: sous.join(" · "),
    etat, etatTexte: ETATS[etat], jauges, lignes, sauvegardes, enfants, liens: liensDuNoeud(n),
  };
}

/** Contenu de l'infobulle de survol : IP, état, CPU, RAM, débit (+ stockage / batterie des grosses machines). */
export function contenuInfobulle(n, graphe = null) {
  if (!n) return null;
  const d = descriptionNoeud(n, graphe);
  const garder = new Set(["ip", "recu", "envoye", "secteur", "autonomie"]);
  const lignes = [{ libelle: "État", valeur: d.etatTexte, classe: `etat-${d.etat}` }];
  for (const j of d.jauges) lignes.push({ libelle: j.libelle, valeur: j.valeur });
  for (const l of d.lignes) if (garder.has(l.cle)) lignes.push({ libelle: l.libelle, valeur: l.valeur, classe: l.classe });
  const ratees = d.sauvegardes.filter((s) => !s.ok).length;
  if (ratees) lignes.push({ libelle: "Sauvegardes", valeur: `${ratees} ratée${ratees > 1 ? "s" : ""}`, classe: "etat-off" });
  const id = vmid(n);
  const entete = (n.type === "ct" || n.type === "vm" || n.type === "nas-vm") && id !== null
    ? `${d.typeTexte} · ${n.type === "ct" ? "CT" : "VM"} ${id}` : d.typeTexte;
  return { entete, nom: d.nom, lignes };
}

/* ------------------------------------------------------------------ DOM */

function el(tag, classe, texte) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

/** Signature de la structure : si elle ne change pas, on met à jour les textes en place. */
function signature(d) {
  return [d.id, d.jauges.map((j) => j.cle).join(","), d.lignes.map((l) => l.cle).join(","),
    d.sauvegardes.map((s) => s.nom).join(","), d.enfants.map((e) => e.id).join(","), d.liens.map((l) => l.url).join(",")].join("|");
}

export class Panneau {
  /**
   * @param {HTMLElement} racine  l'<aside id="panneau">
   * @param {object} o  surFermer() : le panneau vient d'être fermé ; surChoisir(id) : clic sur un enfant.
   */
  constructor(racine, { surFermer = () => {}, surChoisir = () => {} } = {}) {
    this.racine = racine;
    this.surFermer = surFermer;
    this.surChoisir = surChoisir;
    this.id = null;
    this._sig = "";
    this._refs = null;
    this._graphe = null;
  }

  get ouvert() { return this.id !== null; }

  ouvrir(id, graphe) {
    const n = graphe && graphe.noeuds.get(id);
    if (!n) return;
    const deja = this.id === id;
    this.id = id;
    this._graphe = graphe;
    if (!deja) this._sig = "";
    this._dessiner(n, graphe);
    this.racine.classList.add("ouvert");
    this.racine.setAttribute("aria-hidden", "false");
    if (!deja && this._refs) this._refs.defile.scrollTop = 0;
  }

  fermer() {
    if (this.id === null) return;
    this.id = null;
    this._sig = "";
    this.racine.classList.remove("ouvert");
    this.racine.setAttribute("aria-hidden", "true");
    this.surFermer();
  }

  /** À appeler après chaque instantané : met à jour les valeurs ; ferme si le nœud a disparu. */
  maj(graphe) {
    if (this.id === null) return;
    const n = graphe.noeuds.get(this.id);
    if (!n) { this.fermer(); return; }
    this._graphe = graphe;
    this._dessiner(n, graphe);
  }

  _dessiner(n, graphe) {
    const d = descriptionNoeud(n, graphe);
    const sig = signature(d);
    if (sig !== this._sig || !this._refs) {
      const haut = this._refs ? this._refs.defile.scrollTop : 0;
      this._construire(d);
      this._sig = sig;
      this._refs.defile.scrollTop = haut;
    }
    this._remplir(d);
  }

  _construire(d) {
    const R = { jauges: new Map(), lignes: new Map(), sauvegardes: new Map(), enfants: new Map() };
    const defile = el("div", "pn-defile");
    const fermer = el("button", "pn-fermer", "×");
    fermer.type = "button";
    fermer.title = "Fermer (Échap)";
    fermer.setAttribute("aria-label", "Fermer les détails");
    fermer.addEventListener("click", () => this.fermer());

    R.type = el("div", "pn-type");
    R.nom = el("h2");
    R.sous = el("div", "pn-sous");
    R.etat = el("div", "pn-etat");
    R.pastille = el("i", "pastille");
    R.pastille.setAttribute("aria-hidden", "true");
    R.etatTexte = el("span");
    R.etat.append(R.pastille, R.etatTexte);
    defile.append(fermer, R.type, R.nom, R.sous, R.etat);

    const section = (titre) => {
      const s = el("section", "pn-section");
      s.append(el("h3", null, titre));
      defile.append(s);
      return s;
    };

    if (d.jauges.length) {
      const s = section("Jauges");
      for (const j of d.jauges) {
        const bloc = el("div", "jauge");
        const h = el("div", "jauge-haut");
        const lib = el("span", null, j.libelle);
        const val = el("b");
        h.append(lib, val);
        const barre = el("div", "jauge-barre");
        const i = el("i");
        barre.append(i);
        bloc.append(h, barre);
        s.append(bloc);
        R.jauges.set(j.cle, { val, i });
      }
    }
    if (d.lignes.length) {
      const s = section("Détails");
      for (const l of d.lignes) {
        const bloc = el("div", "jauge");
        const h = el("div", "jauge-haut");
        const val = el("b");
        h.append(el("span", null, l.libelle), val);
        bloc.append(h);
        s.append(bloc);
        R.lignes.set(l.cle, val);
      }
    }
    if (d.sauvegardes.length) {
      const s = section("Sauvegardes");
      for (const sv of d.sauvegardes) {
        const bloc = el("div", "jauge");
        const h = el("div", "jauge-haut");
        const val = el("b");
        h.append(el("span", null, sv.nom), val);
        bloc.append(h);
        s.append(bloc);
        R.sauvegardes.set(sv.nom, val);
      }
    }
    if (d.enfants.length) {
      const s = section(`Rattachés (${d.enfants.length})`);
      const liste = el("div", "pn-enfants");
      for (const e of d.enfants) {
        const b = el("button", "pn-enfant");
        b.type = "button";
        const p = el("i", "pastille");
        p.setAttribute("aria-hidden", "true");
        const nom = el("span");
        b.append(p, nom);
        b.addEventListener("click", () => this.surChoisir(e.id));
        liste.append(b);
        R.enfants.set(e.id, { p, nom, b });
      }
      s.append(liste);
    }
    R.liens = [];
    d.liens.forEach((l, k) => {
      const a = el("a", k ? "pn-ouvrir pn-ouvrir-second" : "pn-ouvrir");
      a.href = l.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const t = el("span", null, l.libelle);
      a.append(t, el("span", null, "↗"));
      defile.append(a);
      R.liens.push(a);
    });

    R.defile = defile;
    this.racine.replaceChildren(defile);
    this._refs = R;
    // première ouverture : les jauges partent de zéro puis glissent jusqu'à leur valeur
    for (const { i } of R.jauges.values()) i.style.width = "0%";
    void defile.offsetWidth;
  }

  _remplir(d) {
    const R = this._refs;
    const poser = (e, t) => { if (e.textContent !== t) e.textContent = t; };
    poser(R.type, d.typeTexte);
    poser(R.nom, d.nom);
    poser(R.sous, d.sous);
    R.sous.hidden = !d.sous;
    R.etat.className = `pn-etat etat-${d.etat}`;
    R.pastille.className = `pastille etat-${d.etat}`;
    poser(R.etatTexte, d.etatTexte);
    for (const j of d.jauges) {
      const r = R.jauges.get(j.cle);
      if (!r) continue;
      poser(r.val, j.valeur);
      const w = `${(j.frac * 100).toFixed(1)}%`;
      if (r.i.style.width !== w) r.i.style.width = w;
      r.i.className = j.niveau;
    }
    for (const l of d.lignes) {
      const v = R.lignes.get(l.cle);
      if (!v) continue;
      poser(v, l.valeur);
      v.className = l.classe || "";
    }
    for (const s of d.sauvegardes) {
      const v = R.sauvegardes.get(s.nom);
      if (!v) continue;
      poser(v, s.ok ? "Réussie" : "Ratée");
      v.className = s.ok ? "etat-on" : "etat-off";
    }
    for (const e of d.enfants) {
      const r = R.enfants.get(e.id);
      if (!r) continue;
      poser(r.nom, e.nom);
      r.p.className = `pastille etat-${e.etat}`;
      r.b.title = `${e.nom} · ${ETATS[e.etat]}`;
    }
    this.racine.setAttribute("aria-label", `Détails : ${d.nom}`);
  }
}
