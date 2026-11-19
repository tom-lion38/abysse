import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graphe } from "../js/graphe.js";
import { normaliser, filtrer, entreesDepuis, grouper, decouper, Liste, ETATS_TEXTE } from "../js/liste.js";
import { Element, installerDom } from "./dom-factice.mjs";

const charger = () => JSON.parse(readFileSync(new URL("./instantane-demo.json", import.meta.url), "utf8"));

function grapheDemo(modifier = null) {
  const inst = charger();
  if (modifier) modifier(inst);
  const g = new Graphe();
  g.appliquer(inst);
  return g;
}

test("normaliser : minuscules, sans accents", () => {
  assert.equal(normaliser("Rénovation"), "renovation");
  assert.equal(normaliser("ÉTEINT Exprès"), "eteint expres");
  assert.equal(normaliser(""), "");
  assert.equal(normaliser(null), "");
});

test("filtrer : « renovation » trouve « rénovation » (et l'inverse)", () => {
  const entrees = [
    { id: "a", nom: "Site rénovation", url: "https://exemple.fr", ip: null, etat: "on", machine: "pve" },
    { id: "b", nom: "site-a", url: null, ip: "192.168.10.106", etat: "on", machine: "pve" },
  ];
  assert.deepEqual(filtrer(entrees, "renovation").map((e) => e.id), ["a"]);
  assert.deepEqual(filtrer(entrees, "RÉNOV").map((e) => e.id), ["a"]);
  const g = grapheDemo((inst) => { inst.noeuds.find((n) => n.id === "ct-128").nom = "rénovation"; });
  const ids = filtrer(entreesDepuis(g), "renovation").map((e) => e.id);
  assert.ok(ids.includes("ct-128"), ids.join(","));
  // accent dans la requête, pas dans la donnée
  const g2 = grapheDemo((inst) => { inst.noeuds.find((n) => n.id === "ct-128").nom = "renovation"; });
  assert.ok(filtrer(entreesDepuis(g2), "rénovation").some((e) => e.id === "ct-128"));
});

test("filtrer : « 192.168.10.106 » trouve site-a, par l'IP", () => {
  const r = filtrer(entreesDepuis(grapheDemo()), "192.168.10.106");
  const ids = r.map((e) => e.id);
  assert.ok(ids.includes("ct-124"));
  assert.equal(r.find((e) => e.id === "ct-124").nom, "site-a");
  assert.ok(!ids.includes("ct-123"));
  // les sites du CT héritent de son IP (amont) : ils sortent aussi
  assert.ok(ids.includes("site-site-a.exemple.fr"));
});

test("filtrer : cherche aussi dans l'URL ; plusieurs mots = tous présents ; requête vide = tout", () => {
  const e = entreesDepuis(grapheDemo());
  assert.deepEqual(filtrer(e, "site-d.exemple").map((x) => x.id), ["site-site-d.exemple.fr"]);
  assert.ok(filtrer(e, "site a").some((x) => x.id === "ct-124"));
  assert.deepEqual(filtrer(e, "zzzz-introuvable"), []);
  assert.equal(filtrer(e, "").length, e.length);
  assert.equal(filtrer(e, "   ").length, e.length);
  assert.equal(filtrer(e, null).length, e.length);
});

test("entreesDepuis : une entrée par nœud, avec {id, nom, url, ip, etat, machine}", () => {
  const g = grapheDemo();
  const e = entreesDepuis(g);
  assert.equal(e.length, g.noeuds.size);
  assert.equal(new Set(e.map((x) => x.id)).size, e.length);
  for (const x of e) {
    for (const k of ["id", "nom", "url", "ip", "etat", "machine"]) assert.ok(Object.hasOwn(x, k), `${x.id} sans ${k}`);
  }
  const ct = e.find((x) => x.id === "ct-124");
  assert.equal(ct.url, "https://pve.lan/#v1:0:=lxc%2F124:4:::::::");
  assert.equal(ct.ip, "192.168.10.106");
  assert.equal(e.find((x) => x.id === "vm-200").url !== null, true);
  assert.equal(e.find((x) => x.id === "site-site-a.exemple.fr").url, "https://site-a.exemple.fr");
  assert.equal(e.find((x) => x.id === "mikrotik").url, "http://192.168.10.198");
});

