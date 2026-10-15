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
 *
 * Leaflet (globalt objekt «L») lastes som vanlig <script> i index.html før denne filen.
 */

import { Dybdelag, PALETTER, SONEGRENSER, lastDybdedata } from './dybdelag.js';
import { dobbelttrykkForZoom } from './dobbelttrykk.js';
import { draNedForALukke } from './dra-ned.js';
import { lagBunnoppslag, lagDybdeoppslag } from './dybdeoppslag.js';
import { Fredning } from './fredning.js';
import { Gps } from './gps.js';
import { kanLeggesTil, settOppHjemskjerm, visHjemskjermVeiledning } from './hjemskjerm.js';
import { faktiskTema, hentInnstillinger, lagreInnstillinger } from './innstillinger.js';
import { Kartmarkeringer } from './kartmarkeringer.js';
import { beOmVarigLagring } from './lager.js';
import { markeringer } from './markeringer.js';
import { Markeringsark, formaterDybde } from './markeringsark.js';
import { Fangstoversikt } from './oversikt.js';
import { visMelding } from './melding.js';
import { FirebaseInnlogging, FirestoreTjeneste } from './firebase.js';
import { Konto } from './konto.js';
import { Sky } from './sky.js';

// Området dybdedataene dekker (samme som BBOX_WGS84 i scripts/config.py).
const DATAOMRADE = L.latLngBounds([57.97, 7.65], [58.37, 8.70]); // samme som BBOX_WGS84 i scripts/config.py
const START = { senter: [58.235, 8.39], zoom: 12 }; // Lillesand, før GPS-en har funnet deg

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

let dybdelag = null; // lages når dataene er lastet
let dybdeI = null;    // dybdeoppslag (lat, lon) => meter, når dataene er lastet
let bunnI = null;     // bunnoppslag (lat, lon) => bunnhint

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
});
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
  if (potensial && innstillinger.visPotensial) {
    deler.push(`${potensial === 'hoy' ? 'Høyt' : 'Middels'} hummerpotensial (anslag ut fra dybde, helning og tare)`);
  }
  if (deler.length) visMelding(deler.join('. '), { ms: 5000 });
});

// Langt trykk (eller høyreklikk på PC) i kartet: marker et valgfritt sted.
kart.on('contextmenu', medKonto((e) => {
  if (!kartmarkeringer.flytter) ark.visVelgType(e.latlng);
}));

// Antall teiner i sjøen vises som et merke på listeknappen.
markeringer.naarEndret(() => {
  const antall = markeringer.teinerISjoen().length;
  $('teine-antall').textContent = antall;
  $('teine-antall').hidden = antall === 0;
});

// ---------- Sikkerhetskopi ----------

// Alt lagres i kontoen og kopieres hver natt (README, «Sikkerhetskopi»). «Gjenopprett fra
// fil» leser inn en fil fra sikkerhetskopien (gjør den klar med gjenopprett.py først).
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
  if (!sky.innlogget) {
    $('datainfo').textContent = 'Logg inn for å lagre teiner og fangst.';
    return;
  }
  const fangst = markeringer.alle().filter((m) => m.kategori === 'hummer').length;
  $('datainfo').textContent =
    `${markeringer.teinerISjoen().length} teiner i sjøen og ${fangst} fangstregistreringer. ` +
    (sky.lag ? `Alt deles i laget «${sky.lag.navn}»` : 'Alt lagres i kontoen din') +
    ' og kopieres hver natt til en sikkerhetskopi.';
}

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
  skjema.elements.visFredning.checked = innstillinger.visFredning;
  skjema.elements.visBunnhint.checked = innstillinger.visBunnhint;
  skjema.elements.visPotensial.checked = innstillinger.visPotensial;
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
  innstillinger.visFredning = skjema.elements.visFredning.checked;
  innstillinger.visBunnhint = skjema.elements.visBunnhint.checked;
  innstillinger.visPotensial = skjema.elements.visPotensial.checked;
  lagreInnstillinger(innstillinger);
  fredning.settSynlig(innstillinger.visFredning);
  kartmarkeringer.settValg({ visOpptatte: innstillinger.visOpptatte, visFangst: innstillinger.visFangst });
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

const sky = new Sky(markeringer, {
  naarStatus: (status) => konto.visStatus(status),
  naarBruker: (bruker) => {
    innloggingKjent = true;
    konto.visBruker(bruker);
    oppdaterDatainfo();
    sporOmInnlogging(bruker);
  },
  naarLag: (lag) => konto.visLag(lag),
  innlogging: new FirebaseInnlogging(),
  tjeneste: new FirestoreTjeneste(),
});
const konto = new Konto(sky);
ark.hvem = (uid) => sky.navnFor(uid); // «av ola» på det andre i laget har registrert

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
markeringer.last().then(() => sky.start()); // logger inn igjen og synkroniserer hvis du har konto
fredning.last()
  .then(() => {
    fredning.settSynlig(innstillinger.visFredning);
    kartmarkeringer.iFredning = (m) => m.kategori === 'teine' && Boolean(fredning.omradeFor(m.lat, m.lon));
    kartmarkeringer.tegn();
    visDybdeHer();
  })
  .catch((feil) => console.error(feil));
beOmVarigLagring(); // be nettleseren ikke slette appen og dataene ved lite plass

lastDybdedata()
  .then((data) => {
    dybdelag = new Dybdelag(data, {
      bounds: DATAOMRADE,
      attribution: KREDITERING,
    });
    oppdaterKartlag();
    dybdeI = lagDybdeoppslag(data);
    bunnI = lagBunnoppslag(data);
    markeringer.settDybdeoppslag(dybdeI);
    visDybdeHer();
  })
  .catch((feil) => {
    console.error(feil);
    visMelding('Klarte ikke å laste dybdekartet', { ms: 6000 });
  })
  .finally(() => {
    $('laster').hidden = true;
  });
