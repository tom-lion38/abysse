import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rayonPing, tVersX, xVersT, formatInstant, graduations, pingSous, bornerVue, fusionner,
  JOUR, FENETRE_MAX, FENETRE_MIN, Frise,
} from "../js/frise.js";
import { Element, installerDom } from "./dom-factice.mjs";

test("rayonPing : 4, 7, 11, 18 selon l'importance", () => {
  assert.equal(rayonPing(1), 4);
  assert.equal(rayonPing(2), 7);
  assert.equal(rayonPing(3), 11);
  assert.equal(rayonPing(4), 18);
  // hors bornes : ramené dans 1-4, jamais NaN
  assert.equal(rayonPing(0), 4);
  assert.equal(rayonPing(9), 18);
  assert.equal(rayonPing("3"), 11);
  assert.equal(rayonPing(undefined), 4);
});

test("tVersX / xVersT : bornes et aller-retour", () => {
  const de = 1792900000, a = de + JOUR, L = 1200;
  assert.equal(tVersX(de, de, a, L), 0);
  assert.equal(tVersX(a, de, a, L), L);
  assert.equal(xVersT(0, de, a, L), de);
  assert.equal(xVersT(L, de, a, L), a);
  for (const t of [de, a, de + 43200, de + 21600, de + 64800]) {
    assert.equal(xVersT(tVersX(t, de, a, L), de, a, L), t);
  }
  let graine = 7;
  const alea = () => ((graine = (graine * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const d = 1.79e9 + alea() * 1e7, span = 600 + alea() * 30 * JOUR, l = 200 + alea() * 3000;
    const t = d + alea() * span;
    assert.ok(Math.abs(xVersT(tVersX(t, d, d + span, l), d, d + span, l) - t) < 1e-3);
  }
  // fenêtre dégénérée : pas de NaN
  assert.ok(Number.isFinite(tVersX(5, 5, 5, 100)));
  assert.ok(Number.isFinite(xVersT(10, 5, 5, 0)));
});

test("formatInstant : « 25/10 23:14 » (heure locale)", () => {
  const t = new Date(2026, 9, 25, 23, 14, 30).getTime() / 1000;
  assert.equal(formatInstant(t), "25/10 23:14");
});

test("graduations : dans la fenêtre, espacées, heures sur 24 h, jours sur 7 j", () => {
  const de = new Date(2026, 9, 25, 0, 0).getTime() / 1000, L = 1200;
  const g = graduations(de, de + JOUR, L);
  assert.ok(g.length >= 4 && g.length <= 24, String(g.length));
  for (let i = 0; i < g.length; i++) {
    assert.ok(g[i].x >= 0 && g[i].x <= L);
    assert.match(g[i].texte, /^\d{2}:\d{2}$|^\d{2}\/\d{2}$/);
    if (i) assert.ok(g[i].x - g[i - 1].x >= 60, "trop serrées");
  }
  const s = graduations(de, de + 7 * JOUR, L);
  assert.ok(s.some((x) => /^\d{2}\/\d{2}$/.test(x.texte)));
  assert.deepEqual(graduations(de, de, L), []);
});

test("pingSous : le ping le plus important sous le pointeur", () => {
  const pings = [
    { x: 100, y: 30, r: 4, evt: { importance: 1, id: "a" } },
    { x: 104, y: 30, r: 18, evt: { importance: 4, id: "b" } },
    { x: 400, y: 30, r: 7, evt: { importance: 2, id: "c" } },
  ];
  assert.equal(pingSous(pings, 101, 30).evt.id, "b");
  assert.equal(pingSous(pings, 402, 28).evt.id, "c");
  assert.equal(pingSous(pings, 700, 30), null);
  assert.equal(pingSous([], 0, 0), null);
});

test("bornerVue : entre 10 min et 30 jours, jamais dans le futur ni avant 30 jours", () => {
  const m = 1792970000;
  assert.deepEqual(bornerVue(m - JOUR, m, m), { de: m - JOUR, a: m });
  const large = bornerVue(m - 90 * JOUR, m, m);
  assert.equal(large.a - large.de, FENETRE_MAX);
  const etroit = bornerVue(m - 10, m, m);
  assert.equal(etroit.a - etroit.de, FENETRE_MIN);
  const futur = bornerVue(m, m + JOUR, m);
  assert.ok(futur.a <= m + 0.02 * JOUR);
  assert.equal(futur.a - futur.de, JOUR);
  const vieux = bornerVue(m - 40 * JOUR, m - 39 * JOUR, m);
  assert.ok(vieux.de >= m - FENETRE_MAX - 1e-6);
  assert.equal(vieux.a - vieux.de, JOUR);
});

test("fusionner : sans doublon, trié par date", () => {
  const a = [{ t: 10, id: "ct-1", nature: "panne", importance: 2 }, { t: 30, id: "pve", nature: "panne", importance: 4 }];
  const b = [{ t: 10, id: "ct-1", nature: "panne", importance: 2 }, { t: 20, id: "ct-2", nature: "retour", importance: 2 }];
  const r = fusionner(a, b);
  assert.deepEqual(r.map((e) => e.t), [10, 20, 30]);
  assert.deepEqual(fusionner([], [null, { t: "x" }, { t: 5, id: "a", nature: "panne" }]).map((e) => e.t), [5]);
});

/* ------------------------------------------------------------------ composant (DOM factice) */

/** Faux serveur : `/api/historique` renvoie les évènements de `base` compris dans [de, a]. */
function fauxServeur(base, { echecs = 0 } = {}) {
  const appels = [];
  const f = async (url) => {
    appels.push(url);
    if (echecs > 0) { echecs--; throw new Error("injoignable"); }
    const q = new URL(url, "http://abysse.test").searchParams;
    const de = Number(q.get("de")), a = Number(q.get("a"));
    const evenements = base.filter((e) => e.t >= de && e.t <= a);
    return { ok: true, status: 200, json: async () => ({ bornes: [de, a], evenements }) };
  };
  return { fetch: f, appels };
}

const M = 1792970000;

test("Frise.recharger : après une reconnexion, récupère les évènements de la coupure et le ping « injoignable »", async (t) => {
  installerDom(t);
  const base = [{ t: M - 7200, id: "ct-102", nom: "supervision", nature: "panne", importance: 2, texte: "CT 102 supervision arrêté" }];
  const serveur = fauxServeur(base);
  let maintenant = M;
  const frise = new Frise(new Element("footer"), { fetch: serveur.fetch, maintenant: () => maintenant });
  await frise.charger(M - JOUR, M);
  assert.deepEqual(frise.evenements.map((e) => e.id), ["ct-102"]);

  // coupure de 20 min : le serveur redémarre et écrit le trou dans l'historique (pas de SSE pour lui),
  // un CT est tombé pendant que la page ne recevait rien
  const debutCoupure = M + 5;
  maintenant = M + 1200;
  base.push(
    { t: debutCoupure - 3, id: "abysse", nom: "Abysse", nature: "panne", importance: 4, texte: "Abysse injoignable 20 min" },
    { t: M + 600, id: "ct-124", nom: "site-a", nature: "panne", importance: 2, texte: "CT 124 site-a arrêté" },
  );
  const vue = { ...frise.vue };
  const ok = await frise.recharger(debutCoupure - 60);
  assert.equal(ok, true);
  assert.deepEqual(frise.evenements.map((e) => e.id), ["ct-102", "abysse", "ct-124"]);
  assert.equal(frise.evenements.find((e) => e.id === "abysse").importance, 4);
  // la requête part du début de la coupure (moins la marge) jusqu'à maintenant
  const q = new URL(serveur.appels.at(-1), "http://abysse.test").searchParams;
  assert.ok(Number(q.get("de")) <= debutCoupure - 60 + 1e-3);
  assert.ok(Number(q.get("a")) >= maintenant);
  // la fenêtre affichée n'est pas déplacée par le rechargement
  assert.deepEqual(frise.vue, vue);

  // sans point de départ : toute la fenêtre affichée
  await frise.recharger();
  const q2 = new URL(serveur.appels.at(-1), "http://abysse.test").searchParams;
  assert.ok(Math.abs(Number(q2.get("de")) - frise.vue.de) < 1e-3);
});

test("Frise.recharger : un échec est retenté sur la même plage", async (t) => {
  installerDom(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const base = [{ t: M - 30, id: "pve", nom: "pve", nature: "panne", importance: 4, texte: "PVE injoignable" }];
  const serveur = fauxServeur(base, { echecs: 1 });
  const frise = new Frise(new Element("footer"), { fetch: serveur.fetch, maintenant: () => M });
  assert.equal(await frise.recharger(M - 120), false);
  assert.equal(frise.evenements.length, 0);
  t.mock.timers.tick(10000);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(serveur.appels.length, 2);
  const q = new URL(serveur.appels[1], "http://abysse.test").searchParams;
  assert.ok(Math.abs(Number(q.get("de")) - (M - 120)) < 1e-3, "la relance doit reprendre la plage du rechargement");
  assert.deepEqual(frise.evenements.map((e) => e.id), ["pve"]);
});
