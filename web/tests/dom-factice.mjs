// DOM minimal pour tester sous Node les composants qui construisent leur interface (Liste, Frise) :
// createElement / createTextNode, enfants, textContent, dataset, attributs, classList, style, écouteurs.
// Pas un fichier de test (pas de suffixe .test.mjs) : importé par liste.test.mjs et frise.test.mjs.

class ListeClasses {
  constructor(el) { this._el = el; }
  _lire() { return new Set(String(this._el.className || "").split(/\s+/).filter(Boolean)); }
  _ecrire(s) { this._el.className = [...s].join(" "); }
  contains(c) { return this._lire().has(c); }
  add(...cs) { const s = this._lire(); for (const c of cs) s.add(c); this._ecrire(s); }
  remove(...cs) { const s = this._lire(); for (const c of cs) s.delete(c); this._ecrire(s); }
  toggle(c, force) {
    const s = this._lire();
    const oui = force === undefined ? !s.has(c) : Boolean(force);
    if (oui) s.add(c); else s.delete(c);
    this._ecrire(s);
    return oui;
  }
}

class Texte {
  constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentNode = null; }
}

const CONTEXTE_2D = new Proxy({}, {
  get(cible, nom) {
    if (nom in cible) return cible[nom];
    if (nom === "createLinearGradient" || nom === "createRadialGradient") return () => ({ addColorStop() {} });
    if (nom === "measureText") return () => ({ width: 10 });
    return () => {};
  },
  set(cible, nom, v) { cible[nom] = v; return true; },
});

export class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.dataset = {};
    this._attributs = new Map();
    this._ecouteurs = new Map();
    const proprietes = new Map();
    this.style = {
      setProperty: (k, v) => proprietes.set(k, String(v)),
      getPropertyValue: (k) => proprietes.get(k) || "",
      removeProperty: (k) => proprietes.delete(k),
    };
    this.classList = new ListeClasses(this);
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(t) {
    this._detacher();
    const s = t === null || t === undefined ? "" : String(t);
    if (s) this._attacher(new Texte(s));
  }

  _detacher() { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; }
  _attacher(n) {
    const noeud = typeof n === "string" ? new Texte(n) : n;
    if (noeud.parentNode) noeud.parentNode.childNodes = noeud.parentNode.childNodes.filter((x) => x !== noeud);
    noeud.parentNode = this;
    this.childNodes.push(noeud);
  }
  append(...ns) { for (const n of ns) this._attacher(n); }
  appendChild(n) { this._attacher(n); return n; }
  replaceChildren(...ns) { this._detacher(); this.append(...ns); }

  setAttribute(k, v) { this._attributs.set(k, String(v)); }
  getAttribute(k) { return this._attributs.has(k) ? this._attributs.get(k) : null; }
  removeAttribute(k) { this._attributs.delete(k); }
  hasAttribute(k) { return this._attributs.has(k); }

  addEventListener(type, f) {
    if (!this._ecouteurs.has(type)) this._ecouteurs.set(type, []);
    this._ecouteurs.get(type).push(f);
  }
  removeEventListener(type, f) {
    const l = this._ecouteurs.get(type);
    if (l) this._ecouteurs.set(type, l.filter((x) => x !== f));
  }
  dispatchEvent(e) {
    for (const f of this._ecouteurs.get(e.type) || []) f(e);
    return true;
  }

  /** Descendants (éléments) dans l'ordre du document. */
  *descendants() {
    for (const n of this.children) { yield n; yield* n.descendants(); }
  }
  /** Sélecteur limité à `.classe` ou `balise`. */
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const ok = sel.startsWith(".")
      ? (n) => n.classList.contains(sel.slice(1))
      : (n) => n.tagName === sel.toUpperCase();
    return [...this.descendants()].filter(ok);
  }

  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 64, right: 1200, bottom: 64 }; }
  getContext() { return CONTEXTE_2D; }
  focus() {}
  blur() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  get offsetWidth() { return 0; }
  get offsetLeft() { return 0; }
}

/**
 * Installe `document`, `window` et `requestAnimationFrame` (sans boucle) le temps d'un test,
 * puis remet les globales d'origine.
 */
export function installerDom(t) {
  const noms = ["document", "window", "requestAnimationFrame"];
  const avant = Object.fromEntries(noms.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (s) => new Texte(s),
  };
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    open() { return null; },
  };
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    for (const n of noms) {
      if (avant[n]) Object.defineProperty(globalThis, n, avant[n]);
      else delete globalThis[n];
    }
  });
}
