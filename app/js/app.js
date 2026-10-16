/*
 * Hummerkart – hovedfil. Setter opp kartet, kartlagene, GPS-en, knappene og
 * innstillingsarket, og kobler sammen modulene:
 *   dybdelag.js        dybdekartet
 *   gps.js             posisjonen din
 *   markeringer.js     teiner og fangst (data, lagring, GeoJSON)
 *   kartmarkeringer.js symbolene på kartet
 *   markeringsark.js   knappene og arkene for markeringer
 *   fredning.js        fredningsområder for hummer
 *   sky.js             konto og synkronisering med skyen (Firebase, se firebase.js)
 *   konto.js           innlogging og kontoen i innstillingsarket
 *   hjemskjerm.js      veiledning for å legge appen til på hjemskjermen
 *   oversikt.js        fangstoversikten: nøkkeltall og tidslinje
 *   personer.js        hvem du er, og initialene og fargene til de andre i laget
 *   tidligere.js       fangst fra tidligere sesonger som eget kartlag
 *   potensialjustering.js  hummerpotensialet justert etter egen fangst
 *
 * Leaflet (globalt objekt «L») lastes som vanlig <script> i index.html før denne filen.
 */

import { Dybdelag, PALETTER, SONEGRENSER, lastDybdedata } from './dybdelag.js';
import { dobbelttrykkForZoom } from './dobbelttrykk.js';
import { draNedForALukke } from './dra-ned.js';
import { lagBunnoppslag, lagDybdeoppslag, naerSjoen } from './dybdeoppslag.js';
import { Fredning } from './fredning.js';
import { Gps } from './gps.js';
import { kanLeggesTil, settOppHjemskjerm, visHjemskjermVeiledning } from './hjemskjerm.js';
import { faktiskTema, hentInnstillinger, lagreInnstillinger } from './innstillinger.js';
import { Kartmarkeringer } from './kartmarkeringer.js';
import { beOmVarigLagring } from './lager.js';
import { markeringer } from './markeringer.js';
import { Markeringsark, formaterDybde } from './markeringsark.js';
import { Fangstoversikt } from './oversikt.js';
import { personer } from './personer.js';
import { dybdeFor, fangstSettinger, justeringTekst, lagJustering } from './potensialjustering.js';
import { visMelding } from './melding.js';
import { FirebaseInnlogging, FirestoreTjeneste } from './firebase.js';
import { Konto } from './konto.js';
import { Sky, synkTekst } from './sky.js';
import { TidligereFangst } from './tidligere.js';

// Området dybdedataene dekker (samme som BBOX_WGS84 i scripts/config.py).
const DATAOMRADE = L.latLngBounds([57.97, 7.65], [58.37, 8.70]);
// Skauerøya i Lillesand: før GPS-en har funnet deg, og når du er langt fra sjøen
const START = { senter: [58.2339, 8.3835], zoom: 13 };
// Er du nærmere sjøen enn dette når appen åpnes, viser kartet deg i stedet (se gps.js)
const NAER_SJOEN_M = 200;

// Kreditering for dybdedataene, nede til høyre i kartet.
const KREDITERING = '© <a href="https://www.kartverket.no/">Kartverket</a> · <strong>Ikke for navigasjon</strong>';

const innstillinger = hentInnstillinger();
const $ = (id) => document.getElementById(id);

// ---------- Kart ----------

const kart = L.map('kart', {
  zoomControl: false,        // egne, store knapper i stedet
  attributionControl: false, // legges nede til venstre under
  minZoom: 11,
  maxZoom: 19,
  maxBounds: DATAOMRADE.pad(0.1),
  maxBoundsViscosity: 0.8,
  bounceAtZoomLimits: false,
});
kart.setView(START.senter, START.zoom);
dobbelttrykkForZoom(kart); // Leaflet zoomer selv ved dobbeltklikk med mus, men ikke ved dobbelttrykk på iPhone
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(kart);
// Kreditering helt nederst, under knappene (se app.css). Leaflet er kreditert i README.
L.control.attribution({ position: 'bottomright', prefix: false }).addTo(kart);

