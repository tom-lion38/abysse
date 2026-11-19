// Point d'entrée : assemble graphe, caméra, disposition, rendu, interactions, panneau et flux en direct,
// et tient la barre du haut (horloge, « 31 / 33 en ligne », débit WAN, onduleur, onglets, raccourcis).
//
// Raccourcis : `/` recherche (onglet Liste), `Échap` ferme le panneau puis revient à la carte, `L` Liste, `C` Carte.
// La Liste, la frise et le mode modifier se branchent via l'objet `app` en bas de ce fichier
// (`app.revoir(inst)` / `app.retourDirect()` pour la frise, `interactions.interception` pour le mode modifier).

import { Graphe } from "./graphe.js";
import { Camera } from "./camera.js";
import { disposer } from "./disposition.js";
import { Rendu } from "./rendu.js";
import { connecter, debit, pourcent, duree, chrono, resumeEnLigne } from "./donnees.js";
import { Interactions, chargerPositions, ouvrirOnglet } from "./interactions.js";
import { Panneau, contenuInfobulle } from "./panneau.js";
import { Liste, filtrer, entreesDepuis } from "./liste.js";
import { Frise } from "./frise.js";
import { ModeModifier } from "./modifier.js";
import { GROUPES } from "./couleurs.js";

const $ = (id) => document.getElementById(id);
const fini = (v) => typeof v === "number" && Number.isFinite(v);

const canvas = $("scene");
const graphe = new Graphe();
const camera = new Camera({ largeur: window.innerWidth, hauteur: window.innerHeight });
const rendu = new Rendu(canvas);
const positions = chargerPositions();

let direct = true;          // faux pendant qu'on revoit un instant passé (frise)
let dernierDirect = null;   // dernier instantané reçu en direct
let perteDepuis = 0;        // ms depuis le dernier instantané, pendant une perte de connexion
let tPerte = null;          // heure serveur (s) du dernier instantané reçu avant la perte de connexion

/* ------------------------------------------------------------------ panneau, interactions */

const panneau = new Panneau($("panneau"), {
  surFermer: () => { canvas.focus({ preventScroll: true }); rendu.majZone(); },
  surChoisir: (id) => montrerDetails(id),
});

const interactions = new Interactions(canvas, {
  camera, rendu, graphe, positions,
  infobulle: $("infobulle"),
  contenuInfobulle: (id) => contenuInfobulle(graphe.noeuds.get(id), graphe),
  surDetails: (id) => (id ? montrerDetails(id) : panneau.fermer()),
});

function montrerDetails(id) {
  if (!graphe.noeuds.has(id)) return;
  interactions.oublierSurvol();
  panneau.ouvrir(id, graphe);
  rendu.majZone();
}

/* ------------------------------------------------------------------ instantanés */

function appliquer(inst) {
  const r = graphe.appliquer(inst);
  if (r.apparus.length) disposer(graphe, positions);
  panneau.maj(graphe);
  majResume();
  if (app.liste) app.liste.afficher(graphe);
}

function surEtat(inst) {
  dernierDirect = inst;
  if (direct) appliquer(inst);
}

function surEvenement(evt) {
  // annonce les évènements importants aux lecteurs d'écran (la frise les dessine)
  if (evt && Number(evt.importance) >= 3 && typeof evt.texte === "string") annoncer(evt.texte);
  for (const f of app.ecouteursEvenement) {
    try { f(evt); } catch (e) { console.error(e); }
  }
}

function annoncer(texte) {
  const el = $("annonces");
  if (el) el.textContent = texte;
}

/* ------------------------------------------------------------------ connexion perdue */

const bandeau = $("bandeau");
let finBandeau = 0;
/** s : marge avant le dernier instantané reçu (le serveur n'en enregistre qu'un toutes les 10 s). */
const MARGE_RECHARGE = 60;

