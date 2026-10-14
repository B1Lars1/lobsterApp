/*
 * Dybdelag: tegner dybdekartet (dybdesoner, kurver, land, etiketter og dybdetall)
 * som kartfliser på <canvas>.
 *
 * Hvorfor ikke vanlige Leaflet-vektorlag (L.geoJSON)?
 * Dataene har flere hundre tusen koordinater. Vanlige vektorlag tegnes på nytt ved
 * hver zoom og blir trege på mobil. Fliser tegnes én gang og gjenbrukes når du
 * panorerer, så kartet holder seg raskt.
 *
 * Slik virker det:
 *  1. lastDybdedata() henter GeoJSON-filene og regner alle koordinater om til
 *     «verdenskoordinater» (Web Mercator, 0–1) én gang.
 *  2. Et rutenett (romlig indeks) gjør at hver flis bare ser på objekter i nærheten.
 *  3. Dybdelag (en L.GridLayer) tegner en flis hver gang Leaflet ber om en.
 */

const FLIS = 256; // flisstørrelse i CSS-piksler

// Fargepaletter. «soner» går fra grunt til dypt (se SONEGRENSER).
export const PALETTER = {
  lys: {
    bakgrunn: '#d4e8f5',
    soner: ['#f2fafe', '#dff1fb', '#c8e5f6', '#aed7f0', '#93c7e8', '#79b5de', '#629fd1'],
    land: '#f4eedb', kyst: '#7a6a4c', torrfall: '#d3ddb0',
    kurve: 'rgba(20, 62, 102, 0.6)', kurveViktig: 'rgba(20, 62, 102, 0.95)',
    tekst: '#0c2c4a', halo: 'rgba(255, 255, 255, 0.9)',
    dybdetall: '#2a4c6b', skjaer: '#141414',
  },
  mork: {
    bakgrunn: '#07111a',
    soner: ['#1f5675', '#1b4c69', '#17425d', '#133851', '#0f2f46', '#0c263a', '#091d2e'],
    land: '#2c3136', kyst: '#7a8794', torrfall: '#2f3a31',
    kurve: 'rgba(110, 180, 228, 0.45)', kurveViktig: 'rgba(130, 196, 240, 0.85)',
    tekst: '#d3ebfb', halo: 'rgba(7, 17, 26, 0.9)',
    dybdetall: '#a3c9e4', skjaer: '#eef2f5',
  },
};

// Nedre grense (m) for hver fargesone etter den første: 0–2, 2–5, 5–10, 10–20, 20–30, 30–50, 50+
export const SONEGRENSER = [2, 5, 10, 20, 30, 50];
const VIKTIGE_KURVER = new Set([10, 20, 50]); // tegnes litt tykkere
const HOVEDKURVER = new Set([5, 10, 20, 50]); // de eneste som vises på zoom 12

function soneIndeks(minDybde) {
  let i = 0;
  while (i < SONEGRENSER.length && minDybde >= SONEGRENSER[i]) i++;
  return i;
}

// ---------- Koordinater ----------

// lon/lat -> Web Mercator «verdenskoordinater» der hele jorda er 0–1 i x og y.
function tilVerden(lon, lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

function ringerFraGeometri(g) {
  switch (g.type) {
    case 'LineString': return [g.coordinates];
    case 'MultiLineString':
    case 'Polygon': return g.coordinates;
    case 'MultiPolygon': return g.coordinates.flat();
    default: return [];
  }
}

// Gjør om GeoJSON-objekter til { ringer, ringBokser, bbox, ...egenskaper }.
// Hver ring lagres som Float64Array [x0, y0, x1, y1, ...] i verdenskoordinater.
function lagObjekter(geojson, egenskaper) {
  return geojson.features.map((f) => {
    const ringer = [];
    const ringBokser = [];
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of ringerFraGeometri(f.geometry)) {
      const r = new Float64Array(ring.length * 2);
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      ring.forEach(([lon, lat], i) => {
        const [x, y] = tilVerden(lon, lat);
        r[2 * i] = x;
        r[2 * i + 1] = y;
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      });
      ringer.push(r);
      ringBokser.push(b);
      bbox[0] = Math.min(bbox[0], b[0]);
      bbox[1] = Math.min(bbox[1], b[1]);
      bbox[2] = Math.max(bbox[2], b[2]);
      bbox[3] = Math.max(bbox[3], b[3]);
    }
    return { ringer, ringBokser, bbox, ...egenskaper(f.properties) };
  });
}

