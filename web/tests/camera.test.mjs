import { test } from "node:test";
import assert from "node:assert/strict";
import { Camera } from "../js/camera.js";

const proche = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("aller-retour deprojeter(projeter(x, y, 0)) pour 5 couples yaw/pitch", () => {
  const couples = [[0, 0.5], [0.3, 0.94], [1.2, 1.1], [-2.4, 1.45], [3.0, 0.7]];
  const points = [[0, 0], [120, -80], [-300, 210], [450, 40], [-35, -260]];
  for (const [yaw, pitch] of couples) {
    const cam = new Camera({ largeur: 1600, hauteur: 900 });
    cam.yaw = yaw; cam.pitch = pitch; cam.k = 0.8; cam.tx = 40; cam.ty = -25;
    for (const [x, y] of points) {
      const p = cam.projeter(x, y, 0);
      const g = cam.deprojeter(p.sx, p.sy);
      assert.ok(proche(g.x, x) && proche(g.y, y), `yaw ${yaw} pitch ${pitch} : (${x},${y}) → (${g.x},${g.y})`);
    }
  }
});

test("projeter renvoie sx, sy, s, p finis ; le centre de la vue tombe au centre de l'écran", () => {
  const cam = new Camera({ largeur: 1000, hauteur: 600 });
  cam.tx = 10; cam.ty = 20;
  const p = cam.projeter(10, 20, 0);
  assert.ok(proche(p.sx, 500) && proche(p.sy, 300));
  assert.ok(p.s > 0 && Number.isFinite(p.p));
  // un point plus haut (z > 0) monte à l'écran
  assert.ok(cam.projeter(10, 20, 100).sy < p.sy);
});

test("projeter accepte un objet de sortie (aucune allocation par image)", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  const o = { sx: 0, sy: 0, s: 0, p: 0 };
  assert.equal(cam.projeter(5, 5, 0, o), o);
});

test("tourner : pitch borné à [0,5 ; 1,45]", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  const yaw0 = cam.yaw;
  cam.tourner(100, 0);
  assert.ok(cam.yaw > yaw0);
  cam.tourner(0, -100000);
  assert.equal(cam.pitch, 1.45);
  cam.tourner(0, 100000);
  assert.equal(cam.pitch, 0.5);
});

test("zoomer garde le point sous le curseur immobile", () => {
  const cam = new Camera({ largeur: 1200, hauteur: 800 });
  const avant = cam.deprojeter(900, 250);
  const k0 = cam.k;
  cam.zoomer(1.7, 900, 250);
  assert.ok(proche(cam.k, k0 * 1.7));
  const apres = cam.deprojeter(900, 250);
  assert.ok(proche(avant.x, apres.x, 1e-6) && proche(avant.y, apres.y, 1e-6));
});

test("zoomer borne k", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  cam.zoomer(1e9, 400, 300);
  assert.equal(cam.k, 5);
  cam.zoomer(1e-9, 400, 300);
  assert.equal(cam.k, 0.06);
});

test("viser anime jusqu'à la cible, par le plus court chemin en yaw", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  cam.yaw = 3.0;
  cam.viser({ tx: 100, ty: -50, k: 1.5, yaw: -3.0 }, 1);
  assert.ok(cam.enMouvement);
  cam.avancer(0.5);
  assert.ok(cam.tx > 0 && cam.tx < 100);
  assert.ok(cam.yaw > 3.0, "le yaw passe par π, pas par 0");
  cam.avancer(0.6);
  assert.ok(!cam.enMouvement);
  assert.ok(proche(cam.tx, 100) && proche(cam.ty, -50) && proche(cam.k, 1.5));
  assert.ok(proche(Math.cos(cam.yaw), Math.cos(-3.0)) && proche(Math.sin(cam.yaw), Math.sin(-3.0)));
});

test("viser avec une durée nulle est immédiat", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  cam.viser({ tx: 7, pitch: 2 }, 0);
  assert.equal(cam.tx, 7);
  assert.equal(cam.pitch, 1.45);
  assert.ok(!cam.enMouvement);
});

test("redimensionner déplace le centre de projection", () => {
  const cam = new Camera({ largeur: 800, hauteur: 600 });
  cam.redimensionner(400, 200);
  const p = cam.projeter(cam.tx, cam.ty, 0);
  assert.ok(proche(p.sx, 200) && proche(p.sy, 100));
});
