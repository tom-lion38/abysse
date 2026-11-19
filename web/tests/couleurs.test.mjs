import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUPES, ROUGE, GRIS_ETEINT, INCONNU, eclaircir, couleurNoeud, versRgb, palette,
} from "../js/couleurs.js";

test("GROUPES reprend les couleurs des contraintes globales", () => {
  assert.deepEqual(GROUPES, {
    mikrotik: "#7fe7ff", internet: "#ff9a3c", pve: "#a37bff", pbs: "#4fe39a", synology: "#4f8dff",
    truenas: "#2fe0c8", onduleur: "#ffc94a", ha: "#6cc8ff", reseau: "#9aa7b5", appareils: "#ff7ad9",
  });
  assert.equal(ROUGE, "#ff3b4e");
  assert.equal(GRIS_ETEINT, "#4a5563");
  assert.equal(INCONNU, "#5b7a99");
});

test("eclaircir : 0 ne change rien, 1 donne du blanc", () => {
  assert.equal(eclaircir("#000000", 1), "#ffffff");
  assert.equal(eclaircir("#a37bff", 0), "#a37bff");
  assert.equal(eclaircir("#000000", 0.5), "#808080");
  assert.equal(eclaircir("#A37BFF", 0), "#a37bff");
});

test("eclaircir borne t entre 0 et 1", () => {
  assert.equal(eclaircir("#102030", -2), "#102030");
  assert.equal(eclaircir("#102030", 7), "#ffffff");
});

test("versRgb", () => {
  assert.deepEqual(versRgb("#7fe7ff"), { r: 127, g: 231, b: 255 });
});

test("couleurNoeud : racine du groupe = couleur du groupe", () => {
  assert.deepEqual(couleurNoeud({ groupe: "pve" }, 0), versRgb("#a37bff"));
});

test("couleurNoeud : 0,18 par niveau sous la racine du groupe, plafonné à 0,6", () => {
  assert.deepEqual(couleurNoeud({ groupe: "pve" }, 1), versRgb(eclaircir("#a37bff", 0.18)));
  assert.deepEqual(couleurNoeud({ groupe: "pve" }, 2), versRgb(eclaircir("#a37bff", 0.36)));
  assert.deepEqual(couleurNoeud({ groupe: "pve" }, 9), versRgb(eclaircir("#a37bff", 0.6)));
});

test("couleurNoeud : groupe inconnu → teinte de repli, jamais le rouge", () => {
  const c = couleurNoeud({ groupe: "nimporte" }, 0);
  for (const v of [c.r, c.g, c.b]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255);
  assert.notDeepEqual(c, versRgb(ROUGE));
  assert.deepEqual(couleurNoeud({}, 0), c);
});

/* ------------------------------------------------------------------ palette de rendu */

/** Teinte (degrés) d'une couleur [r, g, b] ou {r, g, b}. */
function teinte(c) {
  const [r, g, b] = Array.isArray(c) ? c : [c.r, c.g, c.b];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const ecartTeinte = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test("palette : chaque groupe garde sa teinte partout (halo, dendrites, axone, influx, nom)", () => {
  for (const [g, hex] of Object.entries(GROUPES)) {
    const { r, g: v, b } = versRgb(hex);
    const p = palette([r, v, b]);
    const h0 = teinte([r, v, b]);
    for (const k of ["soma", "halo", "anneau", "dendrite", "axone", "coeurAxone", "descendant", "montant", "nom"]) {
      assert.ok(Array.isArray(p[k]) && p[k].length === 3 && p[k].every((x) => Number.isFinite(x) && x >= 0 && x <= 255), `${g}.${k}`);
      if (g !== "reseau") assert.ok(ecartTeinte(teinte(p[k]), h0) <= 6, `${g}.${k} : teinte ${teinte(p[k]).toFixed(0)} au lieu de ${h0.toFixed(0)}`);
    }
  }
});

test("palette : le soma et le nom sont clairs, la voie descendante plus pâle que la montante", () => {
  for (const hex of Object.values(GROUPES)) {
    const { r, g, b } = versRgb(hex);
    const p = palette([r, g, b]);
    assert.ok(lum(p.soma) > lum(p.halo));
    assert.ok(lum(p.nom) > lum(p.halo));
    assert.ok(lum(p.descendant) > lum(p.montant));
  }
});

test("palette : un enfant (plus clair) reste de la même teinte que son parent", () => {
  const parent = couleurNoeud({ groupe: "pve" }, 0), enfant = couleurNoeud({ groupe: "pve" }, 1);
  const pp = palette([parent.r, parent.g, parent.b]), pe = palette([enfant.r, enfant.g, enfant.b]);
  assert.ok(ecartTeinte(teinte(pp.halo), teinte(pe.halo)) <= 6);
  assert.ok(lum(pe.halo) > lum(pp.halo));
});