function lagPunkter(geojson, egenskaper) {
  return geojson.features.map((f) => {
    const [x, y] = tilVerden(...f.geometry.coordinates);
    return { x, y, bbox: [x, y, x, y], ...egenskaper(f.properties) };
  });
}

const overlapper = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---------- Romlig indeks ----------

// Deler området i n×n ruter. Hvert objekt registreres i rutene det overlapper,
// så et søk bare trenger å se på objektene i rutene flisa dekker.
class Rutenett {
  constructor(objekter, n = 64) {
    this.objekter = objekter;
    this.n = n;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const o of objekter) {
      b[0] = Math.min(b[0], o.bbox[0]);
      b[1] = Math.min(b[1], o.bbox[1]);
      b[2] = Math.max(b[2], o.bbox[2]);
      b[3] = Math.max(b[3], o.bbox[3]);
    }
    this.bbox = b;
    this.bx = (b[2] - b[0]) / n || 1;
    this.by = (b[3] - b[1]) / n || 1;
    this.ruter = Array.from({ length: n * n }, () => []);
    objekter.forEach((o, i) => this._ruterFor(o.bbox, (r) => this.ruter[r].push(i)));
    this.merke = new Uint32Array(objekter.length); // hindrer at samme objekt returneres to ganger
    this.runde = 0;
  }

  _ruterFor(bbox, gjor) {
    const klamp = (v) => Math.max(0, Math.min(this.n - 1, v));
    const x0 = klamp(Math.floor((bbox[0] - this.bbox[0]) / this.bx));
    const x1 = klamp(Math.floor((bbox[2] - this.bbox[0]) / this.bx));
    const y0 = klamp(Math.floor((bbox[1] - this.bbox[1]) / this.by));
    const y1 = klamp(Math.floor((bbox[3] - this.bbox[1]) / this.by));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) gjor(y * this.n + x);
  }

  sok(bbox) {
    if (!overlapper(bbox, this.bbox)) return [];
    const runde = ++this.runde;
    const treff = [];
    this._ruterFor(bbox, (r) => {
      for (const i of this.ruter[r]) {
        if (this.merke[i] === runde) continue;
        this.merke[i] = runde;
        if (overlapper(this.objekter[i].bbox, bbox)) treff.push(this.objekter[i]);
      }
    });
    return treff;
  }
}

// ---------- Lasting ----------

export async function lastDybdedata(mappe = 'data/') {
  const hent = async (navn) => {
    const svar = await fetch(mappe + navn);
    if (!svar.ok) throw new Error(`Klarte ikke å hente ${navn} (${svar.status})`);
    return svar.json();
  };
  const [areal, land, kurver, etiketter, dybdetall] = await Promise.all([
    hent('dybdeareal.geojson'),
    hent('land.geojson'),
    hent('dybdekurver.geojson'),
    hent('kurveetiketter.geojson'),
    hent('dybdetall.geojson'),
  ]);
  return {
    soner: new Rutenett(lagObjekter(areal, (p) => ({ sone: soneIndeks(p.min), min: p.min, maks: p.maks }))),
    land: new Rutenett(lagObjekter(land, (p) => ({ torrfall: p.kategori === 'torrfall' }))),
    kurver: new Rutenett(lagObjekter(kurver, (p) => ({
      viktig: VIKTIGE_KURVER.has(p.dybde), hoved: HOVEDKURVER.has(p.dybde),
    }))),
    etiketter: new Rutenett(lagPunkter(etiketter, (p) => ({
      tekst: String(p.dybde), vinkel: (p.vinkel * Math.PI) / 180, niva: p.niva,
    }))),
    dybdetall: new Rutenett(lagPunkter(dybdetall, (p) => ({ kategori: p.kategori, dybde: p.dybde }))),
  };
}

// ---------- Tegning ----------