function surConnexion(ok, depuisMs) {
  if (!ok) {
    const debut = !rendu.connexionPerdue;
    if (debut) tPerte = dernierDirect && fini(dernierDirect.t) ? dernierDirect.t : null;
    rendu.connexionPerdue = true;
    perteDepuis = depuisMs;
    montrerPerte(depuisMs, debut);
    return;
  }
  rendu.connexionPerdue = false;
  perteDepuis = 0;
  cacherPerte();
  annoncer("Connexion rétablie");
  // les évènements de la coupure et le ping « Abysse injoignable N min » (écrit dans l'historique au
  // redémarrage du serveur, jamais poussé dans le flux) ne sont visibles qu'en relisant l'historique
  if (app.frise) app.frise.recharger(tPerte !== null ? tPerte - MARGE_RECHARGE : null);
  tPerte = null;
}

function montrerPerte(ms, debut) {
  clearTimeout(finBandeau);
  const texte = chrono(ms);
  let m = bandeau.querySelector(".mono");
  if (debut || !bandeau.classList.contains("connexion") || !m) {
    bandeau.classList.remove("batterie");
    bandeau.classList.add("connexion");
    const fort = document.createElement("b");
    fort.textContent = "Connexion perdue";
    m = document.createElement("span");
    m.className = "mono";
    bandeau.replaceChildren(fort, document.createTextNode(" depuis "), m, document.createTextNode(" — nouvelle tentative…"));
    bandeau.hidden = false;
    void bandeau.offsetWidth;
    bandeau.classList.add("visible");
    if (debut) annoncer("Connexion au serveur perdue, nouvelle tentative en cours");
  }
  if (m.textContent !== texte) m.textContent = texte;
}

function cacherPerte() {
  if (!bandeau.classList.contains("connexion")) return;
  bandeau.classList.remove("visible");
  clearTimeout(finBandeau);
  finBandeau = setTimeout(() => {
    if (rendu.connexionPerdue) return;
    bandeau.classList.remove("connexion");
    bandeau.replaceChildren();
    bandeau.hidden = true;
    // rendu.js reprend la main sur le bandeau (« Sur batterie ») dès que la classe `connexion` est partie
  }, 650);
}

/* ------------------------------------------------------------------ barre du haut */

const resume = {
  enLigne: $("resumeEnLigne"),
  wan: $("resumeWan"),
  onduleur: $("resumeOnduleur"),
};

function poser(el, texte) {
  if (el && el.textContent !== texte) el.textContent = texte;
}

function majResume() {
  const r = resumeEnLigne(graphe.noeuds.values());
  poser(resume.enLigne.querySelector("b"), r.total ? `${r.enLigne} / ${r.total}` : "–");
  resume.enLigne.classList.toggle("panne", r.pannes > 0);
  resume.enLigne.title = r.pannes ? `${r.pannes} en panne` : "Éléments en ligne";

  const w = graphe.liens.get("mikrotik>box");
  poser(resume.wan.querySelector(".dn"), `↓ ${w ? debit(w.montant) : "–"}`);
  poser(resume.wan.querySelector(".up"), `↑ ${w ? debit(w.descendant) : "–"}`);

  const ups = graphe.noeuds.get("onduleur");
  const j = (ups && ups.jauges) || {};
  let texte = "–", alerte = false;
  if (ups && ups.etat === "inconnu") texte = "inconnu";
  else if (ups && j.secteur === false) {
    alerte = true;
    texte = `Batterie ${fini(j.batterie) ? pourcent(j.batterie / 100) : ""}${fini(j.autonomie) ? ` · ${duree(j.autonomie)}` : ""}`.trim();
  } else if (ups && j.secteur === true) texte = `Secteur${fini(j.batterie) ? ` · ${pourcent(j.batterie / 100)}` : ""}`;
  else if (ups) texte = fini(j.batterie) ? pourcent(j.batterie / 100) : "–";
  poser(resume.onduleur.querySelector("b"), texte);
  resume.onduleur.classList.toggle("alerte", alerte);
}

const FMT_HEURE = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const FMT_DATE = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