// Hentes én gang, for kartet og GPS-en (se nederst): { grunnkart, alt }. Grunnkartet tegnes
// først, og dybdetall, bunnhint og hummerpotensial kommer etterpå (se dybdelag.js).
const dybdedata = lastDybdedata();
let dybdelag = null; // lages når dataene er lastet
let dybdeI = null;    // dybdeoppslag (lat, lon) => meter, når dataene er lastet
let bunnI = null;     // bunnoppslag (lat, lon) => bunnhint
let alleDybdedata = null; // alle dybdedataene (lastDybdedata().alt), når de er lastet
let justering = null;     // hummerpotensialet justert etter fangsten, se oppdaterJustering()

// Fredningsområder for hummer. Trykk på et område viser regler (arkene lages lenger ned).
const fredning = new Fredning(kart, (omrade) => ark.visFredning(omrade));

function oppdaterKartlag() {
  if (!dybdelag) return;
  dybdelag.settValg({
    tema: faktiskTema(innstillinger.tema),
    visDybdetall: innstillinger.dybdetall,
    visBunnhint: innstillinger.visBunnhint,
    visPotensial: innstillinger.visPotensial,
  });
  dybdelag.addTo(kart);
}

// ---------- Tema (lys/mørk) ----------

function brukTema() {
  const tema = faktiskTema(innstillinger.tema);
  document.documentElement.dataset.tema = tema;
  document.querySelector('meta[name="theme-color"]').content = tema === 'mork' ? '#07111a' : '#f4eedb';
  kart.getContainer().style.background = PALETTER[tema].bakgrunn;
  tegnTegnforklaring(tema);
  oppdaterKartlag();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (innstillinger.tema === 'auto') brukTema();
});

// ---------- GPS ----------

const gpsStatus = $('gps-status');
const gpsTekst = gpsStatus.querySelector('.tekst');

// Under GPS-statusen: anslått dybde der du er, og varsel hvis du er i et fredningsområde
let omradeHer = null;
function visDybdeHer() {
  const p = gps.posisjon;
  const dybde = p && dybdeI ? dybdeI(p.latlng.lat, p.latlng.lng) : null;
  $('dybde-her').hidden = dybde == null;
  if (dybde != null) $('dybde-her').querySelector('.tekst').textContent = `Dybde ${formaterDybde(dybde)}`;

  omradeHer = p ? fredning.omradeFor(p.latlng.lat, p.latlng.lng) : null;
  $('fredning-her').hidden = !omradeHer;
}
$('fredning-her').addEventListener('click', () => {
  if (omradeHer) ark.visFredning(omradeHer);
});

const gps = new Gps(kart, (s) => {
  if (s.type === 'posisjon') {
    const { noyaktighet, fart } = s.posisjon;
    let tekst = `± ${Math.round(noyaktighet)} m`;
    if (fart != null && fart > 0.3) tekst += ` · ${(fart * 1.943844).toFixed(1).replace('.', ',')} kn`;
    gpsTekst.textContent = tekst;
    gpsStatus.dataset.kvalitet = noyaktighet <= 15 ? 'god' : noyaktighet <= 50 ? 'middels' : 'darlig';
    visDybdeHer();
  } else if (s.type === 'feil') {
    gpsTekst.textContent = s.tekst;
    gpsStatus.dataset.kvalitet = s.kode === 3 ? 'venter' : 'feil';
  } else if (s.type === 'folg') {
    $('knapp-meg').classList.toggle('aktiv', s.folger);
    $('knapp-meg').setAttribute('aria-pressed', String(s.folger));
  }
}, (latlng) => dybdedata.grunnkart
  .then((data) => naerSjoen(data, latlng.lat, latlng.lng, NAER_SJOEN_M))
  .catch(() => false));
gps.start();