// Legger ringene til gjeldende sti. Hopper over ringer utenfor flisa, og punkter
// som ligger under én piksel fra forrige punkt (det sparer mye når du zoomer ut).
function leggTilRinger(ctx, objekt, t, lukk) {
  for (let k = 0; k < objekt.ringer.length; k++) {
    if (!overlapper(objekt.ringBokser[k], t.bbox)) continue;
    const r = objekt.ringer[k];
    let lx = r[0] * t.skala - t.ox;
    let ly = r[1] * t.skala - t.oy;
    ctx.moveTo(lx, ly);
    const siste = r.length - 2;
    for (let i = 2; i <= siste; i += 2) {
      const x = r[i] * t.skala - t.ox;
      const y = r[i + 1] * t.skala - t.oy;
      if (i < siste && Math.abs(x - lx) + Math.abs(y - ly) < 0.8) continue;
      ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
    if (lukk) ctx.closePath();
  }
}

// Dybdetall i sjøkartstil: hele meter stort, desimalen liten og senket («12₃»).
// Negative verdier er tørrfallshøyder og understrekes, som i sjøkartet.
function tegnDybde(ctx, x, y, dybde, str, p, fet) {
  const verdi = Math.abs(dybde);
  const hel = Math.floor(verdi);
  const desimal = Math.round((verdi - hel) * 10) % 10;
  const visDesimal = verdi < 31 && desimal !== 0;
  const fontHel = `${fet ? 700 : 500} ${str}px system-ui, sans-serif`;
  const fontDes = `${fet ? 700 : 500} ${Math.round(str * 0.75)}px system-ui, sans-serif`;

  ctx.font = fontHel;
  const bHel = ctx.measureText(String(hel)).width;
  let bDes = 0;
  if (visDesimal) {
    ctx.font = fontDes;
    bDes = ctx.measureText(String(desimal)).width;
  }
  const x0 = x - (bHel + bDes) / 2;
  ctx.font = fontHel;
  ctx.strokeText(String(hel), x0, y);
  ctx.fillText(String(hel), x0, y);
  if (visDesimal) {
    ctx.font = fontDes;
    ctx.strokeText(String(desimal), x0 + bHel, y + str * 0.3);
    ctx.fillText(String(desimal), x0 + bHel, y + str * 0.3);
  }
  if (dybde < 0) ctx.fillRect(x0, y + str * 0.6, bHel + bDes, 1.2);
}

// Sjøkartsymbol for skjær: kryss med fire prikker.
function tegnSkjaer(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x + 5, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.stroke();
  for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 1.1, 0, 2 * Math.PI);
    ctx.fill();
  }
}