test("entreesDepuis : groupées par machine, MikroTik d'abord puis pve, PBS…", () => {
  const e = entreesDepuis(grapheDemo());
  // chaque machine forme un bloc contigu
  const vus = new Set();
  let prec = null;
  for (const x of e) {
    if (x.machineId !== prec) {
      assert.ok(!vus.has(x.machineId), `machine ${x.machineId} coupée en deux blocs`);
      vus.add(x.machineId);
      prec = x.machineId;
    }
  }
  const groupes = grouper(e);
  assert.deepEqual(groupes.slice(0, 3).map((gr) => gr.machineId), ["mikrotik", "pve", "pbs"]);
  assert.equal(groupes[1].machine, "pve");
  const machineDe = (id) => e.find((x) => x.id === id).machine;
  assert.equal(machineDe("ct-124"), "pve");
  assert.equal(machineDe("site-site-a.exemple.fr"), "pve");
  assert.equal(machineDe("onduleur"), "pve");
  assert.equal(machineDe("site-pbs.lan"), "PBS");
  assert.equal(machineDe("ha"), "box");
  assert.equal(machineDe("site-ha.exemple.fr"), "box");
  // appareils perso et PC fixe : directement sous le MikroTik, rangés avec lui
  assert.equal(machineDe("pc"), "Routeur MikroTik");
  assert.equal(machineDe("app-c025e9720242"), "Routeur MikroTik");
  // la machine ouvre son groupe
  for (const gr of groupes) assert.equal(gr.entrees[0].id, gr.machineId);
  // les sites suivent leur CT
  const i = e.findIndex((x) => x.id === "ct-124");
  assert.ok(e.slice(i + 1, i + 3).some((x) => x.id === "site-site-a.exemple.fr"));
  assert.equal(e.find((x) => x.id === "site-site-a.exemple.fr").profondeur, 2);
});

test("entreesDepuis : parent caché → rangé sous son plus haut ancêtre visible, sans planter", () => {
  const g = new Graphe();
  g.appliquer({ t: 0, version: 1, sources: {}, liens: [], noeuds: [
    { id: "mikrotik", nom: "Routeur MikroTik", type: "routeur", parent: null, niveau: 0, etat: "on", url: "javascript:alert(1)" },
    { id: "site-x", nom: "x.fr", type: "site", parent: "ct-cache", niveau: 3, etat: "on", url: "https://x.fr" },
  ] });
  const e = entreesDepuis(g);
  assert.equal(e.length, 2);
  assert.equal(e.find((x) => x.id === "site-x").machineId, "site-x");
  assert.equal(e.find((x) => x.id === "mikrotik").url, null, "URL dangereuse refusée");
  assert.deepEqual(entreesDepuis(null), []);
});

test("decouper : termes surlignés insensibles aux accents, texte d'origine conservé", () => {
  assert.deepEqual(decouper("Rénovation", "renov"), [{ texte: "Rénov", mark: true }, { texte: "ation", mark: false }]);
  assert.deepEqual(decouper("le-bistrot", "BISTROT le"), [
    { texte: "le", mark: true }, { texte: "-", mark: false }, { texte: "bistrot", mark: true },
  ]);
  assert.deepEqual(decouper("abc", ""), [{ texte: "abc", mark: false }]);
  assert.deepEqual(decouper("", "a"), []);
  assert.deepEqual(decouper("aaaa", "aa"), [{ texte: "aaaa", mark: true }]);
  assert.deepEqual(decouper("<script>", "script"), [
    { texte: "<", mark: false }, { texte: "script", mark: true }, { texte: ">", mark: false },
  ]);
  assert.equal(decouper("Éteint exprès", "eteint expres").map((s) => s.texte).join(""), "Éteint exprès");
});

/* ------------------------------------------------------------------ composant (DOM factice) */

function ligneDe(liste, id) {
  return [...liste.grille.descendants()].find((n) => n.classList.contains("vl-ligne") && n.dataset.id === id) || null;
}

test("Liste : un changement d'état seul met à jour data-etat et l'aria-label de la ligne", (t) => {
  installerDom(t);
  const inst = charger();
  const g = new Graphe();
  g.appliquer(inst);
  const liste = new Liste(new Element("section"));
  liste.afficher(g);

  const avant = ligneDe(liste, "ct-104");
  assert.ok(avant, "ligne ct-104 absente");
  assert.equal(avant.dataset.etat, "on");

  // ct-104 tombe : seul `etat` change, la liste prend le chemin rapide (pas de reconstruction)
  inst.noeuds.find((n) => n.id === "ct-104").etat = "off";
  g.appliquer(inst);
  liste.afficher(g);
  const ligne = ligneDe(liste, "ct-104");
  assert.equal(ligne, avant, "la ligne a été reconstruite : le chemin rapide n'est pas testé");
  const pastille = ligne.children[0];
  assert.equal(pastille.className, "pastille etat-off");
  assert.equal(ligne.dataset.etat, "off", "le nom resterait dans la couleur de l'ancien état");
  assert.equal(pastille.getAttribute("aria-label"), ETATS_TEXTE.off);

  // retour en ligne : le nom ne doit pas rester rouge
  inst.noeuds.find((n) => n.id === "ct-104").etat = "on";
  g.appliquer(inst);
  liste.afficher(g);
  assert.equal(ligneDe(liste, "ct-104"), avant);
  assert.equal(avant.dataset.etat, "on");
  assert.equal(pastille.className, "pastille etat-on");
  assert.equal(pastille.getAttribute("aria-label"), ETATS_TEXTE.on);
});
