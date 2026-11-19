import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Graphe } from "../js/graphe.js";
import { urlValide, nomValide, raisonNom, raisonUrl, actionsDuNoeud, envoyerModif, ModeModifier, NOM_MAX } from "../js/modifier.js";
import { Element, installerDom } from "./dom-factice.mjs";

const charger = () => JSON.parse(readFileSync(new URL("./instantane-demo.json", import.meta.url), "utf8"));

function grapheDemo(modifier = null) {
  const inst = charger();
  if (modifier) modifier(inst);
  const g = new Graphe();
  g.appliquer(inst);
  return g;
}

/* ------------------------------------------------------------------ validation (même règle que le serveur) */

test("urlValide : cas du plan", () => {
  assert.equal(urlValide("javascript:alert(1)"), false);
  assert.equal(urlValide("https://site-d.exemple.fr"), true);
});

test("urlValide : même règle que reglages.URL_RE", () => {
  assert.equal(urlValide("http://192.168.10.198"), true);
  assert.equal(urlValide("https://nas.lan:5001/webman/index.cgi?a=1#x"), true);
  assert.equal(urlValide("HTTPS://site-d.exemple.fr"), false, "le serveur est sensible à la casse du schéma");
  assert.equal(urlValide("https://"), false);
  assert.equal(urlValide("ftp://exemple.fr"), false);
  assert.equal(urlValide(" https://exemple.fr"), false);
  assert.equal(urlValide("https://exemple.fr/a b"), false);
  assert.equal(urlValide("https://exemple.fr/\"onmouseover=x"), false);
  assert.equal(urlValide("https://exemple.fr/'"), false);
  assert.equal(urlValide("https://exemple.fr/`"), false);
  assert.equal(urlValide("https://exemple.fr/<script>"), false);
  assert.equal(urlValide("https://exemple.fr\n"), false);
  assert.equal(urlValide("https://a b"), false, "espace insécable = \\s en Python");
  assert.equal(urlValide("https://a\u001cb"), false, "\\x1c est un espace pour Python");
  assert.equal(urlValide("https://a\u0085b"), false);
  assert.equal(urlValide("https://a﻿b"), true, "U+FEFF n'est pas un espace pour Python");
  assert.equal(urlValide("https://" + "a".repeat(200)), true);
  assert.equal(urlValide("https://" + "a".repeat(201)), false);
  assert.equal(urlValide("https://" + "\u{1F600}".repeat(200)), true, "longueur comptée en caractères, comme Python");
  assert.equal(urlValide(null), false);
  assert.equal(urlValide(42), false);
  assert.equal(raisonUrl("https://site-d.exemple.fr"), null);
  assert.match(raisonUrl("javascript:alert(1)"), /http:\/\/ ou https:\/\//);
});

test("nomValide : cas du plan", () => {
  assert.equal(nomValide("<b>"), false);
  assert.equal(nomValide("x".repeat(41)), false);
});

test("nomValide : même règle que reglages._valider_nom", () => {
  assert.equal(NOM_MAX, 40);
  assert.equal(nomValide("supervision"), true);
  assert.equal(nomValide("Rénovation · Éric"), true);
  assert.equal(nomValide("x".repeat(40)), true);
  assert.equal(nomValide("  " + "x".repeat(40) + "  "), true, "espaces autour retirés avant de compter");
  assert.equal(nomValide("é".repeat(40)), true);
  assert.equal(nomValide("\u{1F600}".repeat(40)), true, "40 caractères, pas 40 unités UTF-16");
  assert.equal(nomValide("\u{1F600}".repeat(41)), false);
  assert.equal(nomValide(""), false);
  assert.equal(nomValide("   "), false);
  assert.equal(nomValide("　 "), false);
  assert.equal(nomValide("a>b"), false);
  assert.equal(nomValide("a\u0007b"), false);
  assert.equal(nomValide("a\u007fb"), false);
  assert.equal(nomValide(null), false);
  assert.equal(nomValide(12), false);
  assert.equal(raisonNom("ok"), null);
  assert.equal(raisonNom("  "), "Le nom ne peut pas être vide.");
  assert.equal(raisonNom("x".repeat(41)), "Le nom ne doit pas dépasser 40 caractères.");
  assert.equal(raisonNom("<b>"), "Le nom ne doit contenir ni « < » ni « > ».");
});

/* ------------------------------------------------------------------ actions proposées */

test("actionsDuNoeud : CT, site, appareil", () => {
  const g = grapheDemo();
  const vide = { noms: {}, caches: [], eteints_expres: [], liens: [] };
  const ct = actionsDuNoeud(g.noeuds.get("ct-102"), vide).map((a) => a.action);
  assert.deepEqual(ct, ["renommer", "cacher", "eteint_expres", "ajouter_lien"]);
  const site = actionsDuNoeud(g.noeuds.get("site-exemple.fr"), vide).map((a) => a.action);
  assert.ok(site.includes("modifier_lien") && site.includes("retirer_lien"));
  assert.ok(!site.includes("eteint_expres") && !site.includes("ajouter_lien"));
  const app = actionsDuNoeud(g.noeuds.get("app-c025e9720242"), vide).map((a) => a.action);
  assert.ok(!app.includes("eteint_expres"));

  const regl = { noms: { "ct-102": "Supervision" }, caches: [], eteints_expres: ["ct-102"], liens: [] };
  const a = actionsDuNoeud(g.noeuds.get("ct-102"), regl);
  const ee = a.find((x) => x.action === "eteint_expres");
  assert.equal(ee.valeur, false, "déjà éteint exprès : l'action le retire");
  assert.match(ee.libelle, /Retirer/);
  assert.ok(a.some((x) => x.action === "renommer" && x.retablir), "nom personnalisé : on peut rétablir l'original");
});

/* ------------------------------------------------------------------ envoi au serveur */

function fauxFetch(reponses) {
  const appels = [];
  const f = async (url, opts = {}) => {
    appels.push({ url, opts, corps: opts.body ? JSON.parse(opts.body) : null });
    const r = typeof reponses === "function" ? reponses(url, opts) : reponses;
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.json === undefined) throw new SyntaxError("pas du JSON");
        return r.json;
      },
    };
  };
  f.appels = appels;
  return f;
}

