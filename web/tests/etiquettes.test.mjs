import { test } from "node:test";
import assert from "node:assert/strict";
import { Placeur, boite } from "../js/etiquettes.js";

const ZONE = { x0: 0, y0: 60, x1: 1600, y1: 800 };
const coupe = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
function cercleCoupe(b, c) {
  const px = Math.max(b.x0, Math.min(c.x, b.x1)), py = Math.max(b.y0, Math.min(c.y, b.y1));
  return (px - c.x) ** 2 + (py - c.y) ** 2 < c.r * c.r;
}
const demande = (id, x, y, o = {}) => ({ id, x, y, r: 6, priorite: 0, variantes: [{ w: 80, h: 14 }], prefere: null, ...o });

test("boite : la direction donne la position et l'alignement du texte", () => {
  const d = demande("a", 500, 400, { r: 10 });
  const dessous = boite(d, d.variantes[0], Math.PI / 2, 4);
  assert.equal(dessous.aligne, "center");
  assert.ok(Math.abs((dessous.x0 + dessous.x1) / 2 - 500) < 1e-9);
  assert.ok(Math.abs(dessous.y0 - 414) < 1e-9);
  const droite = boite(d, d.variantes[0], 0, 4);
  assert.equal(droite.aligne, "left");
  assert.ok(Math.abs(droite.x0 - 514) < 1e-9);
  const gauche = boite(d, d.variantes[0], Math.PI, 4);
  assert.equal(gauche.aligne, "right");
  assert.ok(Math.abs(gauche.x1 - 486) < 1e-9);
});

test("aucun chevauchement entre étiquettes visibles, même serrées", () => {
  const p = new Placeur();
  const dem = [];
  for (let i = 0; i < 60; i++) dem.push(demande("n" + i, 400 + (i % 10) * 30, 200 + Math.floor(i / 10) * 22, { priorite: i % 7 }));
  const res = p.placer(dem, dem.map((d) => ({ x: d.x, y: d.y, r: d.r, id: d.id })), ZONE);
  const vues = res.filter((r) => r.visible);
  assert.ok(vues.length > 5 && vues.length < 60);
  for (let i = 0; i < vues.length; i++) for (let j = i + 1; j < vues.length; j++) assert.ok(!coupe(vues[i], vues[j]), `${vues[i].id} / ${vues[j].id}`);
  for (const r of res) for (const k of ["x0", "y0", "x1", "y1"]) assert.ok(!r.visible || Number.isFinite(r[k]));
});

test("une étiquette ne recouvre pas un autre nœud : elle change de côté", () => {
  const p = new Placeur();
  const a = demande("a", 500, 400);
  const obstacles = [{ id: "a", x: 500, y: 400, r: 6 }, { id: "b", x: 500, y: 418, r: 8 }]; // juste dessous
  const [r] = p.placer([a], obstacles, ZONE);
  assert.ok(r.visible);
  assert.ok(!cercleCoupe(r, obstacles[1]));
  assert.notEqual(r.cote, "dessous");
});

test("priorité : la plus importante garde sa place préférée", () => {
  const p = new Placeur();
  const fort = demande("fort", 500, 400, { priorite: 10 });
  const faible = demande("faible", 505, 402, { priorite: 1 });
  const res = p.placer([faible, fort], [], ZONE);
  const rf = res.find((r) => r.id === "fort");
  assert.equal(rf.cote, "dessous");
  assert.ok(res.find((r) => r.id === "faible").cote !== "dessous" || !res.find((r) => r.id === "faible").visible);
});

test("dégradation : sans place pour la version complète, la version courte s'affiche", () => {
  const p = new Placeur();
  const d = demande("ct", 500, 400, { variantes: [{ w: 120, h: 60 }, { w: 60, h: 14 }] });
  // des voisins tout autour, à 40 px : la version complète (60 px de haut) ne tient nulle part
  const voisins = [];
  for (let k = 0; k < 8; k++) voisins.push({ id: "v" + k, x: 500 + Math.cos(k * Math.PI / 4) * 46, y: 400 + Math.sin(k * Math.PI / 4) * 46, r: 6 });
  const [r] = p.placer([d], [{ id: "ct", x: 500, y: 400, r: 6 }, ...voisins], ZONE);
  assert.ok(r.visible);
  assert.equal(r.variante, 1);
});

test("hystérésis : la place de l'image précédente est gardée tant qu'elle reste libre", () => {
  const p = new Placeur();
  const a = demande("a", 500, 400);
  const genant = { id: "g", x: 500, y: 420, r: 8 };
  const r1 = p.placer([a], [{ id: "a", x: 500, y: 400, r: 6 }, genant], ZONE)[0];
  assert.notEqual(r1.cote, "dessous");
  // le gêneur s'en va : « dessous » redevient libre, mais on ne saute pas
  const r2 = p.placer([a], [{ id: "a", x: 500, y: 400, r: 6 }], ZONE)[0];
  assert.equal(r2.cote, r1.cote);
});

test("zone : jamais sous la barre du haut ni sous la frise", () => {
  const p = new Placeur();
  const res = p.placer([demande("haut", 800, 62), demande("bas", 800, 796)], [], ZONE);
  for (const r of res) {
    if (!r.visible) continue;
    assert.ok(r.y0 >= ZONE.y0 && r.y1 <= ZONE.y1, `${r.id} hors zone`);
  }
  assert.ok(res.every((r) => r.visible));
});

test("préférence radiale : un site à droite de son parent a son étiquette à droite", () => {
  const p = new Placeur();
  const [r] = p.placer([demande("site", 600, 400, { prefere: 0 })], [], ZONE);
  assert.equal(r.aligne, "left");
  assert.ok(r.x0 > 600);
});

test("déterministe : mêmes demandes, mêmes résultats", () => {
  const dem = [];
  for (let i = 0; i < 40; i++) dem.push(demande("n" + i, 300 + ((i * 37) % 400), 200 + ((i * 53) % 300), { priorite: i % 5 }));
  const a = new Placeur().placer(dem, [], ZONE);
  const b = new Placeur().placer(dem, [], ZONE);
  assert.deepEqual(a, b);
});

test("réserves : aucune étiquette sous un rectangle réservé (légende, panneau)", () => {
  const p = new Placeur();
  const legende = { x0: 0, y0: 600, x1: 500, y1: 800 };
  const dem = [demande("a", 200, 590), demande("b", 300, 640), demande("c", 900, 640)];
  const res = p.placer(dem, [], ZONE, [legende]);
  for (const r of res) if (r.visible) assert.ok(!coupe(r, legende), `${r.id} sous la légende`);
  assert.ok(res.find((r) => r.id === "a").visible, "a trouve une place au-dessus");
  assert.ok(res.find((r) => r.id === "c").visible);
});
