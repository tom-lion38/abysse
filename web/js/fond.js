// Fond des abysses : noir presque total (#01040a), nébuleuse très sombre qui tourne lentement,
// poussière neuronale posée dans l'espace 3D (vraie parallaxe quand la caméra tourne), filaments
// fantômes entre les grains proches, neige marine lointaine et vignette.
// Tout est précalculé (sprites, paires de filaments) ; une image ne fait que projeter et poser.

export const FOND = "#01040a";

const TAU = Math.PI * 2;
const borne = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Générateur pseudo-aléatoire à graine (le fond est le même à chaque chargement). */
function mulberry(graine) {
  let s = graine | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function creerCanvas(l, h) {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = Math.max(1, l | 0);
  c.height = Math.max(1, h | 0);
  return c;
}

const PROJ = { sx: 0, sy: 0, s: 0, p: 0 };

export class Fond {
  constructor() {
    /** Mouvement réduit : rien ne dérive, rien ne scintille. */
    this.calme = false;
    this._pret = false;
    this._nebT = -1e9;
    this._nebCle = "";
  }

  _initialiser() {
    this._pret = true;
    // nébuleuse : nuages bleu nuit / violet profond, très peu lumineux
    this._nebuleuse = creerCanvas(512, 512);
    if (this._nebuleuse) {
      const g = this._nebuleuse.getContext("2d");
      const R = mulberry(7);
      const cols = [[12, 38, 118], [34, 12, 92], [0, 62, 98], [10, 24, 72], [48, 10, 70], [0, 40, 80]];
      for (let i = 0; i < 11; i++) {
        const x = 80 + R() * 352, y = 80 + R() * 352, r = 80 + R() * 200, c = cols[i % cols.length];
        const d = g.createRadialGradient(x, y, 0, x, y, r);
        d.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${(0.18 + R() * 0.15).toFixed(3)})`);
        d.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},0.06)`);
        d.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        g.fillStyle = d;
        g.fillRect(0, 0, 512, 512);
      }
    }
    this._nebCache = creerCanvas(2, 2);
    this._nebCtx = this._nebCache ? this._nebCache.getContext("2d", { alpha: false }) : null;
    // grain lumineux (tête de poussière)
    this._grain = creerCanvas(32, 32);
    if (this._grain) {
      const g = this._grain.getContext("2d");
      const d = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      d.addColorStop(0, "rgba(220,240,255,1)");
      d.addColorStop(0.25, "rgba(150,200,255,.45)");
      d.addColorStop(1, "rgba(120,170,255,0)");
      g.fillStyle = d;
      g.fillRect(0, 0, 32, 32);
    }
    // poussière neuronale en 3D autour du graphe
    const R = mulberry(99);
    const N = 340;
    this._px = new Float32Array(N); this._py = new Float32Array(N); this._pz = new Float32Array(N);
    this._ph = new Float32Array(N); this._tw = new Float32Array(N); this._ta = new Float32Array(N);
    this._sx = new Float32Array(N); this._sy = new Float32Array(N); this._sa = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // répartition en disque épais, plus dense vers le centre
      const a = R() * TAU, d = 250 + Math.pow(R(), 0.8) * 2100;
      this._px[i] = Math.cos(a) * d;
      this._py[i] = Math.sin(a) * d;
      this._pz[i] = -420 + R() * 1300;
      this._ph[i] = R() * TAU;
      this._tw[i] = 0.3 + R() * 1.3;
      this._ta[i] = Math.pow(R(), 1.6);
    }
    this._n = N;
    // filaments : paires de grains proches (calculées une fois)
    const paires = [];
    for (let i = 0; i < N && paires.length < 360; i++) {
      for (let j = i + 1; j < N && paires.length < 360; j++) {
        const dx = this._px[i] - this._px[j], dy = this._py[i] - this._py[j], dz = this._pz[i] - this._pz[j];
        if (dx * dx + dy * dy + dz * dz < 230 * 230) paires.push(i, j);
      }
    }
    this._paires = Uint16Array.from(paires);
    // neige marine lointaine (écran, parallaxe légère selon l'angle de vue)
    const M = 220;
    this._nx = new Float32Array(M); this._ny = new Float32Array(M); this._nz = new Float32Array(M); this._nv = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      this._nx[i] = R(); this._ny[i] = R(); this._nz[i] = [0.25, 0.55, 1][i % 3]; this._nv[i] = 0.004 + R() * 0.012;
    }
    this._m = M;
    this._vignette = null;
    this._vigCle = "";
  }

  _vignetteDe(l, h) {
    const cle = `${l | 0}x${h | 0}`;
    if (this._vigCle === cle) return this._vignette;
    this._vigCle = cle;
    const c = creerCanvas(Math.ceil(l / 4), Math.ceil(h / 4));
    if (c) {
      const g = c.getContext("2d"), W = c.width, H = c.height;
      const d = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.62);
      d.addColorStop(0, "rgba(0,0,0,0)");
      d.addColorStop(0.55, "rgba(0,1,4,.28)");
      d.addColorStop(1, "rgba(0,1,4,.78)");
      g.fillStyle = d;
      g.fillRect(0, 0, W, H);
    }
    this._vignette = c;
    return c;
  }

  /**
   * Dessine le fond sur `ctx` (coordonnées CSS, transformation déjà posée).
   * `temps` en secondes, `alerte` 0-1 (sur batterie : teinte ambre), `camera` : Camera de camera.js.
   */
  dessiner(ctx, largeur, hauteur, camera, dt, temps, alerte = 0) {
    if (!this._pret) this._initialiser();
    const W = largeur, H = hauteur, M = Math.max(W, H);
    const calme = this.calme;
    const T = calme ? 0 : temps;
    const yaw = camera ? camera.yaw : 0, pitch = camera ? camera.pitch : 1;

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // 1) nébuleuse, composée à mi-résolution dans un cache rafraîchi ~4 fois par seconde
    const px = borne(-(camera ? camera.tx * camera.k * 0.03 : 0) - yaw * M * 0.05, -M * 0.12, M * 0.12);
    const py = borne(-(camera ? camera.ty * camera.k * 0.03 : 0) + (pitch - 0.94) * M * 0.1, -M * 0.1, M * 0.1);
    const w2 = Math.max(1, Math.ceil(W / 2)), h2 = Math.max(1, Math.ceil(H / 2));
    const nc = this._nebCache, g2 = this._nebCtx;
    if (nc && g2 && this._nebuleuse) {
      const cle = `${w2}x${h2}:${Math.round(px)}:${Math.round(py)}:${Math.round(alerte * 40)}`;
      if (nc.width !== w2 || nc.height !== h2 || temps - this._nebT > 0.25 || temps < this._nebT || cle !== this._nebCle) {
        if (nc.width !== w2 || nc.height !== h2) { nc.width = w2; nc.height = h2; }
        this._nebT = temps; this._nebCle = cle;
        g2.setTransform(w2 / W, 0, 0, h2 / H, 0, 0);
        g2.globalCompositeOperation = "source-over"; g2.globalAlpha = 1;
        g2.fillStyle = FOND; g2.fillRect(0, 0, W, H);
        g2.globalCompositeOperation = "lighter";
        g2.save();
        g2.translate(W / 2 + px, H / 2 + py);
        g2.rotate(T * 0.004 + yaw * 0.35);
        const S = M * 1.75;
        g2.globalAlpha = 0.3 * (1 - alerte * 0.35);
        g2.drawImage(this._nebuleuse, -S / 2, -S / 2, S, S);
        g2.rotate(2.1 - T * 0.011 - yaw * 0.2);
        g2.globalAlpha = 0.15;
        g2.drawImage(this._nebuleuse, -S * 0.62, -S * 0.62, S * 1.24, S * 1.24);
        g2.restore();
        if (alerte > 0.01) {
          const d = g2.createRadialGradient(W / 2, H * 0.6, 0, W / 2, H / 2, M * 0.75);
          d.addColorStop(0, `rgba(255,120,20,${(0.05 * alerte).toFixed(4)})`);
          d.addColorStop(1, `rgba(255,100,10,${(0.11 * alerte).toFixed(4)})`);
          g2.globalAlpha = 1; g2.fillStyle = d; g2.fillRect(0, 0, W, H);
        }
      }
      // agrandissement ×2 d'une image qui change : lissage bilinéaire simple (pas de mipmaps à recalculer)
      const lissage = ctx.imageSmoothingQuality;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(nc, 0, 0, W, H);
      ctx.imageSmoothingQuality = lissage;
    } else {
      ctx.fillStyle = FOND;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.globalCompositeOperation = "lighter";
    // 2) neige marine lointaine
    const parX = -(yaw * 160) - (camera ? camera.tx * 0.04 : 0), parY = (pitch - 0.94) * 140 - (camera ? camera.ty * 0.03 : 0);
    const coul = alerte > 0.5 ? "255,200,140" : "170,220,255";
    for (let couche = 0; couche < 3; couche++) {
      const z = [0.25, 0.55, 1][couche];
      ctx.fillStyle = `rgba(${coul},${[0.16, 0.26, 0.4][couche]})`;
      for (let i = couche; i < this._m; i += 3) {
        if (!calme) {
          this._ny[i] += this._nv[i] * dt * z;
          if (this._ny[i] > 1.02) { this._ny[i] = -0.02; }
        }
        let x = (this._nx[i] * W + parX * z * 2) % W; if (x < 0) x += W;
        let y = (this._ny[i] * H + parY * z * 2) % H; if (y < 0) y += H;
        const tw = calme ? 1 : 0.55 + 0.45 * Math.sin(T * 1.3 + i * 1.7);
        const s = z * 1.4 * tw + 0.35;
        ctx.fillRect(x, y, s, s);
      }
    }

    // 3) poussière neuronale en 3D + filaments fantômes
    if (camera) {
      const N = this._n;
      for (let i = 0; i < N; i++) {
        if (!calme) {
          this._pz[i] -= dt * (4 + this._ta[i] * 7);
          if (this._pz[i] < -420) this._pz[i] += 1300;
        }
        camera.projeter(this._px[i], this._py[i], this._pz[i], PROJ);
        this._sx[i] = PROJ.sx; this._sy[i] = PROJ.sy;
        const dehors = PROJ.sx < -40 || PROJ.sx > W + 40 || PROJ.sy < -40 || PROJ.sy > H + 40 || PROJ.p <= 241;
        this._sa[i] = dehors ? 0 : PROJ.s;
      }
      // filaments
      ctx.beginPath();
      const P = this._paires;
      for (let k = 0; k < P.length; k += 2) {
        const i = P[k], j = P[k + 1];
        if (!this._sa[i] || !this._sa[j]) continue;
        ctx.moveTo(this._sx[i], this._sy[i]);
        ctx.lineTo(this._sx[j], this._sy[j]);
      }
      ctx.strokeStyle = alerte > 0.5 ? "rgb(255,170,90)" : "rgb(110,160,255)";
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = 0.035;
      ctx.stroke();
      // grains
      const grain = this._grain;
      for (let i = 0; i < N; i++) {
        const s = this._sa[i];
        if (!s) continue;
        const tw = calme ? 0.8 : 0.5 + 0.5 * Math.sin(T * this._tw[i] + this._ph[i]);
        const r = (0.5 + this._ta[i] * 1.6) * borne(s, 0.25, 2.4);
        const a = (0.05 + this._ta[i] * 0.28) * tw;
        if (a < 0.01) continue;
        if (grain && r > 0.9) {
          ctx.globalAlpha = a;
          ctx.drawImage(grain, this._sx[i] - r * 2.2, this._sy[i] - r * 2.2, r * 4.4, r * 4.4);
        } else {
          ctx.globalAlpha = a * 1.4;
          ctx.fillStyle = "#9cc4ff";
          ctx.fillRect(this._sx[i], this._sy[i], r + 0.4, r + 0.4);
        }
      }
    }

    // 4) vignette
    ctx.globalCompositeOperation = "source-over";
    const v = this._vignetteDe(W, H);
    if (v) { ctx.globalAlpha = 1; ctx.drawImage(v, 0, 0, W, H); }
    ctx.globalAlpha = 1;
  }
}
