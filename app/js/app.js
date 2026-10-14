/*
 * Hummerkart – hovedfil. Setter opp kartet, kartlagene, GPS-en, knappene og
 * innstillingsarket. Selve dybdekartet tegnes i dybdelag.js, GPS-en ligger i gps.js.
 *
 * Leaflet (globalt objekt «L») lastes som vanlig <script> i index.html før denne filen.
 */

import { Dybdelag, PALETTER, SONEGRENSER, lastDybdedata } from './dybdelag.js';
import { Gps } from './gps.js';
import { faktiskTema, hentInnstillinger, lagreInnstillinger } from './innstillinger.js';

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

// ---------- Meldinger ----------

let meldingTimer;
function visMelding(tekst, ms = 2500) {
  const m = $('melding');
  m.textContent = tekst;
  m.classList.add('vis');
  clearTimeout(meldingTimer);
  meldingTimer = setTimeout(() => m.classList.remove('vis'), ms);
}

// ---------- GPS ----------

const gpsStatus = $('gps-status');
const gpsTekst = gpsStatus.querySelector('.tekst');

const gps = new Gps(kart, (s) => {
  if (s.type === 'posisjon') {
    const { noyaktighet, fart } = s.posisjon;
    let tekst = `± ${Math.round(noyaktighet)} m`;
    if (fart != null && fart > 0.3) tekst += ` · ${(fart * 1.943844).toFixed(1).replace('.', ',')} kn`;
    gpsTekst.textContent = tekst;
    gpsStatus.dataset.kvalitet = noyaktighet <= 15 ? 'god' : noyaktighet <= 50 ? 'middels' : 'darlig';
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

// Markeringer kommer i fase 4.
for (const id of ['knapp-teine', 'knapp-hummer']) {
  $(id).addEventListener('click', () => visMelding('Markering kommer i neste versjon'));
}

// ---------- Innstillingsark ----------

const ark = $('lagvelger');
const skjema = ark.querySelector('form');

$('knapp-lag').addEventListener('click', () => {
  skjema.elements.bakgrunn.value = innstillinger.bakgrunn;
  skjema.elements.tema.value = innstillinger.tema;
  skjema.elements.dybdetall.checked = innstillinger.dybdetall;
  ark.showModal();
});

skjema.addEventListener('change', () => {
  innstillinger.bakgrunn = skjema.elements.bakgrunn.value;
  innstillinger.tema = skjema.elements.tema.value;
  innstillinger.dybdetall = skjema.elements.dybdetall.checked;
  lagreInnstillinger(innstillinger);
  brukTema();
});

// Trykk på den mørke bakgrunnen utenfor arket lukker det.
ark.addEventListener('click', (e) => {
  if (e.target === ark) ark.close();
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

lastDybdedata()
  .then((data) => {
    dybdelag = new Dybdelag(data, {
      bounds: DATAOMRADE,
      zIndex: 5, // over Kartverkets bakgrunnskart
      attribution: KREDITERING,
    });
    oppdaterKartlag();
  })
  .catch((feil) => {
    console.error(feil);
    visMelding('Klarte ikke å laste dybdekartet', 6000);
  })
  .finally(() => {
    $('laster').hidden = true;
  });