function majHorloge() {
  const d = new Date();
  const heure = $("horlogeHeure");
  poser(heure, FMT_HEURE.format(d));
  heure.dateTime = d.toISOString();
  poser($("horlogeDate"), FMT_DATE.format(d));
}

/* ------------------------------------------------------------------ onglets Carte / Liste */

const onglets = { carte: $("ongletCarte"), liste: $("ongletListe") };
const vueListe = $("liste");
let vue = "carte";
let finListe = 0;

function placerEncre() {
  const b = onglets[vue], encre = $("ongletsEncre");
  if (!b || !encre) return;
  encre.style.width = `${b.offsetWidth}px`;
  encre.style.transform = `translateX(${b.offsetLeft - 3}px)`;
}

function basculerVue(v) {
  if (v !== "carte" && v !== "liste") return;
  const change = v !== vue;
  vue = v;
  for (const [nom, b] of Object.entries(onglets)) {
    b.setAttribute("aria-selected", String(nom === v));
    b.tabIndex = nom === v ? 0 : -1;
  }
  placerEncre();
  clearTimeout(finListe);
  if (v === "liste") {
    interactions.oublierSurvol();
    interactions.actif = false;
    vueListe.hidden = false;
    void vueListe.offsetWidth;
    vueListe.classList.add("ouverte");
  } else {
    interactions.actif = true;
    vueListe.classList.remove("ouverte");
    finListe = setTimeout(() => { if (vue === "carte") vueListe.hidden = true; }, 450);
    if (change) {
      canvas.focus({ preventScroll: true });
      montrerRecherche();
    }
  }
  for (const f of app.ecouteursVue) {
    try { f(v); } catch (e) { console.error(e); }
  }
}

for (const b of Object.values(onglets)) b.addEventListener("click", () => basculerVue(b.dataset.vue));

/**
 * Retour sur la carte avec une recherche en cours dans la Liste : les éléments trouvés lancent un sonar
 * pendant 15 s ; un seul résultat → la caméra s'en approche.
 */
let finSonar = 0;
function montrerRecherche() {
  clearTimeout(finSonar);
  const q = app.liste && typeof app.liste.requete === "string" ? app.liste.requete.trim() : "";
  const ids = q ? filtrer(entreesDepuis(graphe), q).map((e) => e.id).filter((id) => graphe.noeuds.has(id)) : [];
  rendu.correspondances = ids.length ? new Set(ids) : null;
  if (!ids.length) return;
  finSonar = setTimeout(() => { rendu.correspondances = null; }, 15000);
  if (ids.length === 1) {
    const n = graphe.noeuds.get(ids[0]);
    if (n && fini(n.x) && fini(n.y)) camera.viser({ tx: n.x, ty: n.y, k: Math.max(camera.k, rendu.zoomVue * 1.5) }, rendu.calme ? 0 : 1.1);
  }
}

/** `/` : la recherche vit dans l'onglet Liste ; à défaut, on ouvre au moins la liste. */
function rechercher() {
  basculerVue("liste");
  if (app.liste && typeof app.liste.focus === "function") { app.liste.focus(); return; }
  const champ = vueListe.querySelector("input");
  if (champ) champ.focus();
}

/* ------------------------------------------------------------------ légende */

const NOMS_GROUPES = Object.freeze({
  mikrotik: "MikroTik", internet: "Internet · box", pve: "Proxmox", pbs: "Sauvegardes", synology: "Synology",
  truenas: "TrueNAS", onduleur: "Onduleur", ha: "Home Assistant", reseau: "Réseau · caméras", appareils: "Appareils",
});
const CLE_LEGENDE = "abysse.legende.v1";

function elt(tag, classe, texte) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

/**
 * Légende repliable (bas gauche, au-dessus de la frise) : une couleur par groupe, les états, les gestes.
 * Dépliée au premier passage puis repliée d'elle-même au bout de 25 s ; le choix est retenu.
 */