// Vis tydelig hvis posisjonen er gammel (ingen oppdatering på 30 sekunder).
setInterval(() => {
  if (!gps.posisjon || gps.erSimulert || document.hidden) return;
  if (Date.now() - gps.posisjon.tid > 30000) gpsStatus.dataset.kvalitet = 'gammel';
}, 10000);

// ---------- Knapper ----------

$('knapp-zoom-inn').addEventListener('click', () => kart.zoomIn());
$('knapp-zoom-ut').addEventListener('click', () => kart.zoomOut());
$('knapp-meg').addEventListener('click', () => {
  if (!gps.settFolg(true)) visMelding('Venter på GPS-posisjon …');
});

// ---------- Markeringer ----------

const kartmarkeringer = new Kartmarkeringer(kart, markeringer, {
  naarTrykket: (id) => ark.visMarkering(id),
  naarFlyttet: async (id, latlng) => {
    await markeringer.oppdater(id, { lat: latlng.lat, lon: latlng.lng, noyaktighet: null, kilde: 'kart' });
    ark.etterFlytt(id);
  },
});
const ark = new Markeringsark({ kart, gps, markeringer, kartmarkeringer, fredning });
kartmarkeringer.settValg({ visOpptatte: innstillinger.visOpptatte, visFangst: innstillinger.visFangst });

// Fangst fra tidligere sesonger (kartet ellers viser bare sesongen som pågår)
const tidligere = new TidligereFangst(kart, markeringer);
tidligere.settSynlig(innstillinger.visTidligere);

// Teiner og fangst lagres bare når du er logget inn. Ellers åpnes innloggingen i stedet.
// Rett etter at appen er åpnet er innloggingen ikke lest ennå (innloggingKjent).
// Til testing på PC: ?utenkonto i adressen slår sperren av, bare på localhost.
let innloggingKjent = false;
const utenKonto = location.hostname === 'localhost' && new URLSearchParams(location.search).has('utenkonto');
const medKonto = (handling) => (...args) => {
  if (sky.innlogget || utenKonto) handling(...args);
  else if (innloggingKjent) konto.vis('inn');
  else visMelding('Et øyeblikk …');
};

$('knapp-teine').addEventListener('click', medKonto(() => ark.settTeine()));
$('knapp-hummer').addEventListener('click', medKonto(() => ark.registrerFangst()));
$('knapp-teiner').addEventListener('click', () => ark.visTeineliste());

// Fangstoversikten åpnes fra teinelisten
const oversikt = new Fangstoversikt(markeringer);
$('knapp-oversikt').addEventListener('click', () => {
  $('ark-teiner').close();
  oversikt.vis();
});

// Trykk i kartet når du er zoomet langt inn: forklar bunnhintet og hummerpotensialet der.
kart.on('click', (e) => {
  if (!bunnI || kart.getZoom() < 15) return;
  const { hint, potensial } = bunnI(e.latlng.lat, e.latlng.lng);
  const deler = [];
  if (hint && innstillinger.visBunnhint) {
    const hvordan = hint.modellert ? 'modellert' : `kartlagt${hint.aar ? ` ${hint.aar}` : ''}`;
    deler.push(`${hint.navn} (${hvordan}): trolig ${hint.hard ? 'fjell og stein' : 'sand eller mudder'}`);
  }
  // Har fangsten justert potensialet her, vises det justerte anslaget og hva det bygger på
  const celle = innstillinger.visPotensial ? justering?.cellFor(e.latlng.lat, e.latlng.lng) : null;
  if (celle) {
    deler.push(justeringTekst(celle));
  } else if (potensial && innstillinger.visPotensial) {
    deler.push(`${potensial === 'hoy' ? 'Høyt' : 'Middels'} hummerpotensial (anslag ut fra dybde, helning og tare)`);
  }
  if (deler.length) visMelding(deler.join('. '), { ms: celle ? 8000 : 5000 });
});

// Langt trykk (eller høyreklikk på PC) i kartet: marker et valgfritt sted.
kart.on('contextmenu', medKonto((e) => {
  if (!kartmarkeringer.flytter) ark.visVelgType(e.latlng);
}));

