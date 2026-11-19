import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graphe } from "../js/graphe.js";
import { disposer, HAUTEURS, ANGLE_PRINCIPAL } from "../js/disposition.js";
import { YAW_DEFAUT } from "../js/camera.js";

const charger = () => JSON.parse(readFileSync(new URL("./instantane-demo.json", import.meta.url), "utf8"));

function graphePose(inst = charger(), sauvegarde = new Map()) {
  const g = new Graphe();
  g.appliquer(inst);
  disposer(g, sauvegarde);
  return g;
}

function positions(g) {
  return new Map([...g.noeuds].map(([id, n]) => [id, { x: n.x, y: n.y, z: n.z }]));
}

function distanceMin(g) {
  const l = [...g.noeuds.values()];
  let min = Infinity, paire = null;
  for (let i = 0; i < l.length; i++) {
    for (let j = i + 1; j < l.length; j++) {
      const d = Math.hypot(l[i].x - l[j].x, l[i].y - l[j].y);
      if (d < min) { min = d; paire = [l[i].id, l[j].id]; }
    }
  }
  return { min, paire };
}

test("la fixture respecte le contrat : ≥ 60 nœuds, 29 invités, sites et appareils", () => {
  const inst = charger();
  assert.ok(inst.noeuds.length >= 60);
  assert.equal(inst.noeuds.filter((n) => /^(ct|vm)-/.test(n.id)).length, 29);
  assert.ok(inst.noeuds.some((n) => n.id === "vm-220"));
  assert.ok(inst.noeuds.filter((n) => n.type === "site").length >= 10);
  assert.ok(inst.noeuds.filter((n) => n.type === "appareil" && n.id.startsWith("app-")).length >= 5);
  assert.equal(new Set(inst.noeuds.map((n) => n.id)).size, inst.noeuds.length);
});

test("aucune coordonnée NaN, z selon le niveau", () => {
  const g = graphePose();
  for (const n of g.noeuds.values()) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z), n.id);
    assert.equal(n.z, HAUTEURS[n.niveau], n.id);
  }
  assert.deepEqual(HAUTEURS, [120, 70, 35, 15]);
});

test("le MikroTik est en (0, 0)", () => {
  const n = graphePose().noeuds.get("mikrotik");
  assert.equal(n.x, 0);
  assert.equal(n.y, 0);
});

test("distance minimale entre deux nœuds ≥ 18", () => {
  const { min, paire } = distanceMin(graphePose());
  assert.ok(min >= 18, `${paire} à ${min.toFixed(2)}`);
});

test("déterministe : deux dispositions → mêmes positions", () => {
  assert.deepEqual(positions(graphePose()), positions(graphePose()));
});

test("disposer deux fois le même graphe ne bouge rien", () => {
  const g = graphePose();
  const avant = positions(g);
  disposer(g, new Map());
  assert.deepEqual(positions(g), avant);
});

test("les CT/VM entourent pve, les sites sont près de leur CT", () => {
  const g = graphePose();
  const pve = g.noeuds.get("pve"), mk = g.noeuds.get("mikrotik");
  const dPveMk = Math.hypot(pve.x - mk.x, pve.y - mk.y);
  for (const n of g.noeuds.values()) {
    if (/^(ct|vm)-/.test(n.id)) {
      const d = Math.hypot(n.x - pve.x, n.y - pve.y);
      assert.ok(d < Math.hypot(n.x - mk.x, n.y - mk.y) + dPveMk * 0.25, `${n.id} loin de pve`);
    }
    if (n.type === "site") {
      const p = g.noeuds.get(n.parent);
      assert.ok(Math.hypot(n.x - p.x, n.y - p.y) < 220, `${n.id} loin de ${p.id}`);
    }
  }
});

