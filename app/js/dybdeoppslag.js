/*
 * Dybdeoppslag: anslår dybden i et punkt ut fra dybdedataene som allerede er lastet
 * for kartet (dybdelag.js), så det virker også uten nett.
 *
 *  1. Ligger punktet på land, er svaret null (tørrfall gir 0).
 *  2. Finn dybdesonen punktet ligger i, f.eks. 5–10 m. Utenfor dataene er svaret null.
 *  3. Vekt dybdepunktene og grunnene innenfor 150 m etter avstand (nærmere punkter
 *     teller mer, «invers avstandsvekting») og hold svaret innenfor sonens grenser.
 *     Finnes ingen målinger i nærheten, brukes midten av sonen.
 *
 * Svaret er et anslag i meter med én desimal. Kartverkets åpne data har ca. 50 m
 * mellom dybdepunktene, så regn med noen meters usikkerhet.
 */

import { tilVerden } from './dybdelag.js';

const SOKERADIUS_M = 150;
const JORDOMKRETS_M = 40075016.686;

// Verdenskoordinater (Web Mercator, 0–1) per meter på denne breddegraden
const perMeter = (lat) => 1 / (JORDOMKRETS_M * Math.cos((lat * Math.PI) / 180));

// Kvadratet av avstanden fra (x, y) til linjestykket (ax, ay)–(bx, by)
function avstand2TilLinje(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengde2 = dx * dx + dy * dy;
  const t = lengde2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengde2)) : 0;
  return (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
}

// Ligger punktet (x, y) inne i ringen? Klassisk «stråle»-test.
function iRing(x, y, r) {
  let inne = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i];
    const yi = r[i + 1];
    const xj = r[j];
    const yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inne = !inne;
  }
  return inne;
}

// Inne i en flate (med hull og flere deler): odde antall ringer rundt punktet.
export function iFlate(x, y, objekt) {
  let inne = false;
  objekt.ringer.forEach((ring, k) => {
    const b = objekt.ringBokser[k];
    if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && iRing(x, y, ring)) inne = !inne;
  });
  return inne;
}

/**
 * Lag en funksjon bunnI(lat, lon) som forteller hva vi vet om bunnen i punktet:
 * { hint: bunnhint-objektet (tareskog, ålegras …) eller null,
 *   potensial: 'hoy' | 'middels' | null (hummerpotensialet, et anslag) }
 */
export function lagBunnoppslag(data) {
  return function bunnI(lat, lon) {
    const [x, y] = tilVerden(lon, lat);
    const punkt = [x, y, x, y];
    const hint = data.bunnhint.sok(punkt).find((o) => iFlate(x, y, o)) ?? null;
    const flate = data.potensial.sok(punkt).find((o) => iFlate(x, y, o));
    return { hint, potensial: flate ? (flate.hoy ? 'hoy' : 'middels') : null };
  };
}

/**
 * Lag en funksjon dybdeI(lat, lon) som returnerer anslått dybde i meter, eller null.
 * @param {object} data  resultatet fra lastDybdedata()
 */
export function lagDybdeoppslag(data) {
  return function dybdeI(lat, lon) {
    const [x, y] = tilVerden(lon, lat);
    const punkt = [x, y, x, y];

    const land = data.land.sok(punkt).find((o) => iFlate(x, y, o));
    if (land) return land.torrfall ? 0 : null;

    const sone = data.soner.sok(punkt).find((o) => iFlate(x, y, o));
    if (!sone) return null;

    const meter = perMeter(lat);
    const r = SOKERADIUS_M * meter;
    let sumVekt = 0;
    let sumDybde = 0;
    for (const p of data.dybdetall.sok([x - r, y - r, x + r, y + r])) {
      const avstand2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (avstand2 > r * r) continue;
      const vekt = 1 / Math.max(avstand2, meter * meter);
      sumVekt += vekt;
      sumDybde += vekt * p.dybde;
    }
    const anslag = sumVekt ? sumDybde / sumVekt : (sone.min + sone.maks) / 2;
    const dybde = Math.min(Math.max(anslag, sone.min), sone.maks);
    return Math.round(dybde * 10) / 10;
  };
}

/**
 * Er punktet på sjøen, eller nærmere sjøen enn radiusM? «Sjøen» er dybdeområdene, så
 * utenfor kartområdet er svaret alltid nei. Brukes når appen åpnes (se gps.js).
 */
export function naerSjoen(data, lat, lon, radiusM) {
  const [x, y] = tilVerden(lon, lat);
  const r = radiusM * perMeter(lat);
  for (const o of data.soner.sok([x - r, y - r, x + r, y + r])) {
    if (iFlate(x, y, o)) return true;
    // Utenfor flaten: nær nok hvis en av kantene er innenfor radiusen
    for (let k = 0; k < o.ringer.length; k++) {
      const b = o.ringBokser[k];
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      const ring = o.ringer[k];
      for (let i = 2; i < ring.length; i += 2) {
        if (avstand2TilLinje(x, y, ring[i - 2], ring[i - 1], ring[i], ring[i + 1]) <= r * r) return true;
      }
    }
  }
  return false;
}