// Hummerpotensialet justert etter fangsten (potensialjustering.js). Regnes ut når
// dybdedataene og fredningsområdene er lastet, når valget endres, og kort tid etter
// endringer, men bare hvis de ferdige teinesettingene er endret (å sette en teine endrer
// ingenting). Med flere års data tar det noen tidels sekunder. Bare på telefonen: den
// offentlige filen med potensialet røres ikke.
let justeringNokkel = null;
function oppdaterJustering({ tving = false } = {}) {
  if (!alleDybdedata) return;
  const settinger = innstillinger.justerPotensial ? fangstSettinger(markeringer) : null;
  const nokkel = JSON.stringify(settinger?.map((s) => [s.lat, s.lon, s.hummer, s.dogn]) ?? null);
  if (!tving && nokkel === justeringNokkel) return;
  justeringNokkel = nokkel;
  justering = settinger
    ? lagJustering(settinger, alleDybdedata, {
      iFredning: (lat, lon) => Boolean(fredning.omradeFor(lat, lon)),
      dybde: dybdeFor(alleDybdedata), // fangsten følger dybden der den ble tatt
    })
    : null;
  dybdelag?.settJustering(justering);
}
let justeringTimer = null;
markeringer.naarEndret(() => {
  clearTimeout(justeringTimer);
  justeringTimer = setTimeout(oppdaterJustering, 500);
});

// Antall teiner i sjøen vises som et merke på listeknappen.
markeringer.naarEndret(() => {
  const antall = markeringer.teinerISjoen().length;
  $('teine-antall').textContent = antall;
  $('teine-antall').hidden = antall === 0;
});

// ---------- Sikkerhetskopi ----------

