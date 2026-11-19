import { test } from "node:test";
import assert from "node:assert/strict";
import { tauxEmission, vitesse, Influx, TAILLE_POOL } from "../js/particules.js";
import { Graphe } from "../js/graphe.js";
import { Camera } from "../js/camera.js";

test("tauxEmission : échelle logarithmique bornée", () => {
  assert.equal(tauxEmission(null), 0);
  assert.equal(tauxEmission(undefined), 0);
  assert.equal(tauxEmission(0), 0);
  assert.equal(tauxEmission(1000), 0);
  assert.equal(tauxEmission(-5e6), 0);
  assert.equal(tauxEmission(NaN), 0);
  assert.equal(tauxEmission(1e6), 30);
  assert.equal(tauxEmission(1e9), 60);
  assert.equal(tauxEmission(1e12), 60);
  assert.ok(Math.abs(tauxEmission(1e4) - 10) < 1e-9);
});

test("vitesse : de 0,25 à 1, croissante", () => {
  assert.equal(vitesse(null), 0.25);
  assert.equal(vitesse(1000), 0.25);
  assert.equal(vitesse(1e9), 1);
  assert.equal(vitesse(1e12), 1);
  const serie = [1e4, 1e5, 1e6, 1e7, 1e8, 1e9].map(vitesse);
  for (let i = 1; i < serie.length; i++) assert.ok(serie[i] > serie[i - 1], `vitesse(${i}) croissante`);
  for (const v of serie) assert.ok(v >= 0.25 && v <= 1);
});

/** Graphe synthétique : un centre et `n` feuilles, chaque lien à `bps` dans les deux sens. */
function grapheEtoile(n, bps) {
  const noeuds = [{ id: "mikrotik", type: "routeur", groupe: "mikrotik", parent: null, niveau: 0, etat: "on" }];
  const liens = [];
  for (let i = 0; i < n; i++) {
    noeuds.push({ id: `ct-${i}`, type: "ct", groupe: "pve", parent: "mikrotik", niveau: 2, etat: "on" });
    liens.push({ id: `mikrotik>ct-${i}`, de: "mikrotik", vers: `ct-${i}`, type: "virtuel", etat: "on", descendant: bps, montant: bps });
  }
  const g = new Graphe();
  g.appliquer({ t: 0, version: 1, sources: {}, noeuds, liens });
  let a = 0;
  for (const nd of g.noeuds.values()) {
    if (nd.id === "mikrotik") { nd.x = 0; nd.y = 0; nd.z = 120; continue; }
    nd.x = Math.cos(a) * 300; nd.y = Math.sin(a) * 300; nd.z = 35;
    a += 0.031;
  }
  return g;
}

test("Influx : 10 000 images, 200 liens à 1 Gbit/s → jamais plus de 4 000 particules", () => {
  assert.equal(TAILLE_POOL, 4000);
  const g = grapheEtoile(200, 1e9);
  const inf = new Influx();
  let max = 0;
  for (let i = 0; i < 10000; i++) {
    inf.maj(1 / 60, g);
    if (inf.nombre > max) max = inf.nombre;
    assert.ok(inf.nombre <= 4000, `image ${i} : ${inf.nombre} particules`);
  }
  assert.ok(max > 1000, `le pool doit vraiment se remplir (max ${max})`);
});

test("Influx : rien sur un lien sans débit, éteint ou dont un bout est en panne", () => {
  const g = grapheEtoile(3, null);
  const inf = new Influx();
  for (let i = 0; i < 300; i++) inf.maj(1 / 60, g);
  assert.equal(inf.nombre, 0);

  const g2 = grapheEtoile(2, 1e8);
  g2.liens.get("mikrotik>ct-0").etat = "eteint";
  g2.noeuds.get("ct-1").etat = "off";
  for (let i = 0; i < 300; i++) inf.maj(1 / 60, g2);
  assert.equal(inf.nombre, 0);
});

test("Influx : deux voies, les particules arrivent et préviennent le nœud d'arrivée", () => {
  const g = grapheEtoile(1, 1e7);
  g.liens.get("mikrotik>ct-0").montant = null; // seulement le sens descendant
  const inf = new Influx();
  const arrivees = new Map();
  inf.surArrivee = (id) => arrivees.set(id, (arrivees.get(id) || 0) + 1);
  for (let i = 0; i < 600; i++) inf.maj(1 / 60, g);
  assert.ok(inf.nombre > 0);
  assert.ok((arrivees.get("ct-0") || 0) > 10, "descendant : arrivée côté `vers`");
  assert.equal(arrivees.get("mikrotik") || 0, 0, "aucun montant");
  const voies = inf.compterVoies("mikrotik>ct-0");
  assert.ok(voies.descendant > 0);
  assert.equal(voies.montant, 0);
});

test("Influx : un lien qui disparaît libère ses particules, dt absurde ignoré", () => {
  const g = grapheEtoile(5, 1e9);
  const inf = new Influx();
  for (let i = 0; i < 120; i++) inf.maj(1 / 60, g);
  assert.ok(inf.nombre > 0);
  g.appliquer({ t: 1, version: 1, sources: {}, noeuds: [...g.noeuds.values()], liens: [] });
  inf.maj(1 / 60, g);
  assert.equal(inf.nombre, 0);
  inf.maj(NaN, g);
  inf.maj(-1, g);
  inf.maj(1e9, g);
  assert.ok(inf.nombre <= 4000);
});

test("Influx : aucune position NaN même sans coordonnées", () => {
  const g = grapheEtoile(4, 1e8);
  for (const n of g.noeuds.values()) { delete n.x; delete n.y; }
  const inf = new Influx();
  for (let i = 0; i < 200; i++) inf.maj(1 / 60, g);
  assert.ok(inf.nombre > 0);
  assert.ok(inf.toutesFinies());
});

test("Influx.dessiner : têtes et traînées groupées, peu d'appels de dessin même avec des milliers d'impulsions", () => {
  const g = grapheEtoile(200, 1e9);
  const inf = new Influx();
  for (let i = 0; i < 240; i++) inf.maj(1 / 60, g);
  assert.ok(inf.nombre > 1000, `${inf.nombre} impulsions`);
  const appels = { fill: 0, stroke: 0, drawImage: 0, arc: 0 };
  const ctx = new Proxy({}, {
    get: (c, k) => (k in c ? c[k] : k in appels ? () => { appels[k]++; } : () => {}),
    set: (c, k, v) => { c[k] = v; return true; },
  });
  inf.dessiner(ctx, new Camera({ largeur: 1600, hauteur: 900 }));
  assert.ok(appels.arc >= inf.nombre * 0.5, `têtes dessinées : ${appels.arc} disques pour ${inf.nombre} impulsions`);
  const total = appels.fill + appels.stroke + appels.drawImage;
  assert.ok(total <= 60, `${total} appels de dessin`);
});