test("envoyerModif : POST JSON et message d'erreur du serveur tel quel", async () => {
  const regl = { noms: { "ct-102": "Supervision" }, caches: [], eteints_expres: [], liens: [] };
  const ok = fauxFetch({ status: 200, json: regl });
  const r = await envoyerModif({ action: "renommer", id: "ct-102", nom: "Supervision" }, ok);
  assert.deepEqual(r, { ok: true, reglages: regl });
  assert.equal(ok.appels[0].url, "/api/reglages");
  assert.equal(ok.appels[0].opts.method, "POST");
  assert.equal(ok.appels[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(ok.appels[0].corps, { action: "renommer", id: "ct-102", nom: "Supervision" });

  const message = "Adresse refusée : elle doit commencer par http:// ou https://, sans espace.";
  const refus = fauxFetch({ status: 400, json: { erreur: message } });
  assert.deepEqual(await envoyerModif({ action: "ajouter_lien" }, refus), { ok: false, erreur: message });

  const panne = fauxFetch(new TypeError("Failed to fetch"));
  const r2 = await envoyerModif({ action: "cacher", id: "ct-102" }, panne);
  assert.equal(r2.ok, false);
  assert.match(r2.erreur, /serveur/);

  const pasJson = fauxFetch({ status: 502 });
  const r3 = await envoyerModif({ action: "cacher", id: "ct-102" }, pasJson);
  assert.equal(r3.ok, false);
  assert.match(r3.erreur, /502/);
});

/* ------------------------------------------------------------------ ModeModifier dans un DOM factice */

const evt = (type, extra = {}) => ({ type, preventDefault() {}, stopPropagation() {}, ...extra });

function monter(t, { reglages = { noms: {}, caches: [], eteints_expres: ["switch-1"], liens: [] }, post = null, graphe = grapheDemo() } = {}) {
  installerDom(t);
  const racine = new Element("div");
  const corps = new Element("body");
  const bouton = new Element("button");
  const interactions = { interception: null };
  const rendu = { ecran: () => ({ sx: 300, sy: 200, r: 8 }) };
  const requete = fauxFetch((url, opts) => {
    if (!opts.method || opts.method === "GET") return { status: 200, json: reglages };
    return post ? post(JSON.parse(opts.body)) : { status: 200, json: reglages };
  });
  const annonces = [];
  const mm = new ModeModifier({ bouton, interactions, graphe, rendu, racine, corps, requete, annoncer: (s) => annonces.push(s) });
  return { mm, racine, corps, bouton, interactions, requete, graphe, annonces };
}

const boutonAction = (racine, action) =>
  racine.querySelectorAll("button").find((b) => b.dataset.action === action && !b.hidden) || null;
const posts = (requete) => requete.appels.filter((a) => a.opts.method === "POST").map((a) => a.corps);
const menu = (racine) => racine.querySelector(".menu-modifier");

function aucunInnerHTML(racine) {
  for (const el of [racine, ...racine.descendants()]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(el, "innerHTML"), `innerHTML utilisé sur <${el.tagName}>`);
    assert.ok(!Object.prototype.hasOwnProperty.call(el, "outerHTML"), `outerHTML utilisé sur <${el.tagName}>`);
  }
}

test("ModeModifier : activer / desactiver", async (t) => {
  const { mm, corps, bouton, interactions, requete, racine } = monter(t);
  assert.equal(mm.actif, false);
  await mm.activer();
  assert.equal(mm.actif, true);
  assert.ok(corps.classList.contains("mode-modifier"));
  assert.equal(bouton.getAttribute("aria-pressed"), "true");
  assert.equal(typeof interactions.interception, "function");
  assert.ok(requete.appels.some((a) => a.url === "/api/reglages" && (!a.opts.method || a.opts.method === "GET")));
  assert.equal(racine.querySelector(".masques").hidden, false);

  mm.desactiver();
  assert.equal(mm.actif, false);
  assert.ok(!corps.classList.contains("mode-modifier"));
  assert.equal(bouton.getAttribute("aria-pressed"), "false");
  assert.equal(interactions.interception, null);
  assert.equal(racine.querySelector(".masques").hidden, true);
  assert.ok(!menu(racine) || menu(racine).hidden);
});

test("ModeModifier : le bouton bascule le mode", async (t) => {
  const { mm, bouton } = monter(t);
  bouton.dispatchEvent(evt("click"));
  await mm.pret;
  assert.equal(mm.actif, true);
  bouton.dispatchEvent(evt("click"));
  assert.equal(mm.actif, false);
});

test("ModeModifier : un clic sur un CT ouvre son menu (renommer, cacher, éteint exprès, + lien)", async (t) => {
  const { mm, interactions, racine, graphe } = monter(t);
  await mm.activer();
  assert.equal(interactions.interception("ct-102", evt("pointerup", { clientX: 100, clientY: 120 })), true);
  const m = menu(racine);
  assert.ok(m && !m.hidden);
  assert.equal(m.querySelector(".mm-titre").textContent, graphe.noeuds.get("ct-102").nom);
  for (const a of ["renommer", "cacher", "eteint_expres", "ajouter_lien"]) assert.ok(boutonAction(racine, a), a);
  assert.match(boutonAction(racine, "ajouter_lien").textContent, /\+ lien/);
  // clic dans le vide : le menu se ferme, le comportement normal reprend
  assert.equal(interactions.interception(null, evt("pointerup")), false);
  assert.equal(menu(racine).hidden, true);
});

test("ModeModifier : renommer en `<script>` est refusé sans appel au serveur", async (t) => {
  const { mm, interactions, racine, requete } = monter(t);
  await mm.activer();
  interactions.interception("ct-102", evt("pointerup"));
  boutonAction(racine, "renommer").dispatchEvent(evt("click"));
  const champ = racine.querySelector(".champ");
  champ.value = "<script>alert(1)</script>";
  await mm.soumettre();
  assert.equal(posts(requete).length, 0);
  assert.equal(racine.querySelector(".erreur").textContent, "Le nom ne doit contenir ni « < » ni « > ».");
  aucunInnerHTML(racine);
});

test("ModeModifier : renommer envoie la modif et ferme le menu", async (t) => {
  const apres = { noms: { "ct-102": "Supervision" }, caches: [], eteints_expres: [], liens: [] };
  const { mm, interactions, racine, requete, annonces } = monter(t, { post: () => ({ status: 200, json: apres }) });
  await mm.activer();
  interactions.interception("ct-102", evt("pointerup"));
  boutonAction(racine, "renommer").dispatchEvent(evt("click"));
  racine.querySelector(".champ").value = "  Supervision ";
  await mm.soumettre();
  assert.deepEqual(posts(requete), [{ action: "renommer", id: "ct-102", nom: "Supervision" }]);
  assert.equal(menu(racine).hidden, true);
  assert.deepEqual(mm.reglages, apres);
  assert.ok(annonces.length >= 1);
});

test("ModeModifier : le message d'erreur du serveur est affiché tel quel (textContent)", async (t) => {
  const message = "Le nom <b>ne doit pas</b> dépasser 40 caractères.";
  const { mm, interactions, racine } = monter(t, { post: () => ({ status: 400, json: { erreur: message } }) });
  await mm.activer();
  interactions.interception("ct-102", evt("pointerup"));
  boutonAction(racine, "renommer").dispatchEvent(evt("click"));
  racine.querySelector(".champ").value = "Supervision";
  await mm.soumettre();
  const err = racine.querySelector(".erreur");
  assert.equal(err.textContent, message);
  assert.equal(err.children.length, 0, "aucune balise interprétée");
  assert.equal(menu(racine).hidden, false, "le formulaire reste ouvert pour corriger");
  aucunInnerHTML(racine);
});

test("ModeModifier : « + lien » refuse `javascript:` localement, envoie une URL correcte", async (t) => {
  const { mm, interactions, racine, requete } = monter(t);
  await mm.activer();
  interactions.interception("ct-129", evt("pointerup"));
  boutonAction(racine, "ajouter_lien").dispatchEvent(evt("click"));
  const [nom, url] = racine.querySelectorAll(".champ");
  nom.value = "Site D";
  url.value = "javascript:alert(1)";
  await mm.soumettre();
  assert.equal(posts(requete).length, 0);
  assert.match(racine.querySelector(".erreur").textContent, /http:\/\/ ou https:\/\//);

  nom.value = "x".repeat(10_000);
  url.value = "https://site-d.exemple.fr";
  await mm.soumettre();
  assert.equal(posts(requete).length, 0, "10 000 caractères refusés avant l'envoi");

  nom.value = "Site D";
  await mm.soumettre();
  assert.deepEqual(posts(requete), [{ action: "ajouter_lien", nom: "Site D", url: "https://site-d.exemple.fr", parent: "ct-129" }]);
});

test("ModeModifier : modifier un site n'envoie que ce qui change", async (t) => {
  const { mm, interactions, racine, requete } = monter(t);
  await mm.activer();
  interactions.interception("site-site-d.exemple.fr", evt("pointerup"));
  boutonAction(racine, "modifier_lien").dispatchEvent(evt("click"));
  const [nom, url] = racine.querySelectorAll(".champ");
  assert.equal(nom.value, "site-d.exemple.fr");
  url.value = "https://site-d.exemple.fr/accueil";
  await mm.soumettre();
  assert.deepEqual(posts(requete), [{ action: "modifier_lien", id: "site-site-d.exemple.fr", url: "https://site-d.exemple.fr/accueil" }]);
});

test("ModeModifier : cacher, éteint exprès, puis remontrer depuis « Masqués »", async (t) => {
  let etat = { noms: {}, caches: [], eteints_expres: [], liens: [] };
  const { mm, interactions, racine, requete } = monter(t, {
    post: (m) => {
      if (m.action === "cacher") etat = { ...etat, caches: [...etat.caches, m.id] };
      if (m.action === "montrer") etat = { ...etat, caches: etat.caches.filter((x) => x !== m.id) };
      if (m.action === "eteint_expres") etat = { ...etat, eteints_expres: m.valeur ? [m.id] : [] };
      return { status: 200, json: etat };
    },
  });
  await mm.activer();
  interactions.interception("ct-105", evt("pointerup"));
  await mm.executer("eteint_expres");
  assert.deepEqual(posts(requete).at(-1), { action: "eteint_expres", id: "ct-105", valeur: true });

  interactions.interception("ct-105", evt("pointerup"));
  await mm.executer("cacher");
  assert.deepEqual(posts(requete).at(-1), { action: "cacher", id: "ct-105" });

  const lignes = racine.querySelectorAll(".masque-ligne");
  assert.equal(lignes.length, 1);
  assert.match(lignes[0].textContent, /OpenVPN/, "le nom connu avant de cacher est gardé");
  const montrer = lignes[0].querySelector("button");
  montrer.dispatchEvent(evt("click"));
  await mm.pret;
  assert.deepEqual(posts(requete).at(-1), { action: "montrer", id: "ct-105" });
  assert.equal(racine.querySelectorAll(".masque-ligne").length, 0);
  assert.match(racine.querySelector(".masques").textContent, /Aucun élément masqué/);
});

test("ModeModifier : un nom hostile n'est jamais interprété comme du HTML", async (t) => {
  const hostile = "<img src=x onerror=alert(1)>";
  const graphe = grapheDemo((inst) => { inst.noeuds.find((n) => n.id === "ct-102").nom = hostile; });
  const { mm, interactions, racine } = monter(t, {
    graphe,
    reglages: { noms: { "ct-999": hostile }, caches: ["ct-999"], eteints_expres: [], liens: [] },
  });
  await mm.activer();
  interactions.interception("ct-102", evt("pointerup"));
  assert.equal(menu(racine).querySelector(".mm-titre").textContent, hostile);
  boutonAction(racine, "renommer").dispatchEvent(evt("click"));
  assert.equal(racine.querySelector(".champ").value, hostile);
  assert.match(racine.querySelector(".masques").textContent, /<img src=x/);
  for (const el of racine.descendants()) assert.notEqual(el.tagName, "IMG");
  aucunInnerHTML(racine);
});