function construireLegende(racine) {
  if (!racine) return;
  let choix = null;
  try { choix = localStorage.getItem(CLE_LEGENDE); } catch { /* stockage indisponible */ }
  const tete = elt("div", "lg-tete");
  const bascule = elt("button", "lg-bascule");
  bascule.type = "button";
  bascule.setAttribute("aria-controls", "legende");
  tete.append(elt("span", "lg-titre", "Légende"), bascule);
  const groupes = elt("ul", "lg-groupes");
  for (const [g, coul] of Object.entries(GROUPES)) {
    const li = elt("li");
    const point = elt("i", "lg-point");
    point.style.setProperty("--c", coul);
    li.append(point, document.createTextNode(NOMS_GROUPES[g] || g));
    groupes.append(li);
  }
  const etats = elt("ul", "lg-etats");
  for (const [classe, texte] of [["etat-on", "en ligne"], ["etat-off", "en panne"], ["etat-eteint", "éteint exprès"], ["etat-inconnu", "état inconnu"]]) {
    const li = elt("li");
    li.append(elt("i", `pastille ${classe}`), document.createTextNode(texte));
    etats.append(li);
  }
  const flux = elt("li");
  flux.append(elt("i", "lg-flux"), document.createTextNode("débit : ↓ pâle, ↑ vif"));
  etats.append(flux);
  const aide = elt("p", "lg-aide", "Clic : ouvrir · Maj + clic : détails · clic droit glissé : tourner · molette : zoom · double-clic : recentrer · / : chercher");
  racine.replaceChildren(tete, groupes, etats, aide);

  let survolee = false, touchee = false;
  const poser = (repliee) => {
    racine.classList.toggle("repliee", repliee);
    bascule.textContent = repliee ? "Afficher" : "Réduire";
    bascule.setAttribute("aria-expanded", String(!repliee));
    rendu.majZone();
  };
  bascule.addEventListener("click", () => {
    touchee = true;
    const repliee = !racine.classList.contains("repliee");
    poser(repliee);
    try { localStorage.setItem(CLE_LEGENDE, repliee ? "repliee" : "ouverte"); } catch { /* tant pis */ }
  });
  racine.addEventListener("pointerenter", () => { survolee = true; });
  racine.addEventListener("pointerleave", () => { survolee = false; });
  const petitEcran = window.innerWidth < 760;
  poser(choix ? choix === "repliee" : petitEcran);
  if (!choix && !petitEcran) {
    const replier = () => { if (touchee) return; if (survolee) { setTimeout(replier, 3000); return; } poser(true); };
    setTimeout(replier, 25000);
  }
}

/* ------------------------------------------------------------------ clavier */

function saisieEnCours(cible) {
  if (!cible || !(cible instanceof Element)) return false;
  return cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName);
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (e.key === "Escape") {
    if (saisieEnCours(e.target)) {
      // dans la recherche de la Liste : retour direct à la carte, la recherche gardée (sonar sur les résultats) ;
      // preventDefault évite que le champ « search » ne s'efface tout seul
      if (vue === "liste" && app.liste && e.target === app.liste.champ) { e.preventDefault(); e.target.blur(); basculerVue("carte"); return; }
      e.target.blur();
      return;
    }
    if (panneau.ouvert) { panneau.fermer(); e.preventDefault(); return; }
    if (vue === "liste") { basculerVue("carte"); e.preventDefault(); }
    return;
  }
  if (saisieEnCours(e.target)) return;
  if (e.key === "/") { e.preventDefault(); rechercher(); }
  else if (e.key === "l" || e.key === "L") { e.preventDefault(); basculerVue("liste"); }
  else if (e.key === "c" || e.key === "C") { e.preventDefault(); basculerVue("carte"); }
});

/* ------------------------------------------------------------------ boucle d'animation */

/** Le panneau couvre la droite de l'écran : la scène glisse doucement vers la gauche pour rester visible. */
function majDecalage(dt) {
  const large = window.innerWidth > 900;
  const cible = panneau.ouvert && large ? -Math.min(200, (380 + 16) / 2) : 0;
  const k = rendu.calme ? 1 : Math.min(1, dt * 5);
  camera.decalX += (cible - camera.decalX) * k;
  if (Math.abs(cible - camera.decalX) < 0.2) camera.decalX = cible;
}

