// Données en direct : flux SSE `/api/flux` (instantanés + évènements), détection de la connexion perdue,
// et mise en forme des nombres en français (espaces insécables).
//
//   const flux = connecter({ surEtat, surEvenement, surConnexion });
//   …  flux.fermer();
//
// `surConnexion(false, depuisMs)` est appelé quand aucun `etat` n'est arrivé depuis plus de 5 s, puis chaque
// seconde tant que ça dure ; `surConnexion(true, 0)` au premier `etat` qui suit. Un flux muet (TCP à moitié
// ouvert quand PVE ou le MikroTik tombe : le navigateur ne voit aucune erreur) est rouvert toutes les 5 s.

export const SEUIL_PERTE_MS = 5000;
const PERIODE_MS = 1000;
const RELANCE_MS = 5000;
const RELANCE_FERME_MS = 2000;

const fini = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------------ connexion */

const HORLOGE = {
  maintenant: () => Date.now(),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (m) => clearInterval(m),
};

/**
 * Ouvre le flux SSE et surveille sa fraîcheur.
 * `EventSource`, `horloge` ({maintenant, setInterval, clearInterval}) et `url` sont injectables (tests).
 */
export function connecter({
  surEtat = () => {},
  surEvenement = () => {},
  surConnexion = () => {},
  url = "/api/flux",
  EventSource: ES = globalThis.EventSource,
  horloge = HORLOGE,
} = {}) {
  let es = null;
  let ferme = false;
  let dernier = horloge.maintenant();   // dernier `etat` reçu (ou ouverture)
  let tentative = dernier;              // dernière (ré)ouverture du flux
  let perdue = false;
  let fermeA = null;                    // le navigateur a abandonné le flux (readyState CLOSED)

  const lire = (e) => {
    try { return JSON.parse(e && e.data); } catch { return undefined; }
  };

  function ouvrir() {
    if (ferme || typeof ES !== "function") return;
    if (es) { try { es.close(); } catch { /* déjà fermé */ } }
    tentative = horloge.maintenant();
    fermeA = null;
    let source;
    try { source = new ES(url); } catch { es = null; fermeA = tentative; return; }
    es = source;
    source.addEventListener("etat", (e) => {
      if (ferme || source !== es) return;
      const inst = lire(e);
      if (!inst || typeof inst !== "object") return;
      dernier = horloge.maintenant();
      if (perdue) {
        perdue = false;
        surConnexion(true, 0);
      }
      surEtat(inst);
    });
    source.addEventListener("evenement", (e) => {
      if (ferme || source !== es) return;
      const evt = lire(e);
      if (evt && typeof evt === "object") surEvenement(evt);
    });
    source.addEventListener("error", () => {
      // EventSource se reconnecte seul (retry: 2000) sauf s'il passe à CLOSED (réponse non 200, mauvais type)
      if (!ferme && source === es && source.readyState === 2 && fermeA === null) fermeA = horloge.maintenant();
    });
  }

  function veiller() {
    if (ferme) return;
    const t = horloge.maintenant();
    const depuis = t - dernier;
    if (depuis > SEUIL_PERTE_MS) {
      perdue = true;
      surConnexion(false, depuis);
      if (t - tentative >= RELANCE_MS) ouvrir();
    }
    if (fermeA !== null && t - fermeA >= RELANCE_FERME_MS) ouvrir();
  }

  ouvrir();
  const minuterie = horloge.setInterval(veiller, PERIODE_MS);

  return {
    fermer() {
      if (ferme) return;
      ferme = true;
      horloge.clearInterval(minuterie);
      if (es) { try { es.close(); } catch { /* déjà fermé */ } }
      es = null;
    },
    /** Vrai pendant une perte de connexion. */
    get perdue() { return perdue; },
  };
}

/* ------------------------------------------------------------------ mise en forme */

const NB = " ";   // espace insécable : entre un nombre et son unité
const NNB = " ";  // fine insécable : avant « % »
const NF0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 3 chiffres significatifs environ : « 940 », « 12,4 », « 1,2 ». */
const nombre = (v) => (v >= 100 ? NF0 : NF1).format(v);
/** Stockage : « 16 », « 2,2 » (une décimale sous 10 seulement). */
const nombreCourt = (v) => (v >= 10 ? NF0 : NF1).format(v);

/** bits/s → « 12,4 Mbit/s ». */
export function debit(bps) {
  if (!fini(bps) || bps < 0) return "–";
  if (bps < 1e3) return NF0.format(bps) + NB + "bit/s";
  if (bps < 1e6) return nombre(bps / 1e3) + NB + "kbit/s";
  if (bps < 1e9) return nombre(bps / 1e6) + NB + "Mbit/s";
  return nombre(bps / 1e9) + NB + "Gbit/s";
}

const UNITES_OCTETS = [[1e12, "To"], [1e9, "Go"], [1e6, "Mo"], [1e3, "ko"]];

/** Octets → « 2,2 To » (base 10, comme les capacités de disques). */
export function octets(n) {
  if (!fini(n) || n < 0) return "–";
  for (const [u, nom] of UNITES_OCTETS) if (n >= u) return nombreCourt(n / u) + NB + nom;
  return NF0.format(n) + NB + "o";
}

/** Utilisé / total dans la même unité : « 2,2 / 16 To ». */
export function octetsSur(u, t) {
  if (!fini(u) || !fini(t) || t <= 0) return "–";
  const [div, nom] = UNITES_OCTETS.find(([d]) => t >= d) || [1, "o"];
  return `${nombreCourt(u / div)} / ${nombreCourt(t / div)}${NB}${nom}`;
}

/** Secondes → « 38 min », « 2 h 5 min », « 3 j 4 h », « 42 s ». */
export function duree(s) {
  if (!fini(s) || s < 0) return "–";
  if (s < 60) return NF0.format(Math.round(s)) + NB + "s";
  if (s < 3600) return NF0.format(Math.max(1, Math.round(s / 60))) + NB + "min";
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return `${h}${NB}h${m ? ` ${m}${NB}min` : ""}`;
  }
  const j = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return `${NF0.format(j)}${NB}j${h ? ` ${h}${NB}h` : ""}`;
}

/** Fraction 0-1 → « 14 % ». */
export function pourcent(x) {
  if (!fini(x)) return "–";
  return NF0.format(Math.round(x * 100)) + NNB + "%";
}

/** Millisecondes → « 0:42 », « 19:07 », « 1:02:03 ». */
export function chrono(ms) {
  const s = Math.max(0, Math.floor((fini(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = String(r).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const formater = Object.freeze({ debit, octets, octetsSur, duree, pourcent, chrono });

/* ------------------------------------------------------------------ résumé de la barre du haut */

/**
 * « 31 / 33 en ligne » : machines et invités censés tourner (ni sites, ni appareils perso, ni éléments
 * éteints exprès). `inconnu` compte dans le total mais pas en ligne.
 */
export function resumeEnLigne(noeuds) {
  let total = 0, enLigne = 0, pannes = 0;
  for (const n of noeuds) {
    if (!n || n.type === "site" || n.type === "appareil" || n.etat === "eteint") continue;
    total++;
    if (n.etat === "on") enLigne++;
    else if (n.etat === "off") pannes++;
  }
  return { total, enLigne, pannes };
}