export const Dybdelag = L.GridLayer.extend({
  options: {
    tileSize: FLIS,
    updateWhenZooming: false, // ikke tegn fliser for mellomliggende zoom under knipe-zoom
    keepBuffer: 3,
    tema: 'lys',              // 'lys' | 'mork'
    visLand: true,            // false når et bakgrunnskart fra Kartverket viser land
    visDybdetall: true,
  },

  initialize(data, options) {
    this._data = data;
    L.setOptions(this, options);
  },

  // Endre tema/innstillinger og tegn alle fliser på nytt.
  settValg(valg) {
    L.setOptions(this, valg);
    this.redraw();
  },

  createTile(coords, ferdig) {
    const lerret = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // skarp tekst, men maks 2x for å spare minne
    lerret.width = lerret.height = FLIS * dpr;
    // Tegn i neste runde, så kartet ikke fryser mens mange fliser lages.
    setTimeout(() => {
      this._tegnFlis(lerret, coords, dpr);
      ferdig(null, lerret);
    }, 0);
    return lerret;
  },

  _tegnFlis(lerret, c, dpr) {
    const ctx = lerret.getContext('2d');
    ctx.scale(dpr, dpr);
    const p = PALETTER[this.options.tema];
    const z = c.z;
    const n = 2 ** z;
    const t = {
      skala: FLIS * n,
      ox: c.x * FLIS,
      oy: c.y * FLIS,
      bbox: [c.x / n, c.y / n, (c.x + 1) / n, (c.y + 1) / n],
    };
    const margin = 40 / t.skala; // tekst kan stikke inn fra nabofliser
    const utvidet = [t.bbox[0] - margin, t.bbox[1] - margin, t.bbox[2] + margin, t.bbox[3] + margin];
    const visLand = this.options.visLand;
    const tegnSti = (objekter, lukk) => {
      ctx.beginPath();
      for (const o of objekter) leggTilRinger(ctx, o, t, lukk);
    };
    ctx.lineJoin = 'round';

    // 1. Bakgrunn (sjø uten data)
    if (visLand) {
      ctx.fillStyle = p.bakgrunn;
      ctx.fillRect(0, 0, FLIS, FLIS);
    }

    // 2. Dybdesoner, én sti per farge
    const soner = this._data.soner.sok(t.bbox);
    ctx.globalAlpha = visLand ? 1 : 0.7; // la Kartverkets kart skinne gjennom
    for (let i = 0; i < p.soner.length; i++) {
      const utvalg = soner.filter((o) => o.sone === i);
      if (!utvalg.length) continue;
      tegnSti(utvalg, true);
      ctx.fillStyle = ctx.strokeStyle = p.soner[i];
      ctx.fill('evenodd');
      if (visLand) {
        ctx.lineWidth = 1; // samme farge rundt kanten skjuler tynne sømmer mellom naboflater
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 3. Dybdekurver
    let kurver = this._data.kurver.sok(t.bbox);
    if (z <= 12) kurver = kurver.filter((o) => o.hoved); // færre streker når kartet er zoomet ut
    const bredde = z < 13 ? 0.6 : z < 15 ? 0.9 : 1.2;
    for (const viktig of [false, true]) {
      const utvalg = kurver.filter((o) => o.viktig === viktig);
      if (!utvalg.length) continue;
      tegnSti(utvalg, false);
      ctx.strokeStyle = viktig ? p.kurveViktig : p.kurve;
      ctx.lineWidth = viktig ? bredde * 1.5 : bredde;
      ctx.stroke();
    }

    // 4. Land og tørrfall
    if (visLand) {
      const land = this._data.land.sok(t.bbox);
      for (const torrfall of [true, false]) {
        const utvalg = land.filter((o) => o.torrfall === torrfall);
        if (!utvalg.length) continue;
        tegnSti(utvalg, true);
        ctx.fillStyle = torrfall ? p.torrfall : p.land;
        ctx.fill('evenodd');
        ctx.strokeStyle = p.kyst;
        ctx.lineWidth = torrfall ? 0.5 : z < 13 ? 0.6 : 1;
        ctx.stroke();
      }
    }

    // Felles tekstoppsett: lys/mørk kant («halo») rundt teksten gjør den lesbar på alle farger
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.halo;
    ctx.textBaseline = 'middle';

    // 5. Dybdetall langs kurvene. «niva» bestemmer tettheten per zoomnivå.
    if (z >= 13) {
      const maksNiva = z - 13;
      ctx.font = `700 ${z >= 16 ? 13 : z >= 15 ? 12 : 11}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = p.tekst;
      for (const e of this._data.etiketter.sok(utvidet)) {
        if (e.niva > maksNiva) continue;
        ctx.save();
        ctx.translate(e.x * t.skala - t.ox, e.y * t.skala - t.oy);
        ctx.rotate(-e.vinkel);
        ctx.strokeText(e.tekst, 0, 0);
        ctx.fillText(e.tekst, 0, 0);
        ctx.restore();
      }
    }

    // 6. Dybdepunkter, grunner og skjær når du er zoomet godt inn
    if (this.options.visDybdetall && z >= 14) {
      ctx.textAlign = 'left';
      const str = z >= 17 ? 13 : 11;
      for (const d of this._data.dybdetall.sok(utvidet)) {
        const x = d.x * t.skala - t.ox;
        const y = d.y * t.skala - t.oy;
        if (d.kategori === 'skjaer') {
          ctx.strokeStyle = ctx.fillStyle = p.skjaer;
          ctx.lineWidth = 1.4;
          tegnSkjaer(ctx, x, y);
          ctx.lineWidth = 3;
          ctx.strokeStyle = p.halo;
        } else if (d.kategori === 'grunne' ? z >= 15 : z >= 16) {
          ctx.fillStyle = p.dybdetall;
          tegnDybde(ctx, x, y, d.dybde, str, p, d.kategori === 'grunne');
        }
      }
    }
  },
});