// Er kontoen koblet til skyen, kopieres alt hver natt, og hver time fra 1. oktober til
// 15. desember (README, «Sikkerhetskopi»). Ellers ligger alt bare på telefonen, og «Lagre
// kopi til fil» er den eneste sikkerhetskopien. «Gjenopprett fra fil» leser inn en slik
// kopi, eller en fil fra sikkerhetskopien (gjør den klar med gjenopprett.py først).
async function lagreKopi() {
  // Navnet passer til markeringer*.geojson i .gitignore, så filen ikke havner i repoet
  const navn = `markeringer-${new Date().toISOString().slice(0, 10)}.geojson`;
  const fil = new File([JSON.stringify(markeringer.tilGeoJSON())], navn, { type: 'application/geo+json' });
  let delt = false;
  // På telefonen: delingsarket (Arkiver i Filer, e-post osv.). På PC: vanlig nedlasting.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [fil] })) {
    try {
      await navigator.share({ files: [fil], title: navn });
      delt = true;
    } catch (feil) {
      if (feil.name === 'AbortError') return; // avbrutt av brukeren
    }
  }
  if (!delt) {
    const url = URL.createObjectURL(fil);
    Object.assign(document.createElement('a'), { href: url, download: navn }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  innstillinger.sistKopi = new Date().toISOString();
  lagreInnstillinger(innstillinger);
  oppdaterDatainfo();
}

// «i dag», «i går», «for 12 dager siden» eller «aldri»
function sistKopiTekst() {
  if (!innstillinger.sistKopi) return 'aldri';
  const dag = (d) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  const dager = dag(new Date()) - dag(new Date(innstillinger.sistKopi));
  return dager <= 0 ? 'i dag' : dager === 1 ? 'i går' : `for ${dager} dager siden`;
}

async function importer(fil) {
  try {
    const r = await markeringer.importer(JSON.parse(await fil.text()));
    const ugyldige = r.ugyldige ? `, ${r.ugyldige} ugyldige hoppet over` : '';
    visMelding(`Importert: ${r.nye} nye, ${r.oppdaterte} oppdatert, ${r.uendret} uendret${ugyldige}`, { ms: 5000 });
  } catch (feil) {
    visMelding(`Kunne ikke importere: ${feil.message}`, { ms: 5000 });
  }
  oppdaterDatainfo();
}

function oppdaterDatainfo() {
  const alle = markeringer.alle();
  const fangst = alle.filter((m) => m.kategori === 'hummer').length;
  const iSjoen = markeringer.teinerISjoen().length;
  const antall = `${iSjoen} ${iSjoen === 1 ? 'teine' : 'teiner'} i sjøen og ${fangst} `
    + (fangst === 1 ? 'fangstregistrering' : 'fangstregistreringer');
  // Kopi til fil når det ikke er noen sikkerhetskopi i skyen (også utlogget, før en annen
  // konto logger inn på telefonen)
  $('knapp-lagre-kopi').hidden = sky.koblet || !alle.length;
  if (sky.koblet) {
    $('datainfo').textContent = `${antall}. ` +
      (sky.lag ? `Alt deles i laget «${sky.lag.navn}»` : 'Alt lagres i kontoen din i skyen') +
      ' og kopieres til en sikkerhetskopi hver natt, og hver time fra 1. oktober til 15. desember.';
  } else if (sky.innlogget) {
    $('datainfo').textContent = `${antall}. De ligger bare på denne telefonen, og det tas ingen ` +
      'sikkerhetskopi. Lagre en kopi til fil innimellom, eller koble kontoen til skyen (under ' +
      `Konto). Sist lagret kopi: ${sistKopiTekst()}.`;
  } else {
    $('datainfo').textContent = alle.length
      ? `${antall} ligger på telefonen. Logg inn for å lagre nye.`
      : 'Logg inn for å lagre teiner og fangst.';
  }
}

$('knapp-lagre-kopi').addEventListener('click', () => lagreKopi());
$('knapp-importer').addEventListener('click', medKonto(() => $('velg-fil').click()));
$('velg-fil').addEventListener('change', (e) => {
  const fil = e.target.files[0];
  e.target.value = ''; // så samme fil kan velges igjen
  if (fil) importer(fil);
});

// ---------- Innstillingsark ----------

const innstillingsark = $('lagvelger');
const skjema = innstillingsark.querySelector('form');

$('knapp-innstillinger').addEventListener('click', () => {
  skjema.elements.tema.value = innstillinger.tema;
  skjema.elements.dybdetall.checked = innstillinger.dybdetall;
  skjema.elements.visFangst.checked = innstillinger.visFangst;
  skjema.elements.visOpptatte.checked = innstillinger.visOpptatte;
  skjema.elements.visTidligere.checked = innstillinger.visTidligere;
  skjema.elements.visFredning.checked = innstillinger.visFredning;
  skjema.elements.visBunnhint.checked = innstillinger.visBunnhint;
  skjema.elements.visPotensial.checked = innstillinger.visPotensial;
  skjema.elements.justerPotensial.checked = innstillinger.justerPotensial;
  konto.visStatus(sky.statusTekst());
  oppdaterDatainfo();
  $('knapp-hjemskjerm').hidden = !kanLeggesTil();
  innstillingsark.showModal();
});

$('knapp-hjemskjerm').addEventListener('click', () => {
  innstillingsark.close();
  visHjemskjermVeiledning();
});

skjema.addEventListener('change', () => {
  innstillinger.tema = skjema.elements.tema.value;
  innstillinger.dybdetall = skjema.elements.dybdetall.checked;
  innstillinger.visFangst = skjema.elements.visFangst.checked;
  innstillinger.visOpptatte = skjema.elements.visOpptatte.checked;
  innstillinger.visTidligere = skjema.elements.visTidligere.checked;
  innstillinger.visFredning = skjema.elements.visFredning.checked;
  innstillinger.visBunnhint = skjema.elements.visBunnhint.checked;
  innstillinger.visPotensial = skjema.elements.visPotensial.checked;
  const justerFor = innstillinger.justerPotensial;
  innstillinger.justerPotensial = skjema.elements.justerPotensial.checked;
  lagreInnstillinger(innstillinger);
  fredning.settSynlig(innstillinger.visFredning);
  kartmarkeringer.settValg({ visOpptatte: innstillinger.visOpptatte, visFangst: innstillinger.visFangst });
  tidligere.settSynlig(innstillinger.visTidligere);
  if (innstillinger.justerPotensial !== justerFor) oppdaterJustering();
  brukTema();
});

// Trykk på den mørke bakgrunnen utenfor arket lukker det.
innstillingsark.addEventListener('click', (e) => {
  if (e.target === innstillingsark) innstillingsark.close();
});

function tegnTegnforklaring(tema) {
  const grenser = [0, ...SONEGRENSER];
  $('tegnforklaring').replaceChildren(...PALETTER[tema].soner.map((farge, i) => {
    const felt = document.createElement('span');
    felt.style.background = farge;
    felt.textContent = i < SONEGRENSER.length ? `${grenser[i]}–${grenser[i + 1]}` : `${grenser[i]}+`;
    return felt;
  }));
}

async function visKilder() {
  try {
    const kilder = await (await fetch('data/kilder.json')).json();
    const dato = (iso) => new Date(iso).toLocaleDateString('nb-NO');
    const d = kilder.dybdedata;
    const f = kilder.fredningsomrader;
    $('kildeinfo').innerHTML =
      `Dybdedata: ${d.kreditering}, <a href="${d.lisens_url}">${d.lisens}</a>, lastet ned ${dato(d.lastet_ned)}. ` +
      `${d.merknad}<br>Fredningsområder: ${f.kreditering}. Hentet ${dato(f.lastet_ned)}. ${f.merknad}` +
      (kilder.bunnhint ? `<br>Bunnhint: ${kilder.bunnhint.kreditering}.` : '') +
      (kilder.hummerpotensial ? `<br>Hummerpotensial: ${kilder.hummerpotensial.kreditering}.` : '');
  } catch {
    // Kildeteksten i index.html står igjen.
  }
}

// ---------- Konto og synkronisering med skyen ----------

// Første gang innloggingen er kjent etter at appen er åpnet: ikke logget inn → vis
// innloggingen. Ikke i nettleseren på en telefon: der vises veiledningen for hjemskjermen,
// og innloggingen skal skje i appen fra hjemskjermen (den har egen lagring).
let forsteInnlogging = true;
function sporOmInnlogging(bruker) {
  if (!forsteInnlogging) return;
  forsteInnlogging = false;
  if (bruker || kanLeggesTil()) return;
  setTimeout(() => {
    if (!sky.innlogget && !document.querySelector('dialog[open]')) konto.vis('inn');
  }, 800);
}

// Synkroniseringsknappen på kartet: vises bare når kontoen er koblet til skyen, snurrer
// mens synkroniseringen pågår, og har et merke med antall endringer som ikke er sendt (uten
// nett), eller «!» når det gikk galt. Oppdateres bare når statusen endres, så merket ikke
// blinker for hver endring som sendes med en gang.
const synkKnapp = $('knapp-synk-kart');
function visSynkKnapp(status) {
  synkKnapp.hidden = !sky.koblet;
  synkKnapp.dataset.tilstand = status.tilstand;
  const usendte = status.tilstand === 'pagar' ? 0 : sky.antallUsendte;
  const merke = synkKnapp.querySelector('.merke');
  merke.textContent = usendte || '!';
  merke.hidden = !usendte && status.tilstand !== 'feil';
  synkKnapp.setAttribute('aria-label', `Synkroniser nå. ${status.tekst}`.trim());
}

// Trykk: synkroniser nå og si hvordan det gikk (pågår det allerede, ventes det på den)
synkKnapp.addEventListener('click', async () => {
  const r = await sky.synkroniser();
  if (!r) visMelding('Uten nett. Synkroniserer når du får nett.', { ms: 4000 });
  else if (r.feil) visMelding(`Feil: ${r.feil}`, { ms: 6000, fare: true });
  else if (r.lokal) visMelding('Kontoen er koblet fra skyen. Teiner og fangst lagres bare på telefonen.', { ms: 5000 });
  else visMelding(synkTekst(r), { ms: 3000 });
});

const sky = new Sky(markeringer, {
  naarStatus: (status) => {
    konto.visStatus(status);
    visSynkKnapp(status);
    oppdaterDatainfo(); // også når kontoen er koblet til eller fra skyen
  },
  naarBruker: (bruker) => {
    innloggingKjent = true;
    personer.sett({ meg: bruker?.uid ?? null, lag: sky.lag });
    konto.visBruker(bruker);
    oppdaterDatainfo();
    sporOmInnlogging(bruker);
  },
  naarLag: (lag) => {
    personer.sett({ lag }); // kartet, listene og oversikten tegnes på nytt med eierne
    konto.visLag(lag);
  },
  innlogging: new FirebaseInnlogging(),
  tjeneste: new FirestoreTjeneste(),
});
const konto = new Konto(sky);

// Synkroniseringen med GitHub er erstattet av kontoen. Fjern den gamle tilgangsnøkkelen.
try {
  localStorage.removeItem('hummerkart.synk');
} catch {
  // Ikke tilgjengelig: da var den heller ikke lagret
}

// ---------- Uten nett og service worker ----------

// Service workeren (sw.js) lagrer appen og dataene på telefonen, så den virker uten nett.
if ('serviceWorker' in navigator) {
  const haddeVersjon = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const ny = reg.installing;
      ny?.addEventListener('statechange', () => {
        if (ny.state !== 'activated') return;
        if (haddeVersjon) {
          visMelding('Ny versjon av appen er klar', { knapp: 'Last inn', handling: () => location.reload(), ms: 15000 });
        } else {
          visMelding('Appen er lagret og virker nå uten nett', { ms: 4000 });
        }
      });
    });
  }).catch((feil) => console.error('Service worker:', feil));
}

