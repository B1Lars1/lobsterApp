/*
 * Hummerkart – hovedfil. Setter opp kartet, kartlagene, GPS-en, knappene og
 * innstillingsarket, og kobler sammen modulene:
 *   dybdelag.js        dybdekartet
 *   gps.js             posisjonen din
 *   markeringer.js     teiner og fangst (data, lagring, GeoJSON)
 *   kartmarkeringer.js symbolene på kartet
 *   markeringsark.js   knappene og arkene for markeringer
 *
 * Leaflet (globalt objekt «L») lastes som vanlig <script> i index.html før denne filen.
 */

import { Dybdelag, PALETTER, SONEGRENSER, lastDybdedata } from './dybdelag.js';
import { lagDybdeoppslag } from './dybdeoppslag.js';
import { Gps } from './gps.js';
import { faktiskTema, hentInnstillinger, lagreInnstillinger } from './innstillinger.js';
import { Kartmarkeringer } from './kartmarkeringer.js';
import { beOmVarigLagring } from './lager.js';
import { markeringer } from './markeringer.js';
import { Markeringsark, formaterDybde } from './markeringsark.js';
import { visMelding } from './melding.js';

// Området dybdedataene dekker (samme som BBOX_WGS84 i scripts/config.py).
const DATAOMRADE = L.latLngBounds([58.17, 8.28], [58.29, 8.52]);

// Samme tekst på alle lag, så Leaflet viser krediteringen bare én gang.
const KREDITERING = '© <a href="https://www.kartverket.no/">Kartverket</a> · <strong>Ikke for navigasjon</strong>';

const innstillinger = hentInnstillinger();
const $ = (id) => document.getElementById(id);

// ---------- Kart ----------

const kart = L.map('kart', {
  zoomControl: false,        // egne, store knapper i stedet
  attributionControl: false, // legges nede til venstre under
  minZoom: 12,
  maxZoom: 19,
  maxBounds: DATAOMRADE.pad(0.3),
  maxBoundsViscosity: 0.8,
  bounceAtZoomLimits: false,
});
kart.fitBounds(DATAOMRADE);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(kart);
L.control.attribution({ position: 'bottomleft', prefix: '<a href="https://leafletjs.com">Leaflet</a>' }).addTo(kart);

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
  sjokart: kartverketLag('sjokartraster', 17),
};

let dybdelag = null; // lages når dataene er lastet
let dybdeI = null;    // dybdeoppslag (lat, lon) => meter, når dataene er lastet

function oppdaterKartlag() {
  for (const [navn, lag] of Object.entries(bakgrunnskart)) {
    if (navn === innstillinger.bakgrunn) lag.addTo(kart);
    else lag.remove();
  }
  if (!dybdelag) return;
  if (innstillinger.bakgrunn === 'sjokart') {
    dybdelag.remove(); // sjøkartet har egne dybder
    return;
  }
  dybdelag.settValg({
    tema: faktiskTema(innstillinger.tema),
    visLand: innstillinger.bakgrunn === 'dybde',
    visDybdetall: innstillinger.dybdetall,
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

// Anslått dybde der du er, under GPS-statusen
function visDybdeHer() {
  const p = gps.posisjon;
  const dybde = p && dybdeI ? dybdeI(p.latlng.lat, p.latlng.lng) : null;
  $('dybde-her').hidden = dybde == null;
  if (dybde != null) $('dybde-her').querySelector('.tekst').textContent = `Dybde ${formaterDybde(dybde)}`;
}

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
  naarFlyttet: (id, latlng) => markeringer.oppdater(id, {
    lat: latlng.lat, lon: latlng.lng, noyaktighet: null, kilde: 'kart',
  }),
});
const ark = new Markeringsark({ kart, gps, markeringer, kartmarkeringer });
kartmarkeringer.settValg({ visOpptatte: innstillinger.visOpptatte, visFangst: innstillinger.visFangst });

$('knapp-teine').addEventListener('click', () => ark.settTeine());
$('knapp-hummer').addEventListener('click', () => ark.registrerFangst());
$('knapp-teiner').addEventListener('click', () => ark.visTeineliste());

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
    (varigLagring ? 'Nettleseren har lovet varig lagring.' : 'Nettleseren kan slette data ved lite plass, så eksporter jevnlig.');
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
  oppdaterDatainfo();
  innstillingsark.showModal();
});

skjema.addEventListener('change', () => {
  innstillinger.bakgrunn = skjema.elements.bakgrunn.value;
  innstillinger.tema = skjema.elements.tema.value;
  innstillinger.dybdetall = skjema.elements.dybdetall.checked;
  innstillinger.visFangst = skjema.elements.visFangst.checked;
  innstillinger.visOpptatte = skjema.elements.visOpptatte.checked;
  lagreInnstillinger(innstillinger);
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
    const d = kilder.dybdedata;
    const dato = new Date(d.lastet_ned).toLocaleDateString('nb-NO');
    $('kildeinfo').innerHTML =
      `Dybdedata: ${d.kreditering}, <a href="${d.lisens_url}">${d.lisens}</a>, lastet ned ${dato}. ` +
      `${d.merknad}`;
  } catch {
    // Kildeteksten i index.html står igjen.
  }
}

// ---------- Oppstart ----------

brukTema();
visKilder();
markeringer.last();
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