let avant = performance.now();
function boucle(t) {
  const dt = Math.max(0, (t - avant) / 1000);
  avant = t;
  majDecalage(dt);
  rendu.image(dt, graphe, camera, interactions.survol, panneau.id);
  interactions.parImage();
  requestAnimationFrame(boucle);
}

/* ------------------------------------------------------------------ démarrage */

const app = {
  graphe, camera, rendu, interactions, panneau, positions,
  /** Onglet Liste : objet avec `focus()`. */
  liste: null,
  /** Fonctions appelées à chaque évènement du flux (frise). */
  ecouteursEvenement: [],
  /** Fonctions appelées au changement de vue ("carte" | "liste"). */
  ecouteursVue: [],
  basculerVue,
  montrerDetails,
  /** Frise : affiche un instant passé (le direct continue d'arriver sans être appliqué). */
  revoir(inst) {
    if (!inst || typeof inst !== "object") return;
    direct = false;
    appliquer(inst);
  },
  /** Bouton « Direct » : revient au dernier instantané reçu. */
  retourDirect() {
    direct = true;
    if (dernierDirect) appliquer(dernierDirect);
  },
  get direct() { return direct; },
  get perteDepuis() { return perteDepuis; },
};

construireLegende($("legende"));
majHorloge();
setInterval(majHorloge, 1000);
window.addEventListener("resize", placerEncre);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placerEncre, () => {});
placerEncre();

// premier instantané sans attendre le flux (le SSE prend ensuite le relais)
fetch("/api/etat", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((inst) => { if (inst && !dernierDirect) surEtat(inst); })
  .catch(() => { /* le flux et la détection de perte s'en chargent */ });

/* Onglet Liste et frise du temps */
app.liste = new Liste(vueListe, { surDetails: (id) => montrerDetails(id), ouvrir: ouvrirOnglet });
app.ecouteursVue.push((v) => { if (v === "liste") app.liste.afficher(graphe); });
app.frise = new Frise($("frise"), {
  surInstant: (inst) => app.revoir(inst),
  surDirect: () => app.retourDirect(),
});
app.ecouteursEvenement.push((evt) => app.frise.ajouter(evt));
{
  const maintenant = Date.now() / 1000;
  app.frise.charger(maintenant - 86400, maintenant);
}

/* Mode modifier (bouton « Modifier » de la barre) */
app.modifier = new ModeModifier({ bouton: $("boutonModifier"), interactions, graphe, rendu, canvas, annoncer });
app.ecouteursVue.push((v) => { if (v === "liste") app.modifier.fermerMenu(); });

/* Bouton « Actualiser » : Abysse relit les sites de Caddy auprès de Phare et relance toutes ses sources.
   Il le fait aussi tout seul toutes les 10 minutes ; le bouton sert quand on vient de changer quelque chose. */
{
  const b = $("boutonActualiser");
  const libelle = b.querySelector("span");
  b.addEventListener("click", async () => {
    if (b.classList.contains("tourne")) return;
    b.classList.remove("fait", "rate");
    b.classList.add("tourne");
    let texte;
    try {
      const r = await fetch("/api/actualiser", { method: "POST", headers: { "X-Abysse": "1", "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erreur || r.status);
      b.classList.add(d.ok ? "fait" : "rate");
      texte = d.ok ? `${d.sites} sites relus` : d.erreur;
    } catch (e) {
      b.classList.add("rate");
      texte = "Échec : " + e.message;
    }
    b.classList.remove("tourne");
    libelle.textContent = texte;
    b.title = texte;
    annoncer(texte);
    setTimeout(() => { libelle.textContent = "Actualiser"; b.classList.remove("fait", "rate"); }, 4000);
  });
}

app.flux = connecter({ surEtat, surEvenement, surConnexion });
requestAnimationFrame(boucle);

export default app;