test("ajout d'un CT : il éclot près de pve, aucun autre nœud ne bouge de plus de 5", () => {
  const g = graphePose();
  const avant = positions(g);
  const inst = charger();
  inst.noeuds.push({ id: "ct-117", nom: "nouveau", type: "ct", groupe: "pve", parent: "pve", niveau: 2,
    etat: "on", ip: "192.168.10.13", url: null, jauges: {}, details: { vmid: 117 } });
  inst.noeuds.push({ id: "site-nouveau.lan", nom: "nouveau.lan", type: "site", groupe: "pve", parent: "ct-117", niveau: 3,
    etat: "on", ip: null, url: "https://nouveau.lan", jauges: {}, details: {} });
  inst.liens.push({ id: "pve>ct-117", de: "pve", vers: "ct-117", type: "virtuel", etat: "on", descendant: null, montant: null });
  const r = g.appliquer(inst);
  assert.deepEqual(r.apparus.sort(), ["ct-117", "site-nouveau.lan"]);
  disposer(g, new Map());
  for (const [id, p] of avant) {
    const n = g.noeuds.get(id);
    assert.ok(Math.hypot(n.x - p.x, n.y - p.y) <= 5, `${id} a bougé`);
  }
  const ct = g.noeuds.get("ct-117"), pve = g.noeuds.get("pve"), site = g.noeuds.get("site-nouveau.lan");
  for (const n of [ct, site]) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z));
  assert.ok(Math.hypot(ct.x - pve.x, ct.y - pve.y) < 600);
  assert.ok(Math.hypot(site.x - ct.x, site.y - ct.y) < 220);
  assert.ok(distanceMin(g).min >= 18);
});

test("un nœud dont le parent est absent (caché) est quand même posé", () => {
  const inst = charger();
  inst.noeuds = inst.noeuds.filter((n) => n.id !== "ct-124");
  const g = graphePose(inst);
  const s = g.noeuds.get("site-site-a.exemple.fr");
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
  assert.ok(distanceMin(g).min >= 18);
});

test("la sauvegarde du navigateur impose la position des nœuds déplacés", () => {
  const sauvegarde = new Map([["pbs", { x: -900, y: 640 }], ["absent", { x: 1, y: 1 }], ["pc", { x: NaN, y: 3 }]]);
  const g = graphePose(charger(), sauvegarde);
  assert.equal(g.noeuds.get("pbs").x, -900);
  assert.equal(g.noeuds.get("pbs").y, 640);
  assert.ok(Number.isFinite(g.noeuds.get("pc").x));
});

test("graphe vide ou sans MikroTik : pas d'erreur", () => {
  const g = new Graphe();
  disposer(g, new Map());
  g.appliquer({ t: 0, version: 1, sources: {}, liens: [], noeuds: [
    { id: "ct-1", parent: "pve", niveau: 2, etat: "on", groupe: "pve", type: "ct" },
    { id: "ct-2", parent: "pve", niveau: 2, etat: "on", groupe: "pve", type: "ct" },
  ] });
  disposer(g);
  for (const n of g.noeuds.values()) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
});

/* ------------------------------------------------------------------ lisibilité */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDe = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
/** Écart entre deux angles, ramené à [0, π]. */
const ecartAngle = (a, b) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
};
const invitesDe = (g, parent) => [...g.noeuds.values()]
  .filter((n) => n.parent === parent && /^(ct|vm)-\d+$/.test(n.id))
  .sort((a, b) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]));

test("pve (le plus gros groupe) à droite dans la vue par défaut, la box à l'opposé", () => {
  assert.equal(ANGLE_PRINCIPAL, YAW_DEFAUT);
  const g = graphePose();
  const mk = g.noeuds.get("mikrotik"), pve = g.noeuds.get("pve"), box = g.noeuds.get("box");
  const aPve = angleDe(mk, pve);
  assert.ok(ecartAngle(aPve, ANGLE_PRINCIPAL) < 0.3, `pve à ${aPve.toFixed(2)} rad`);
  assert.ok(ecartAngle(angleDe(mk, box), aPve) > 2.3, "la box n'est pas à l'opposé de pve");
});

