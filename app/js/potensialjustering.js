/*
 * Hummerpotensial justert etter egen fangst.
 *
 * Hummerpotensialet (lag_hummerpotensial.py) er et anslag ut fra dybde, helning og tare.
 * Der dere har fisket, vet dere mer, så her justeres anslaget etter teinesettingene: en
 * fangst øker det, en tom teine senker det litt. Regnes ut på telefonen fra markeringene
 * (bare for den som er logget inn). Den offentlige hummerpotensial.geojson røres ikke, ellers
 * kunne hvem som helst sett hvor dere får hummer.
 *
 * Metoden (gamma-Poisson, et «Bayes-anslag» for fangstrate):
 *   anslag = (FORVENTET × MODELL_DOGN + hummer) / (MODELL_DOGN + teinedøgn)
 * Modellen teller som MODELL_DOGN teinedøgn med fangsten den forventer for klassen, og egen
 * fangst legges oppå. Siden hummer er sjelden per teinedøgn, er én hummer et sterkt tegn
 * og en tom teine et svakt tegn, så en fangst øker anslaget mer enn en tom teine senker det,
 * uten egne tall for opp og ned. Eksempel, middels (0,2) og 10 modelldøgn: én hummer på ett
 * døgn gir 0,27 (+36 %), ett tomt døgn gir 0,18 (−9 %), ti tomme døgn gir 0,1 (lavt).
 *
 * Hver setting teller fullt i ruter innen FULL_VEKT_M fra teinen og mindre utover, til
 * ingenting ved RADIUS_M (agnet trekker hummer fra en stund unna). Rutene er RUTE_M store,
 * som rutenettet i lag_hummerpotensial.py. Anslaget deles i klasser som i modellen (lavt,
 * middels, høyt) pluss «svært høyt», der fangsten har vært god. Kartet tegner bare rutene der
 * klassen er en annen enn modellens. Mindre endringer vises i teksten når du trykker i
 * kartet (cellFor finner alle ruter der anslaget er endret merkbart). Ruter i
 * fredningsområdene (teiner er forbudt der) tas ikke med.
 *
 * FORVENTET og MODELL_DOGN er forsiktige startverdier. Juster FORVENTET etter tabellen
 * «Fangst etter hummerpotensial» i analyser_fangst.py når det er nok data (bare slike
 * samlede tall hører hjemme her: filen er offentlig).
 */

import { Rutenett, tilVerden } from './dybdelag.js';
import { iFlate } from './dybdeoppslag.js';
import { lagSettinger } from './oversikt.js';

// Forventet fangst (hummer per teinedøgn) for klassene i modellen. «lav» er utenfor flatene.
export const FORVENTET = { hoy: 0.3, middels: 0.2, lav: 0.1 };
// Hvor mye modellen teller, i teinedøgn: etter så mange teinedøgn egen erfaring på et sted
// teller fangsten like mye som modellen.
export const MODELL_DOGN = 10;
// Klassene etter justeringen: midt mellom de forventede verdiene, og «svært høyt» der
// fangsten er klart bedre enn modellens høye
export const GRENSER = { svaert: 0.4, hoy: 0.25, middels: 0.15 };
const RANG = { lav: 0, middels: 1, hoy: 2, svaert: 3 };

const RUTE_M = 20;
const FULL_VEKT_M = 50;
const RADIUS_M = 150;
const MERKBAR = 0.05; // ruter der anslaget er endret mindre enn 5 %, tegnes som før
const DAG = 24 * 60 * 60 * 1000;
const JORDOMKRETS_M = 40075016.686;
const perMeter = (lat) => 1 / (JORDOMKRETS_M * Math.cos((lat * Math.PI) / 180)); // verdenskoordinater
const RUTE = RUTE_M * perMeter(58.2); // rutestørrelsen i verdenskoordinater (midt i kartutsnittet)