// ---------- Oppstart ----------

// Alle arkene kan lukkes ved å dra dem ned
document.querySelectorAll('dialog.ark').forEach(draNedForALukke);

// Åpnet i nettleseren på telefonen: vis hvordan appen legges til på hjemskjermen
settOppHjemskjerm();

brukTema();
visKilder();
markeringer.last().then(() => sky.start()); // logger inn igjen, og synkroniserer hvis kontoen er koblet til skyen
fredning.last()
  .then(() => {
    fredning.settSynlig(innstillinger.visFredning);
    kartmarkeringer.iFredning = (m) => m.kategori === 'teine' && Boolean(fredning.omradeFor(m.lat, m.lon));
    kartmarkeringer.tegn();
    visDybdeHer();
    oppdaterJustering({ tving: true }); // uten ruter i fredningsområdene
  })
  .catch((feil) => console.error(feil));
beOmVarigLagring(); // be nettleseren ikke slette appen og dataene ved lite plass

dybdedata.grunnkart
  .then((data) => {
    dybdelag = new Dybdelag(data, {
      bounds: DATAOMRADE,
      attribution: KREDITERING,
    });
    oppdaterKartlag();
  })
  .catch((feil) => {
    console.error(feil);
    visMelding('Klarte ikke å laste dybdekartet', { ms: 6000 });
  })
  .finally(() => {
    $('laster').hidden = true;
  });

// Dybdeoppslaget venter på dybdetallene, ellers ville teinene fått dybden midt i sonen.
dybdedata.alt
  .then((data) => {
    dybdelag?.settData(data);
    dybdeI = lagDybdeoppslag(data);
    bunnI = lagBunnoppslag(data);
    markeringer.settDybdeoppslag(dybdeI);
    visDybdeHer();
    alleDybdedata = data;
    oppdaterJustering({ tving: true });
  })
  .catch((feil) => {
    console.error(feil);
    if (dybdelag) visMelding('Klarte ikke å laste dybdetallene', { ms: 6000 });
  });
