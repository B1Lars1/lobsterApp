/*
 * Hummerpotensial justert etter egen fangst.
 *
 * Hummerpotensialet (lag_hummerpotensial.py) er et anslag ut fra dybde, helning og tare.
 * Der dere har fisket, vet dere mer, så her justeres anslaget etter teinesettingene: en
 * fangst øker det, en tom teine senker det litt. Regnes ut på telefonen fra markeringene
 * (bare for den som er logget inn). Den offentlige hummerpotensial.geojson røres ikke, ellers
 * kunne hvem som helst sett hvor dere får hummer.
 *
 * Metoden (gamma-Poisson, et «Bayes-anslag» for fangstrate), for hver rute:
 *   anslag = (FORVENTET × MODELL_DOGN + Σ vekt × hummer) / (MODELL_DOGN + Σ vekt × teinedøgn)
 * Modellen teller som MODELL_DOGN teinedøgn med fangsten den forventer for klassen, og egen
 * fangst legges oppå. Siden hummer er sjelden per teinedøgn, er én hummer et sterkt tegn
 * og en tom teine et svakt tegn, så en fangst øker anslaget mer enn en tom teine senker det,
 * uten egne tall for opp og ned. Modellen teller mye der den sier høyt eller middels, og
 * mindre der den sier lavt: der ser den bare ikke noe spesielt (dybdedataene har ca. 50 m
 * mellom målingene), og fangst forteller mer. Eksemplene står i README, «Justert etter
 * fangsten».
 *
 * Vekten er avstand × terreng × dybde:
 *   - avstand: full innen FULL_VEKT_M fra teinen, så mindre, til ingenting ved RADIUS_M.
 *   - terreng: hvor godt modellen mener terrenget i ruten er (TERRENG): full der den sier
 *     høyt, mindre der den sier middels, og minst der den sier lavt. Det gjelder også
 *     ruten der fangsten er registrert.
 *   - dybde: full i ruter med omtrent samme dybde som der teinen stod (innen DYBDE_LIK_M),
 *     ingenting når forskjellen er DYBDE_ULIK_M eller mer. Fangsten følger dermed
 *     skråningen der den ble tatt, ikke ut i dypet eller opp på grunna. Ukjent dybde gir
 *     halv vekt. Ruten der fangsten er, teller alltid fullt.
 * Dybden er det raske oppslaget fra dybdepunktene (lagRaskDybde): det vanlige sjekker land
 * og dybdesoner, og tok over 2 s for et par tusen ruter på telefonen. Rutene er RUTE_M
 * store, som rutenettet i lag_hummerpotensial.py.
 * Anslaget deles i klasser som i modellen (lavt,
 * middels, høyt) pluss «svært høyt», der fangsten har vært god. Kartet tegner bare rutene der
 * klassen er en annen enn modellens. Mindre endringer vises i teksten når du trykker i
 * kartet (cellFor finner alle ruter der anslaget er endret merkbart). Ruter i
 * fredningsområdene (teiner er forbudt der) tas ikke med.
 *
 * Fangst uten teine teller også, som DOGN_UTEN_TEINE teinedøgn (innsatsen er ukjent). I
 * fangstoversikten og analysen er den ikke med i hummer per teinedøgn, men her er den et
 * viktig tegn på hummer.
 *
 * FORVENTET og MODELL_DOGN er forsiktige startverdier. Juster FORVENTET etter tabellen
 * «Fangst etter hummerpotensial» i analyser_fangst.py når det er nok data (bare slike
 * samlede tall hører hjemme her: filen er offentlig).
 */

import { Rutenett, tilVerden } from './dybdelag.js';
import { iFlate, lagRaskDybde } from './dybdeoppslag.js';
import { lagSettinger } from './oversikt.js';

