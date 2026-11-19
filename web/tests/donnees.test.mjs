import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connecter, formater, debit, octets, duree, pourcent, chrono, resumeEnLigne, SEUIL_PERTE_MS } from "../js/donnees.js";
import { liensDuNoeud, urlSure, lienProxmox } from "../js/interactions.js";
import { descriptionNoeud } from "../js/panneau.js";
import { Graphe } from "../js/graphe.js";

// Espaces figés : insécable (U+00A0) entre un nombre et son unité, fine insécable (U+202F) avant « % ».
const NB = " ";
const NNB = " ";

const demo = JSON.parse(readFileSync(new URL("./instantane-demo.json", import.meta.url), "utf8"));

/* ------------------------------------------------------------------ formater */

test("formater.debit", () => {
  assert.equal(debit(12_400_000), `12,4${NB}Mbit/s`);
  assert.equal(debit(850), `850${NB}bit/s`);
  assert.equal(debit(48_000), `48,0${NB}kbit/s`);
  assert.equal(debit(940_000_000), `940${NB}Mbit/s`);
  assert.equal(debit(1_200_000_000), `1,2${NB}Gbit/s`);
  assert.equal(debit(null), "–");
  assert.equal(debit(NaN), "–");
  assert.equal(formater.debit, debit);
});

test("formater.octets (base 10, comme « 2,2 / 16 To »)", () => {
  assert.equal(octets(2_200_000_000_000), `2,2${NB}To`);
  assert.equal(octets(16_000_000_000_000), `16${NB}To`);
  assert.equal(octets(41_000_000_000), `41${NB}Go`);
  assert.equal(octets(512_000_000), `512${NB}Mo`);
  assert.equal(octets(900), `900${NB}o`);
  assert.equal(octets(undefined), "–");
  assert.equal(formater.octets, octets);
});

test("formater.duree", () => {
  assert.equal(duree(2280), `38${NB}min`);
  assert.equal(duree(42), `42${NB}s`);
  assert.equal(duree(3600 * 2 + 300), `2${NB}h 5${NB}min`);
  assert.equal(duree(86400 * 3 + 3600 * 4), `3${NB}j 4${NB}h`);
  assert.equal(duree(-1), "–");
  assert.equal(formater.duree, duree);
});

test("formater.pourcent", () => {
  assert.equal(pourcent(0.14), `14${NNB}%`);
  assert.equal(pourcent(0), `0${NNB}%`);
  assert.equal(pourcent(1), `100${NNB}%`);
  assert.equal(pourcent(null), "–");
  assert.equal(formater.pourcent, pourcent);
});

test("formater.chrono (m:ss du bandeau « Connexion perdue »)", () => {
  assert.equal(chrono(42_000), "0:42");
  assert.equal(chrono(5_400), "0:05");
  assert.equal(chrono(19 * 60_000 + 7_000), "19:07");
  assert.equal(chrono(3_723_000), "1:02:03");
  assert.equal(chrono(-5), "0:00");
});

/* ------------------------------------------------------------------ connecter (faux EventSource) */

class FauxEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.ecouteurs = new Map();
    this.ferme = false;
    FauxEventSource.instances.push(this);
  }
  addEventListener(type, f) {
    if (!this.ecouteurs.has(type)) this.ecouteurs.set(type, []);
    this.ecouteurs.get(type).push(f);
  }
  emettre(type, data) {
    for (const f of this.ecouteurs.get(type) || []) f({ type, data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close() {
    this.ferme = true;
    this.readyState = 2;
  }
}

/** Horloge manuelle : `avancer(ms)` fait tourner les minuteries à la main. */
function horlogeManuelle() {
  let t = 1_000_000;
  const minuteries = [];
  return {
    maintenant: () => t,
    setInterval: (f, ms) => { const m = { f, ms, prochain: t + ms, actif: true }; minuteries.push(m); return m; },
    clearInterval: (m) => { if (m) m.actif = false; },
    avancer(ms) {
      const fin = t + ms;
      for (;;) {
        const m = minuteries.filter((x) => x.actif).sort((a, b) => a.prochain - b.prochain)[0];
        if (!m || m.prochain > fin) break;
        t = m.prochain;
        m.prochain += m.ms;
        m.f();
      }
      t = fin;
    },
  };
}

function brancher() {
  FauxEventSource.instances = [];
  const h = horlogeManuelle();
  const appels = { etat: [], evenement: [], connexion: [] };
  const c = connecter({
    surEtat: (i) => appels.etat.push(i),
    surEvenement: (e) => appels.evenement.push(e),
    surConnexion: (ok, ms) => appels.connexion.push([ok, ms]),
    EventSource: FauxEventSource,
    horloge: h,
  });
  return { c, h, appels, es: () => FauxEventSource.instances.at(-1) };
}

test("connecter : ouvre /api/flux et transmet etat / evenement", () => {
  const { c, appels, es } = brancher();
  assert.equal(es().url, "/api/flux");
  es().emettre("etat", { t: 1, noeuds: [] });
  es().emettre("evenement", { id: "ct-102", importance: 2 });
  es().emettre("etat", "{pas du json");
  assert.equal(appels.etat.length, 1);
  assert.deepEqual(appels.evenement, [{ id: "ct-102", importance: 2 }]);
  assert.deepEqual(appels.connexion, []);
  c.fermer();
  assert.ok(es().ferme);
});

test("connecter : sans message pendant 6 s → surConnexion(false, ≥ 5000), puis chaque seconde", () => {
  const { c, h, appels } = brancher();
  assert.equal(SEUIL_PERTE_MS, 5000);
  h.avancer(4_900);
  assert.deepEqual(appels.connexion, [], "pas d'alerte avant 5 s");
  h.avancer(1_100);
  assert.ok(appels.connexion.length >= 1);
  const [ok, ms] = appels.connexion[0];
  assert.equal(ok, false);
  assert.ok(ms >= 5000, `depuisMs = ${ms}`);
  const avant = appels.connexion.length;
  h.avancer(3_000);
  assert.equal(appels.connexion.length, avant + 3, "un appel par seconde pendant la perte");
  const ms2 = appels.connexion.at(-1)[1];
  assert.ok(ms2 > ms, "la durée augmente");
  c.fermer();
});

test("connecter : un etat après la perte → surConnexion(true, 0), puis silence", () => {
  const { c, h, appels, es } = brancher();
  h.avancer(7_000);
  assert.equal(appels.connexion.at(-1)[0], false);
  es().emettre("etat", { t: 2, noeuds: [] });
  assert.deepEqual(appels.connexion.at(-1), [true, 0]);
  const n = appels.connexion.length;
  h.avancer(3_000);
  assert.equal(appels.connexion.length, n, "plus d'appel une fois rétabli");
  c.fermer();
});

test("connecter : flux muet (TCP à moitié ouvert) ou fermé → nouvelle tentative avec un nouvel EventSource", () => {
  const { c, h, es } = brancher();
  const premier = es();
  h.avancer(11_000);
  assert.notEqual(es(), premier, "un nouvel EventSource a été créé");
  assert.ok(premier.ferme, "l'ancien est fermé");
  // flux fermé par le navigateur (réponse non 200) : relance sans attendre la prochaine fenêtre
  const second = es();
  second.readyState = 2;
  second.emettre("error", "");
  h.avancer(2_100);
  assert.notEqual(es(), second);
  c.fermer();
  const nb = FauxEventSource.instances.length;
  h.avancer(30_000);
  assert.equal(FauxEventSource.instances.length, nb, "plus rien après fermer()");
});

/* ------------------------------------------------------------------ résumé de la barre */

test("resumeEnLigne : machines et invités, sans sites ni appareils ni éteints exprès", () => {
  const g = new Graphe();
  g.appliquer(demo);
  const r = resumeEnLigne(g.noeuds.values());
  const attendus = demo.noeuds.filter((n) => n.type !== "site" && n.type !== "appareil" && n.etat !== "eteint");
  assert.equal(r.total, attendus.length);
  assert.equal(r.enLigne, attendus.filter((n) => n.etat === "on").length);
  assert.equal(r.pannes, attendus.filter((n) => n.etat === "off").length);
  assert.ok(r.enLigne <= r.total && r.total > 20);
});

/* ------------------------------------------------------------------ liens à ouvrir (interactions.js) */

test("liensDuNoeud : CT/VM → page Proxmox, sites/équipements → leur URL", () => {
  const n = (id) => demo.noeuds.find((x) => x.id === id);
  assert.equal(lienProxmox(n("ct-120")), "https://pve.lan/#v1:0:=lxc%2F120:4:::::::");
  assert.equal(liensDuNoeud(n("ct-120"))[0].url, "https://pve.lan/#v1:0:=lxc%2F120:4:::::::");
  assert.equal(liensDuNoeud(n("vm-220"))[0].url, "https://pve.lan/#v1:0:=qemu%2F220:4:::::::");
  const truenas = liensDuNoeud(n("vm-200")).map((l) => l.url);
  assert.ok(truenas.includes("https://pve.lan/#v1:0:=qemu%2F200:4:::::::"), "VM 200 : page Proxmox proposée");
  assert.equal(liensDuNoeud(n("site-exemple.fr"))[0].url, "https://exemple.fr");
  assert.equal(liensDuNoeud(n("pve"))[0].url, "https://pve.lan");
  assert.equal(liensDuNoeud(n("mikrotik"))[0].url, "http://192.168.10.198");
  assert.deepEqual(liensDuNoeud(n("internet")), []);
});

test("urlSure : seulement http(s), jamais javascript:", () => {
  assert.equal(urlSure("https://site-d.exemple.fr"), "https://site-d.exemple.fr");
  assert.equal(urlSure("javascript:alert(1)"), null);
  assert.equal(urlSure("JaVaScRiPt:alert(1)"), null);
  assert.equal(urlSure("https://x.fr/\"><script>"), null);
  assert.equal(urlSure("data:text/html,x"), null);
  assert.equal(urlSure(null), null);
  assert.equal(urlSure("https://" + "a".repeat(300)), null);
  assert.deepEqual(liensDuNoeud({ id: "site-x", type: "site", url: "javascript:alert(1)" }), []);
});

/* ------------------------------------------------------------------ panneau de détails */

test("descriptionNoeud : CT avec jauges, débit et lien Proxmox ; aucun HTML", () => {
  const g = new Graphe();
  g.appliquer(demo);
  const d = descriptionNoeud(g.noeuds.get("ct-120"), g);
  assert.equal(d.nom, "ticketing");
  assert.equal(d.typeTexte, "Conteneur LXC");
  assert.equal(d.etatTexte, "En ligne");
  assert.ok(d.jauges.some((j) => j.cle === "cpu"));
  assert.ok(d.jauges.some((j) => j.cle === "ram" && j.valeur.includes("Go")));
  assert.ok(d.lignes.some((l) => l.libelle === "IP" && l.valeur === "192.168.10.152"));
  assert.ok(d.liens[0].url.startsWith("https://pve.lan/#v1:0:=lxc%2F120"));
  for (const j of d.jauges) assert.ok(j.frac >= 0 && j.frac <= 1, j.cle);
});

test("descriptionNoeud : onduleur, stockage PBS, enfants de PVE", () => {
  const g = new Graphe();
  g.appliquer(demo);
  const ups = descriptionNoeud(g.noeuds.get("onduleur"), g);
  assert.ok(ups.jauges.some((j) => j.cle === "batterie" && j.valeur === `100${NNB}%`));
  assert.ok(ups.lignes.some((l) => l.libelle === "Alimentation" && l.valeur === "Secteur"));
  const pbs = descriptionNoeud(g.noeuds.get("pbs"), g);
  const disque = pbs.jauges.find((j) => j.cle === "disque");
  assert.equal(disque.valeur, `1,5 / 3,8${NB}To · 38${NNB}%`);
  const pve = descriptionNoeud(g.noeuds.get("pve"), g);
  assert.ok(pve.enfants.length >= 29, "les invités sont listés");
  const etrange = descriptionNoeud({ id: "x", nom: "<img src=x onerror=alert(1)>", type: "site", etat: "off", jauges: {}, details: {} }, g);
  assert.equal(etrange.nom, "<img src=x onerror=alert(1)>", "le texte est gardé tel quel (affiché via textContent)");
  assert.equal(etrange.etatTexte, "En panne");
});
