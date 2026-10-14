/*
 * Hummerkart – hovedfil. Setter opp kartet, kartlagene, GPS-en, knappene og
 * innstillingsarket, og kobler sammen modulene:
 *   dybdelag.js        dybdekartet
 *   gps.js             posisjonen din
 *   markeringer.js     teiner og fangst (data, lagring, GeoJSON)
 *   kartmarkeringer.js symbolene på kartet
 *   markeringsark.js   knappene og arkene for markeringer
 *   fredning.js        fredningsområder for hummer
 *   synk.js            synkronisering med et privat GitHub-repo
 *   hjemskjerm.js      veiledning for å legge appen til på hjemskjermen
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
import { visMelding } from './melding.js';
import { Synk, hentSynkOppsett } from './synk.js';

// Området dybdedataene dekker (samme som BBOX_WGS84 i scripts/config.py).
const DATAOMRADE = L.latLngBounds([58.08, 8.08], [58.37, 8.70]);
const START = { senter: [58.235, 8.39], zoom: 12 }; // Lillesand, før GPS-en har funnet deg

// Samme tekst på alle lag, så Leaflet viser krediteringen bare én gang.
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

// Bakgrunnskart fra Kartverket (krever nett). Lagnavnene er hentet fra
// https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml
function kartverketLag(lag, maxNativeZoom) {
  return L.tileLayer(
    `https://cache.kartverket.no/v1/wmts/1.0.0/${lag}/default/webmercator/{z}/{y}/{x}.png`,
    {
      maxNativeZoom,
      maxZoom: 19,
      className: 'raster-fliser',
      attribution: KREDITERING,
    },
  );
}
const bakgrunnskart = {
  topo: kartverketLag('topograatone', 18),
};

let dybdelag = null; // lages når dataene er lastet
let dybdeI = null;    // dybdeoppslag (lat, lon) => meter, når dataene er lastet
let bunnI = null;     // bunnoppslag (lat, lon) => bunnhint

// Fredningsområder for hummer. Trykk på et område viser regler (arkene lages lenger ned).
const fredning = new Fredning(kart, (omrade) => ark.visFredning(omrade));

// Uten nett kan ikke Kartverkets kart hentes, så da vises dybdekartet (som er lagret).
const aktivBakgrunn = () => (navigator.onLine ? innstillinger.bakgrunn : 'dybde');

function oppdaterKartlag() {
  const bakgrunn = aktivBakgrunn();
  for (const [navn, lag] of Object.entries(bakgrunnskart)) {
    if (navn === bakgrunn) lag.addTo(kart);
    else lag.remove();
  }
  if (!dybdelag) return;
  dybdelag.settValg({
    tema: faktiskTema(innstillinger.tema),
    visLand: bakgrunn === 'dybde',
    visDybdetall: innstillinger.dybdetall,
    visBunnhint: innstillinger.visBunnhint,
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

$('knapp-teine').addEventListener('click', () => ark.settTeine());
$('knapp-hummer').addEventListener('click', () => ark.registrerFangst());
$('knapp-teiner').addEventListener('click', () => ark.visTeineliste());

// Trykk i kartet når du er zoomet langt inn: forklar bunnhintet der.
kart.on('click', (e) => {
  if (!bunnI || !innstillinger.visBunnhint || kart.getZoom() < 15) return;
  const { hint } = bunnI(e.latlng.lat, e.latlng.lng);
  if (!hint) return;
  const hvordan = hint.modellert ? 'modellert' : `kartlagt${hint.aar ? ` ${hint.aar}` : ''}`;
  visMelding(`${hint.navn} (${hvordan}): trolig ${hint.hard ? 'fjell og stein' : 'sand eller mudder'}`, { ms: 5000 });
});

// Langt trykk (eller høyreklikk på PC) i kartet: marker et valgfritt sted.
kart.on('contextmenu', (e) => {
  if (!kartmarkeringer.flytter) ark.visVelgType(e.latlng);
});

// Antall teiner i sjøen vises som et merke på listeknappen.
markeringer.naarEndret(() => {
  const antall = markeringer.teinerISjoen().length;
  $('teine-antall').textContent = antall;
  $('teine-antall').hidden = antall === 0;
});

// ---------- Sikkerhetskopi: eksport og import av GeoJSON ----------

let varigLagring = false;

async function eksporter() {
  const navn = `markeringer-${new Date().toISOString().slice(0, 10)}.geojson`;
  const fil = new File([JSON.stringify(markeringer.tilGeoJSON(), null, 1)], navn, { type: 'application/geo+json' });
  let delt = false;
  // På telefonen: «Del» (lagre i Filer, send på e-post osv.). På PC: vanlig nedlasting.
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
  innstillinger.sistEksportert = new Date().toISOString();
  lagreInnstillinger(innstillinger);
  oppdaterDatainfo();
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
  const eksport = innstillinger.sistEksportert
    ? new Date(innstillinger.sistEksportert).toLocaleDateString('nb-NO') : 'aldri';
  $('datainfo').textContent =
    `${markeringer.teinerISjoen().length} teiner i sjøen og ${fangst} fangstregistreringer ` +
    `(${alle.length} markeringer i alt). Sist eksportert: ${eksport}. ` +
    (varigLagring ? 'Nettleseren har lovet varig lagring.' : 'Nettleseren kan slette data ved lite plass.') +
    (synk.erSattOpp() ? ' Markeringene synkroniseres med GitHub.' : ' Eksporter jevnlig, eller sett opp synkronisering med GitHub.');
}

$('knapp-eksporter').addEventListener('click', () => eksporter());
$('knapp-importer').addEventListener('click', () => $('velg-fil').click());
$('velg-fil').addEventListener('change', (e) => {
  const fil = e.target.files[0];
  e.target.value = ''; // så samme fil kan velges igjen
  if (fil) importer(fil);
});

// ---------- Innstillingsark ----------

const innstillingsark = $('lagvelger');
const skjema = innstillingsark.querySelector('form');

$('knapp-lag').addEventListener('click', () => {
  skjema.elements.bakgrunn.value = innstillinger.bakgrunn;
  skjema.elements.tema.value = innstillinger.tema;
  skjema.elements.dybdetall.checked = innstillinger.dybdetall;
  skjema.elements.visFangst.checked = innstillinger.visFangst;
  skjema.elements.visOpptatte.checked = innstillinger.visOpptatte;
  skjema.elements.visFredning.checked = innstillinger.visFredning;
  skjema.elements.visBunnhint.checked = innstillinger.visBunnhint;
  const synkOppsett = hentSynkOppsett();
  skjema.elements.synkRepo.value = synkOppsett.repo || '';
  skjema.elements.synkToken.value = synkOppsett.token || '';
  visSynkStatus(synk.statusTekst());
  oppdaterDatainfo();
  $('knapp-hjemskjerm').hidden = !kanLeggesTil();
  innstillingsark.showModal();
});

$('knapp-hjemskjerm').addEventListener('click', () => {
  innstillingsark.close();
  visHjemskjermVeiledning();
});

skjema.addEventListener('change', (e) => {
  if (e.target.closest('.synk')) return; // feltene for synkronisering har egne knapper
  innstillinger.bakgrunn = skjema.elements.bakgrunn.value;
  innstillinger.tema = skjema.elements.tema.value;
  innstillinger.dybdetall = skjema.elements.dybdetall.checked;
  innstillinger.visFangst = skjema.elements.visFangst.checked;
  innstillinger.visOpptatte = skjema.elements.visOpptatte.checked;
  innstillinger.visFredning = skjema.elements.visFredning.checked;
  innstillinger.visBunnhint = skjema.elements.visBunnhint.checked;
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
      (kilder.bunnhint ? `<br>Bunnhint: ${kilder.bunnhint.kreditering}.` : '');
  } catch {
    // Kildeteksten i index.html står igjen.
  }
}

// ---------- Synkronisering med GitHub ----------

function visSynkStatus({ tilstand, tekst }) {
  $('synkstatus').textContent = tekst;
  $('synkstatus').dataset.tilstand = tilstand;
}
const synk = new Synk(markeringer, visSynkStatus);

$('knapp-synk').addEventListener('click', () => {
  const repo = skjema.elements.synkRepo.value.trim();
  const token = skjema.elements.synkToken.value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    visMelding('Skriv repoet som brukernavn/reponavn', { fare: true });
    return;
  }
  if (!token) {
    visMelding('Lim inn tilgangsnøkkelen', { fare: true });
    return;
  }
  synk.settOppsett({ repo, token });
  synk.synkroniser({ manuell: true });
});

$('knapp-synk-av').addEventListener('click', () => {
  synk.kobleFra();
  skjema.elements.synkRepo.value = '';
  skjema.elements.synkToken.value = '';
  visMelding('Synkronisering er koblet fra. Markeringene på telefonen er urørt.');
});

// ---------- Uten nett og service worker ----------

window.addEventListener('offline', () => {
  if (innstillinger.bakgrunn !== 'dybde') visMelding('Uten nett: viser dybdekartet', { ms: 4000 });
  oppdaterKartlag();
});
window.addEventListener('online', () => oppdaterKartlag());

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
markeringer.last().then(() => synk.synkroniser());
fredning.last()
  .then(() => {
    fredning.settSynlig(innstillinger.visFredning);
    kartmarkeringer.iFredning = (m) => m.kategori === 'teine' && Boolean(fredning.omradeFor(m.lat, m.lon));
    kartmarkeringer.tegn();
    visDybdeHer();
  })
  .catch((feil) => console.error(feil));
beOmVarigLagring().then((varig) => {
  varigLagring = varig;
});

lastDybdedata()
  .then((data) => {
    dybdelag = new Dybdelag(data, {
      bounds: DATAOMRADE,
      zIndex: 5, // over Kartverkets bakgrunnskart
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