// Forventet fangst (hummer per teinedøgn) for klassene i modellen. «lav» er utenfor flatene.
export const FORVENTET = { hoy: 0.3, middels: 0.2, lav: 0.1 };
// Hvor mye modellen teller, i teinedøgn, etter klassen: etter så mange teinedøgn egen
// erfaring på et sted (i godt terreng) teller fangsten like mye som modellen. Lavt teller
// minst, siden modellen der bare ikke ser noe spesielt.
export const MODELL_DOGN = { hoy: 20, middels: 20, lav: 10 };
// Hvor mye fangsten teller i en rute, etter modellens klasse der
export const TERRENG = { hoy: 1, middels: 0.7, lav: 0.5 };
// Fangsten teller fullt i ruter med inntil så mange meters forskjell i dybde fra der den ble
// tatt, og ingenting fra DYBDE_ULIK_M
export const DYBDE_LIK_M = 5;
export const DYBDE_ULIK_M = 15;
const DYBDE_SOK_M = 100; // dybdepunkter så langt unna brukes (lagRaskDybde)
// Klassene etter justeringen: midt mellom de forventede verdiene, og «svært høyt» der
// fangsten er klart bedre enn modellens høye
export const GRENSER = { svaert: 0.4, hoy: 0.25, middels: 0.15 };
const RANG = { lav: 0, middels: 1, hoy: 2, svaert: 3 };

// Fangst uten teine («Fra teine: Ingen») har ingen teinedøgn. Den regnes som en teine som
// har stått så lenge, et vanlig døgn i sjøen: et tegn på hummer, men ikke sterkere enn en
// teine med samme fangst.
export const DOGN_UTEN_TEINE = 1;

const RUTE_M = 20;
const FULL_VEKT_M = 30;
const RADIUS_M = 100;
const MERKBAR = 0.02; // ruter der anslaget er endret mindre enn 2 %, regnes som uendret
const DAG = 24 * 60 * 60 * 1000;
const JORDOMKRETS_M = 40075016.686;
const perMeter = (lat) => 1 / (JORDOMKRETS_M * Math.cos((lat * Math.PI) / 180)); // verdenskoordinater
const RUTE = RUTE_M * perMeter(58.2); // rutestørrelsen i verdenskoordinater (midt i kartutsnittet)

// Nøkkel for ruten (i, j) i kartene under. Et tall går raskere enn tekst («i,j»), og
// rutenumrene er under 2^21, så det blir ingen kollisjoner.
const nokkelFor = (i, j) => i * 4194304 + j;

