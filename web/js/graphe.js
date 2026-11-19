// Graphe vivant : garde les nœuds et liens d'un instantané à l'autre (mêmes objets, positions conservées)
// et dit ce qui est apparu, a disparu ou a changé d'état.

const RACINE = "mikrotik";
const vide = () => ({ apparus: [], disparus: [], changes: [] });

/** Recopie les champs de données de `src` sur `cible` et retire ceux qui ont disparu depuis le dernier instantané. */
function recopier(cible, src, clesAvant) {
  const cles = Object.keys(src);
  if (clesAvant) {
    for (const c of clesAvant) if (!Object.hasOwn(src, c)) delete cible[c];
  }
  for (const c of cles) cible[c] = src[c];
  return cles;
}

export class Graphe {
  constructor() {
    /** @type {Map<string, object>} id → nœud (le même objet d'un instantané à l'autre) */
    this.noeuds = new Map();
    /** @type {Map<string, object>} id → lien */
    this.liens = new Map();
    this.t = null;
    this.sources = {};
    this._clesNoeuds = new Map();
    this._clesLiens = new Map();
    this._enfants = new Map();
  }

  /** Applique un instantané (contrat central) ; renvoie {apparus, disparus, changes: [{id, avant, apres}]}. */
  appliquer(inst) {
    if (!inst || typeof inst !== "object" || !Array.isArray(inst.noeuds)) return vide();
    const r = vide();
    const vus = new Set();

    for (const src of inst.noeuds) {
      if (!src || typeof src !== "object" || typeof src.id !== "string" || !src.id || vus.has(src.id)) continue;
      vus.add(src.id);
      const n = this.noeuds.get(src.id);
      if (n) {
        const avant = n.etat;
        this._clesNoeuds.set(src.id, recopier(n, src, this._clesNoeuds.get(src.id)));
        if (avant !== n.etat) r.changes.push({ id: src.id, avant, apres: n.etat });
      } else {
        const neuf = {};
        this._clesNoeuds.set(src.id, recopier(neuf, src, null));
        this.noeuds.set(src.id, neuf);
        r.apparus.push(src.id);
      }
    }
    for (const id of [...this.noeuds.keys()]) {
      if (!vus.has(id)) {
        this.noeuds.delete(id);
        this._clesNoeuds.delete(id);
        r.disparus.push(id);
      }
    }

    const liensVus = new Set();
    for (const src of Array.isArray(inst.liens) ? inst.liens : []) {
      if (!src || typeof src !== "object" || typeof src.de !== "string" || typeof src.vers !== "string") continue;
      const id = typeof src.id === "string" && src.id ? src.id : `${src.de}>${src.vers}`;
      if (liensVus.has(id) || !this.noeuds.has(src.de) || !this.noeuds.has(src.vers)) continue;
      liensVus.add(id);
      const l = this.liens.get(id);
      if (l) {
        this._clesLiens.set(id, recopier(l, src, this._clesLiens.get(id)));
      } else {
        const neuf = {};
        this._clesLiens.set(id, recopier(neuf, src, null));
        neuf.id = id;
        this.liens.set(id, neuf);
      }
    }
    for (const id of [...this.liens.keys()]) {
      if (!liensVus.has(id)) {
        this.liens.delete(id);
        this._clesLiens.delete(id);
      }
    }

    this.t = Number.isFinite(inst.t) ? inst.t : this.t;
    this.sources = inst.sources && typeof inst.sources === "object" ? inst.sources : {};
    this._indexer();
    return r;
  }

  _indexer() {
    this._enfants = new Map();
    for (const n of this.noeuds.values()) {
      if (typeof n.parent !== "string" || n.parent === n.id) continue;
      let l = this._enfants.get(n.parent);
      if (!l) this._enfants.set(n.parent, (l = []));
      l.push(n.id);
    }
  }

  /** Ids des enfants directs (dans l'ordre de l'instantané). */
  enfants(id) {
    const l = this._enfants.get(id);
    return l ? l.slice() : [];
  }

  /** id → parent → … → mikrotik ; s'arrête sur un parent absent (caché) ou une boucle. */
  chaine(id) {
    const ch = [];
    const vus = new Set();
    let n = this.noeuds.get(id);
    while (n && !vus.has(n.id)) {
      vus.add(n.id);
      ch.push(n.id);
      if (n.id === RACINE || typeof n.parent !== "string") break;
      n = this.noeuds.get(n.parent);
    }
    return ch;
  }

  /** Nombre d'ancêtres consécutifs du même groupe (0 = racine du groupe), pour éclaircir la teinte. */
  profondeurGroupe(id) {
    const n = this.noeuds.get(id);
    if (!n) return 0;
    let p = 0;
    const vus = new Set([n.id]);
    let a = this.noeuds.get(n.parent);
    while (a && a.groupe === n.groupe && !vus.has(a.id)) {
      vus.add(a.id);
      p++;
      a = this.noeuds.get(a.parent);
    }
    return p;
  }
}
