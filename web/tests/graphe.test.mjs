import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graphe } from "../js/graphe.js";

const charger = () => JSON.parse(readFileSync(new URL("./instantane-demo.json", import.meta.url), "utf8"));

test("premier appliquer : tout est apparu, rien n'a changé", () => {
  const inst = charger();
  const g = new Graphe();
  const r = g.appliquer(inst);
  assert.equal(r.apparus.length, inst.noeuds.length);
  assert.deepEqual(r.disparus, []);
  assert.deepEqual(r.changes, []);
  assert.equal(g.noeuds.size, inst.noeuds.length);
  assert.equal(g.liens.size, inst.liens.length);
  assert.equal(g.noeuds.get("pve").nom, "pve");
});

test("appliquer détecte apparus, disparus et changements d'état", () => {
  const g = new Graphe();
  g.appliquer(charger());
  const inst = charger();
  inst.noeuds = inst.noeuds.filter((n) => n.id !== "app-c025e9720242");
  inst.liens = inst.liens.filter((l) => l.vers !== "app-c025e9720242");
  inst.noeuds.find((n) => n.id === "ct-102").etat = "off";
  inst.noeuds.push({ id: "ct-777", nom: "nouveau", type: "ct", groupe: "pve", parent: "pve", niveau: 2,
    etat: "on", ip: null, url: null, jauges: {}, details: { vmid: 777 } });
  inst.liens.push({ id: "pve>ct-777", de: "pve", vers: "ct-777", type: "virtuel", etat: "on", descendant: null, montant: null });
  const r = g.appliquer(inst);
  assert.deepEqual(r.apparus, ["ct-777"]);
  assert.deepEqual(r.disparus, ["app-c025e9720242"]);
  assert.deepEqual(r.changes, [{ id: "ct-102", avant: "on", apres: "off" }]);
  assert.ok(!g.noeuds.has("app-c025e9720242"));
  assert.ok(!g.liens.has("mikrotik>app-c025e9720242"));
  assert.ok(g.liens.has("pve>ct-777"));
});

test("appliquer met à jour sur place : les positions déjà calculées sont conservées", () => {
  const g = new Graphe();
  g.appliquer(charger());
  const n = g.noeuds.get("ct-124");
  n.x = 12; n.y = 34; n.z = 35;
  const inst = charger();
  inst.noeuds.find((m) => m.id === "ct-124").jauges.cpu = 0.5;
  g.appliquer(inst);
  assert.equal(g.noeuds.get("ct-124"), n);
  assert.equal(n.x, 12); assert.equal(n.y, 34); assert.equal(n.z, 35);
  assert.equal(n.jauges.cpu, 0.5);
});

test("un champ disparu de l'instantané ne reste pas collé au nœud", () => {
  const g = new Graphe();
  const inst = charger();
  g.appliquer(inst);
  const inst2 = charger();
  delete inst2.noeuds.find((m) => m.id === "pve").details;
  g.appliquer(inst2);
  assert.equal(g.noeuds.get("pve").details, undefined);
});

test("enfants et chaîne jusqu'au MikroTik", () => {
  const g = new Graphe();
  g.appliquer(charger());
  const enf = g.enfants("pve");
  assert.ok(enf.includes("ct-102") && enf.includes("vm-200") && enf.includes("onduleur"));
  assert.ok(!enf.includes("pve"));
  assert.deepEqual(g.enfants("site-exemple.fr"), []);
  assert.deepEqual(g.enfants("inconnu"), []);
  const ch = g.chaine("site-exemple.fr");
  assert.deepEqual(ch, ["site-exemple.fr", "ct-143", "pve", "mikrotik"]);
  assert.equal(ch.at(-1), "mikrotik");
  assert.deepEqual(g.chaine("mikrotik"), ["mikrotik"]);
  assert.deepEqual(g.chaine("absent"), []);
});

test("chaîne : parent manquant (caché) ou boucle → s'arrête sans planter", () => {
  const g = new Graphe();
  g.appliquer({ t: 0, version: 1, sources: {}, liens: [], noeuds: [
    { id: "mikrotik", parent: null, niveau: 0, etat: "on", groupe: "mikrotik" },
    { id: "a", parent: "b", niveau: 2, etat: "on", groupe: "pve" },
    { id: "b", parent: "a", niveau: 2, etat: "on", groupe: "pve" },
    { id: "c", parent: "cache", niveau: 3, etat: "on", groupe: "pve" },
  ] });
  assert.deepEqual(g.chaine("a"), ["a", "b"]);
  assert.deepEqual(g.chaine("c"), ["c"]);
});

test("profondeurGroupe : racine du groupe 0, CT 1, site 2", () => {
  const g = new Graphe();
  g.appliquer(charger());
  assert.equal(g.profondeurGroupe("pve"), 0);
  assert.equal(g.profondeurGroupe("ct-124"), 1);
  assert.equal(g.profondeurGroupe("site-site-a.exemple.fr"), 2);
  assert.equal(g.profondeurGroupe("vm-200"), 0);
  assert.equal(g.profondeurGroupe("site-medias.lan"), 1);
  assert.equal(g.profondeurGroupe("mikrotik"), 0);
});

test("instantané invalide : ignoré sans planter", () => {
  const g = new Graphe();
  assert.deepEqual(g.appliquer(null), { apparus: [], disparus: [], changes: [] });
  assert.deepEqual(g.appliquer({ noeuds: [null, { nom: "sans id" }] }), { apparus: [], disparus: [], changes: [] });
});