test("Internet prolonge l'axe MikroTik → box (milieu de l'éventail de la box)", () => {
  const g = graphePose();
  const mk = g.noeuds.get("mikrotik"), box = g.noeuds.get("box"), inet = g.noeuds.get("internet");
  assert.ok(ecartAngle(angleDe(box, inet), angleDe(mk, box)) < 0.35);
});

test("anneau de pve : une brèche face au MikroTik, l'onduleur dans la brèche, à l'intérieur", () => {
  const g = graphePose();
  const pve = g.noeuds.get("pve"), mk = g.noeuds.get("mikrotik"), ups = g.noeuds.get("onduleur");
  const versMk = angleDe(pve, mk);
  const invites = invitesDe(g, "pve");
  assert.equal(invites.length, 29);
  for (const n of invites) assert.ok(ecartAngle(angleDe(pve, n), versMk) > 0.3, `${n.id} dans la brèche`);
  assert.ok(ecartAngle(angleDe(pve, ups), versMk) < 0.75, "onduleur hors de la brèche");
  assert.ok(dist(ups, pve) < Math.min(...invites.map((n) => dist(n, pve))), "onduleur au-delà de l'anneau");
});

test("deux anneaux décalés : deux invités voisins (par vmid) ne sont pas sur le même rayon", () => {
  const g = graphePose();
  const pve = g.noeuds.get("pve");
  const r = invitesDe(g, "pve").map((n) => dist(n, pve));
  const ecarts = r.slice(1).map((v, i) => Math.abs(v - r[i])).sort((a, b) => a - b);
  assert.ok(ecarts[ecarts.length >> 1] >= 35, `écart médian ${ecarts[ecarts.length >> 1].toFixed(1)}`);
});

test("groupes bien séparés : au moins 60 entre deux groupes du premier niveau", () => {
  const g = graphePose();
  // groupe d'un nœud = groupe de son ancêtre placé directement sous le MikroTik
  const groupeDe = (n) => {
    let c = n;
    const vus = new Set();
    while (c.parent && c.parent !== "mikrotik" && g.noeuds.has(c.parent) && !vus.has(c.id)) { vus.add(c.id); c = g.noeuds.get(c.parent); }
    return c.groupe;
  };
  const parGroupe = new Map();
  for (const n of g.noeuds.values()) {
    if (n.id === "mikrotik") continue;
    const k = groupeDe(n);
    if (!parGroupe.has(k)) parGroupe.set(k, []);
    parGroupe.get(k).push(n);
  }
  assert.ok(parGroupe.size >= 5);
  const cles = [...parGroupe.keys()];
  for (let i = 0; i < cles.length; i++) {
    for (let j = i + 1; j < cles.length; j++) {
      let min = Infinity;
      for (const a of parGroupe.get(cles[i])) for (const b of parGroupe.get(cles[j])) min = Math.min(min, dist(a, b));
      assert.ok(min >= 60, `${cles[i]} / ${cles[j]} à ${min.toFixed(1)}`);
    }
  }
});

test("les sites d'un CT de l'anneau intérieur passent au-delà de l'anneau extérieur", () => {
  const g = graphePose();
  const pve = g.noeuds.get("pve");
  const invites = invitesDe(g, "pve");
  const rMax = Math.max(...invites.map((n) => dist(n, pve)));
  for (const n of g.noeuds.values()) {
    if (n.type !== "site") continue;
    const p = g.noeuds.get(n.parent);
    if (!p || p.parent !== "pve" || !/^(ct|vm)-/.test(p.id)) continue;
    assert.ok(dist(n, pve) > rMax - 8, `${n.id} coincé dans l'anneau (${dist(n, pve).toFixed(0)} < ${rMax.toFixed(0)})`);
  }
});
