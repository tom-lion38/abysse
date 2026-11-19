import { test } from "node:test";
import assert from "node:assert/strict";
import { Interactions, DELAI_OUVERTURE_MS } from "../js/interactions.js";

/* ------------------------------------------------------------------ faux navigateur */

// Node n'a ni `window` ni canvas : on fournit le strict nécessaire et on note les onglets ouverts.
function fauxEnvironnement(t) {
  const ouverts = [];
  const avant = globalThis.window;
  globalThis.window = {
    open: (...a) => { ouverts.push(a); return null; },
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1920, innerHeight: 1080,
  };
  t.after(() => { if (avant === undefined) delete globalThis.window; else globalThis.window = avant; });

  const ecouteurs = new Map();
  const canvas = {
    addEventListener: (type, f) => ecouteurs.set(type, f),
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture() {}, releasePointerCapture() {},
    classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
    clientHeight: 600,
  };
  const noeud = { id: "site-site-d.exemple.fr", nom: "site-d.exemple.fr", type: "site", url: "https://site-d.exemple.fr", x: 10, y: 20 };
  const graphe = { noeuds: new Map([[noeud.id, noeud]]), t: 0 };
  const visees = [];
  const camera = { k: 1, viser: (c, d) => visees.push(c), tourner() {}, deplacer() {}, zoomer() {}, deprojeter: (x, y) => ({ x, y }) };
  const rendu = { calme: false, noeudSous: () => noeud.id, recadrer() {}, ecran: () => null };
  const inter = new Interactions(canvas, { camera, rendu, graphe });
  t.after(() => inter.detruire());

  const ev = (type, o = {}) => ecouteurs.get(type)({
    pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, clientX: 100, clientY: 100,
    preventDefault() {}, ...o,
  });
  const clic = () => { ev("pointerdown"); ev("pointerup"); };
  return { ouverts, visees, ev, clic, inter };
}

/* ------------------------------------------------------------------ clic / double-clic */

test("clic simple sur un nœud à lien : onglet ouvert après le délai, une seule fois", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ouverts, clic } = fauxEnvironnement(t);
  clic();
  assert.equal(ouverts.length, 0, "rien n'est ouvert tant qu'un double-clic reste possible");
  t.mock.timers.tick(DELAI_OUVERTURE_MS - 1);
  assert.equal(ouverts.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(ouverts, [["https://site-d.exemple.fr", "_blank", "noopener"]]);
  t.mock.timers.tick(5000);
  assert.equal(ouverts.length, 1);
});

test("double-clic sur un nœud à lien : recentre sans ouvrir d'onglet", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ouverts, visees, ev, clic } = fauxEnvironnement(t);
  clic();
  t.mock.timers.tick(120);
  clic();
  ev("dblclick");
  t.mock.timers.tick(5000);
  assert.equal(ouverts.length, 0, "le double-clic annule l'ouverture en attente");
  assert.equal(visees.length, 1);
  assert.equal(visees[0].tx, 10);
  assert.equal(visees[0].ty, 20);
});

test("Maj+clic : panneau de détails tout de suite, aucun onglet", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ouverts, ev, inter } = fauxEnvironnement(t);
  const details = [];
  inter.surDetails = (id) => details.push(id);
  ev("pointerdown", { shiftKey: true });
  ev("pointerup", { shiftKey: true });
  assert.deepEqual(details, ["site-site-d.exemple.fr"]);
  t.mock.timers.tick(5000);
  assert.equal(ouverts.length, 0);
});

test("détruire annule une ouverture en attente", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ouverts, clic, inter } = fauxEnvironnement(t);
  clic();
  inter.detruire();
  t.mock.timers.tick(5000);
  assert.equal(ouverts.length, 0);
});

test("Maj+clic : le panneau s'ouvre sans que le survol (et son infobulle) revienne par-dessus", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ev, inter } = fauxEnvironnement(t);
  inter.surDetails = () => inter.oublierSurvol(); // comme main.js : ouvrir le panneau coupe le survol
  ev("pointerdown", { shiftKey: true });
  ev("pointerup", { shiftKey: true });
  assert.equal(inter.survol, null);
});