// Verdenskoordinater (Web Mercator, 0–1) tilbake til lon/lat
function fraVerden(x, y) {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

/** Klassen et anslag (hummer per teinedøgn) tilsvarer: 'svaert', 'hoy', 'middels' eller 'lav'. */
export function klasseFor(rate) {
  if (rate >= GRENSER.svaert) return 'svaert';
  if (rate >= GRENSER.hoy) return 'hoy';
  return rate >= GRENSER.middels ? 'middels' : 'lav';
}

/**
 * Teinesettingene som teller: tatt opp, ikke mistet, fra alle sesonger og hele laget.
 * Teiner i sjøen har ikke noe resultat ennå, og fangst uten teine har ingen teinedøgn.
 * → [{ lat, lon, hummer, dogn }]
 */
export function fangstSettinger(markeringer) {
  const { settinger } = lagSettinger(markeringer.alle(), Date.now(), (m) => markeringer.eierAv(m));
  return settinger.filter((s) => !s.iSjoen && !s.mistet)
    .map((s) => ({ lat: s.lat, lon: s.lon, hummer: s.hummer, dogn: (s.til - s.fra) / DAG }));
}

/**
 * Juster potensialet etter settingene.
 * @param {{lat, lon, hummer, dogn}[]} settinger  fra fangstSettinger()
 * @param {object} data  dybdedataene (lastDybdedata().alt), for modellens flater (data.potensial)
 * @param {(lat: number, lon: number) => boolean} iFredning
 * @returns {{ celler: Rutenett, cellFor: (lat, lon) => object | null }}
 *   celler: rutene der klassen er en annen enn modellens (de som tegnes). cellFor: ruten
 *   i et punkt der anslaget er endret merkbart, eller null.
 *   Hver rute: { bbox, rate, klasse, modell ('hoy' | 'middels' | 'lav'), settinger, hummer,
 *   dogn, kanter: { n, s, v, o } } der kantene er sidene som skal ha strek (høyt mot lavere).
 */
export function lagJustering(settinger, data, iFredning = () => false) {
  const modellFor = (x, y) => {
    const flate = data.potensial.sok([x, y, x, y]).find((o) => iFlate(x, y, o));
    return flate ? (flate.hoy ? 'hoy' : 'middels') : 'lav';
  };

  // 1. Summer vektet fangst og teinedøgn i rutene rundt hver setting
  const ruter = new Map(); // «i,j» → rute
  for (const p of settinger) {
    const [x, y] = tilVerden(p.lon, p.lat);
    const m = perMeter(p.lat);
    const r = RADIUS_M * m;
    for (let i = Math.floor((x - r) / RUTE); i <= Math.floor((x + r) / RUTE); i++) {
      for (let j = Math.floor((y - r) / RUTE); j <= Math.floor((y + r) / RUTE); j++) {
        const avstand = Math.hypot((i + 0.5) * RUTE - x, (j + 0.5) * RUTE - y) / m;
        if (avstand > RADIUS_M) continue;
        const vekt = avstand <= FULL_VEKT_M ? 1 : (RADIUS_M - avstand) / (RADIUS_M - FULL_VEKT_M);
        const nokkel = `${i},${j}`;
        let rute = ruter.get(nokkel);
        if (!rute) {
          rute = { i, j, vektetHummer: 0, vektetDogn: 0, settinger: 0, hummer: 0, dogn: 0 };
          ruter.set(nokkel, rute);
        }
        rute.vektetHummer += vekt * p.hummer;
        rute.vektetDogn += vekt * p.dogn;
        rute.settinger += 1;
        rute.hummer += p.hummer;
        rute.dogn += p.dogn;
      }
    }
  }

  // 2. Anslaget i hver rute. Bare merkbare endringer utenfor fredningsområdene tas med.
  const merkbare = new Map();
  for (const [nokkel, rute] of ruter) {
    const cx = (rute.i + 0.5) * RUTE;
    const cy = (rute.j + 0.5) * RUTE;
    const modell = modellFor(cx, cy);
    const forventet = FORVENTET[modell];
    const rate = (forventet * MODELL_DOGN + rute.vektetHummer) / (MODELL_DOGN + rute.vektetDogn);
    if (Math.abs(rate - forventet) / forventet < MERKBAR) continue;
    const [lon, lat] = fraVerden(cx, cy);
    if (iFredning(lat, lon)) continue;
    merkbare.set(nokkel, {
      bbox: [rute.i * RUTE, rute.j * RUTE, (rute.i + 1) * RUTE, (rute.j + 1) * RUTE],
      i: rute.i, j: rute.j, rate, klasse: klasseFor(rate), modell,
      settinger: rute.settinger, hummer: rute.hummer, dogn: rute.dogn,
    });
  }

  // 3. Kartet tegner bare rutene der klassen er en annen enn modellens
  const tegnes = new Map([...merkbare].filter(([, c]) => c.klasse !== c.modell));

  // 4. Strek rundt høyt potensial, som rundt modellens flater: der naboen er lavere
  const hoyt = (i, j) => {
    const nabo = tegnes.get(`${i},${j}`);
    return RANG[nabo ? nabo.klasse : modellFor((i + 0.5) * RUTE, (j + 0.5) * RUTE)] >= RANG.hoy;
  };
  for (const c of tegnes.values()) {
    const her = RANG[c.klasse] >= RANG.hoy;
    c.kanter = {
      n: her && !hoyt(c.i, c.j - 1), s: her && !hoyt(c.i, c.j + 1),
      v: her && !hoyt(c.i - 1, c.j), o: her && !hoyt(c.i + 1, c.j),
    };
  }

  return {
    celler: new Rutenett([...tegnes.values()]),
    cellFor(lat, lon) {
      const [x, y] = tilVerden(lon, lat);
      return merkbare.get(`${Math.floor(x / RUTE)},${Math.floor(y / RUTE)}`) ?? null;
    },
  };
}

const NAVN = { svaert: 'svært høyt', hoy: 'høyt', middels: 'middels', lav: 'lavt' };
const komma = (tall, desimaler) =>
  tall.toLocaleString('nb-NO', { minimumFractionDigits: desimaler, maximumFractionDigits: desimaler });

/** «Hummerpotensial etter fangsten: høyt (modellen: middels). 3 teinesettinger innen 150 m …» */
export function justeringTekst(c) {
  const modell = c.klasse === c.modell ? '' : ` (modellen: ${NAVN[c.modell]})`;
  const settinger = c.settinger === 1 ? '1 teinesetting' : `${c.settinger} teinesettinger`;
  return `Hummerpotensial etter fangsten: ${NAVN[c.klasse]}${modell}, ca. ${komma(c.rate, 2)} per teinedøgn. `
    + `${settinger} innen ${RADIUS_M} m ga ${c.hummer} hummer på ${komma(c.dogn, 1)} teinedøgn`;
}