// Verdenskoordinater (Web Mercator, 0–1) tilbake til lon/lat
function fraVerden(x, y) {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

/**
 * Hvor mye fangst fra en dybde teller i en rute med en annen dybde (0–1): full innen
 * DYBDE_LIK_M, ingenting fra DYBDE_ULIK_M. Halv når en av dybdene er ukjent.
 */
export function dybdelikhet(her, der) {
  if (her == null || der == null) return 0.5;
  const forskjell = Math.abs(her - der);
  if (forskjell <= DYBDE_LIK_M) return 1;
  return Math.max(0, (DYBDE_ULIK_M - forskjell) / (DYBDE_ULIK_M - DYBDE_LIK_M));
}

/** Klassen et anslag (hummer per teinedøgn) tilsvarer: 'svaert', 'hoy', 'middels' eller 'lav'. */
export function klasseFor(rate) {
  if (rate >= GRENSER.svaert) return 'svaert';
  if (rate >= GRENSER.hoy) return 'hoy';
  return rate >= GRENSER.middels ? 'middels' : 'lav';
}

/**
 * Det som teller, fra alle sesonger og hele laget: teinesettinger som er tatt opp og ikke
 * mistet (teiner i sjøen har ikke noe resultat ennå), og fangst uten teine, som regnes som
 * DOGN_UTEN_TEINE teinedøgn. dybde er dybden som ble lagret med markeringen, eller null.
 * → [{ lat, lon, dybde, hummer, dogn, utenTeine }]
 */
export function fangstSettinger(markeringer) {
  const { settinger, utenTeine } = lagSettinger(markeringer.alle(), Date.now(), (m) => markeringer.eierAv(m));
  return [
    ...settinger.filter((s) => !s.iSjoen && !s.mistet).map((s) => ({
      lat: s.lat, lon: s.lon, dybde: s.dybde ?? null, hummer: s.hummer, dogn: (s.til - s.fra) / DAG, utenTeine: false,
    })),
    ...utenTeine.map((f) => ({
      lat: f.lat, lon: f.lon, dybde: f.dybde ?? null, hummer: f.hummer, dogn: DOGN_UTEN_TEINE, utenTeine: true,
    })),
  ];
}

/**
 * Juster potensialet etter settingene.
 * @param {{lat, lon, dybde, hummer, dogn, utenTeine}[]} settinger  fra fangstSettinger()
 * @param {object} data  dybdedataene (lastDybdedata().alt), for modellens flater (data.potensial)
 * @param {object} valg
 * @param {(lat: number, lon: number) => boolean} valg.iFredning
 * @param {(x: number, y: number) => number | null} valg.dybde  dybden i verdenskoordinater
 *   (lagRaskDybde i dybdeoppslag.js med DYBDE_SOK_M, null uten dybdepunkter i nærheten).
 *   Uten den teller ikke dybden.
 * @returns {{ celler: Rutenett, cellFor: (lat, lon) => object | null }}
 *   celler: rutene der klassen er en annen enn modellens (de som tegnes). cellFor: ruten
 *   i et punkt der anslaget er endret merkbart, eller null.
 *   Hver rute: { bbox, rate, klasse, modell ('hoy' | 'middels' | 'lav'), settinger, utenTeine,
 *   hummer, dogn, kanter: { n, s, v, o } } der kantene er sidene som skal ha strek (høyt mot
 *   lavere). settinger og utenTeine er antallet innen RADIUS_M.
 */
export function lagJustering(settinger, data, { iFredning = () => false, dybde = null } = {}) {
  // Modellens klasse og dybden i en rute, regnet én gang per rute og datasett
  if (!terrengLager.has(data)) terrengLager.set(data, new Map());
  const terrengFor = terrengLager.get(data); // nøkkel → { modell, dybde }
  const terreng = (i, j) => {
    const nokkel = nokkelFor(i, j);
    let t = terrengFor.get(nokkel);
    if (!t) {
      const x = (i + 0.5) * RUTE;
      const y = (j + 0.5) * RUTE;
      const flate = data.potensial.sok([x, y, x, y]).find((o) => iFlate(x, y, o));
      t = { modell: flate ? (flate.hoy ? 'hoy' : 'middels') : 'lav', dybde: dybde ? dybde(x, y) : null };
      terrengFor.set(nokkel, t);
    }
    return t;
  };

  // 1. Summer vektet fangst og teinedøgn i rutene rundt hver setting
  const ruter = new Map(); // nøkkel → rute
  for (const p of settinger) {
    const [x, y] = tilVerden(p.lon, p.lat);
    const m = perMeter(p.lat);
    const r = RADIUS_M * m;
    const dybdeHer = dybde ? p.dybde ?? dybde(x, y) : null; // der teinen stod
    for (let i = Math.floor((x - r) / RUTE); i <= Math.floor((x + r) / RUTE); i++) {
      for (let j = Math.floor((y - r) / RUTE); j <= Math.floor((y + r) / RUTE); j++) {
        const avstand = Math.hypot((i + 0.5) * RUTE - x, (j + 0.5) * RUTE - y) / m;
        if (avstand > RADIUS_M) continue;
        const t = terreng(i, j);
        const likhet = !dybde || avstand <= RUTE_M ? 1 : dybdelikhet(dybdeHer, t.dybde);
        const vekt = (avstand <= FULL_VEKT_M ? 1 : (RADIUS_M - avstand) / (RADIUS_M - FULL_VEKT_M))
          * TERRENG[t.modell] * likhet;
        const nokkel = nokkelFor(i, j);
        let rute = ruter.get(nokkel);
        if (!rute) {
          rute = { i, j, vektetHummer: 0, vektetDogn: 0, settinger: 0, utenTeine: 0, hummer: 0, dogn: 0 };
          ruter.set(nokkel, rute);
        }
        rute.vektetHummer += vekt * p.hummer;
        rute.vektetDogn += vekt * p.dogn;
        if (p.utenTeine) rute.utenTeine += 1;
        else rute.settinger += 1;
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
    const { modell } = terreng(rute.i, rute.j);
    const forventet = FORVENTET[modell];
    const modellDogn = MODELL_DOGN[modell];
    const rate = (forventet * modellDogn + rute.vektetHummer) / (modellDogn + rute.vektetDogn);
    if (Math.abs(rate - forventet) / forventet < MERKBAR) continue;
    const [lon, lat] = fraVerden(cx, cy);
    if (iFredning(lat, lon)) continue;
    merkbare.set(nokkel, {
      bbox: [rute.i * RUTE, rute.j * RUTE, (rute.i + 1) * RUTE, (rute.j + 1) * RUTE],
      i: rute.i, j: rute.j, rate, klasse: klasseFor(rate), modell,
      settinger: rute.settinger, utenTeine: rute.utenTeine, hummer: rute.hummer, dogn: rute.dogn,
    });
  }

  // 3. Kartet tegner bare rutene der klassen er en annen enn modellens
  const tegnes = new Map([...merkbare].filter(([, c]) => c.klasse !== c.modell));

  // 4. Strek rundt høyt potensial, som rundt modellens flater: der naboen er lavere
  const hoyt = (i, j) => {
    const nabo = tegnes.get(nokkelFor(i, j));
    return RANG[nabo ? nabo.klasse : terreng(i, j).modell] >= RANG.hoy;
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
      return merkbare.get(nokkelFor(Math.floor(x / RUTE), Math.floor(y / RUTE))) ?? null;
    },
  };
}

// Modellens klasse og dybden i hver rute endres ikke, så de huskes mellom utregningene (per
// datasett): etter at en teine er tatt opp, trengs bare rutene rundt den nye settingen.
const terrengLager = new WeakMap(); // dybdedataene → Map nøkkel → { modell, dybde }

/** Dybdeoppslaget lagJustering trenger (dybdepunktene innen DYBDE_SOK_M). */
export const dybdeFor = (data) => lagRaskDybde(data, DYBDE_SOK_M);

const NAVN = { svaert: 'svært høyt', hoy: 'høyt', middels: 'middels', lav: 'lavt' };
const komma = (tall, desimaler) =>
  tall.toLocaleString('nb-NO', { minimumFractionDigits: desimaler, maximumFractionDigits: desimaler });

/**
 * «Hummerpotensial etter fangsten: høyt (modellen: middels), ca. 0,25 per teinedøgn.
 * Innen 100 m: 1 teinesetting og 2 fangster uten teine, 4 hummer på 3,0 teinedøgn»
 */
export function justeringTekst(c) {
  const modell = c.klasse === c.modell ? '' : ` (modellen: ${NAVN[c.modell]})`;
  const hva = [];
  if (c.settinger) hva.push(c.settinger === 1 ? '1 teinesetting' : `${c.settinger} teinesettinger`);
  if (c.utenTeine) hva.push(c.utenTeine === 1 ? '1 fangst uten teine' : `${c.utenTeine} fangster uten teine`);
  const dogn = c.utenTeine ? ' (fangst uten teine regnes som ett døgn)' : '';
  return `Hummerpotensial etter fangsten: ${NAVN[c.klasse]}${modell}, ca. ${komma(c.rate, 2)} per teinedøgn. `
    + `Innen ${RADIUS_M} m: ${hva.join(' og ')}, ${c.hummer} hummer på ${komma(c.dogn, 1)} teinedøgn${dogn}`;
}
