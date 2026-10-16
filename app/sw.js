/*
 * Service worker: lagrer appen og alle kartdataene på telefonen, så den virker uten nett.
 *
 * - Første gang appen åpnes med nett, lagres alle filene i FILER.
 * - Deretter hentes de alltid fra telefonen, uten nett også.
 * - Når VERSJON endres (ny versjon publisert), lastes alt ned på nytt neste gang
 *   appen åpnes med nett, og appen sier fra at den kan lastes inn på nytt.
 * - På localhost hentes filene fra serveren først, så endringer vises med en gang
 *   når du utvikler. Lagret versjon brukes bare hvis serveren ikke svarer.
 *
 * VERSJON og FILER fylles inn av scripts/lag_service_worker.py. Ikke endre dem for hånd.
 */

// <generert av scripts/lag_service_worker.py>
const VERSJON = '980f93233fb5';
const FILER = [
  './',
  'css/app.css',
  'data/bunnhint.geojson',
  'data/dybdeareal.geojson',
  'data/dybdekurver.geojson',
  'data/dybdetall.geojson',
  'data/fredningsomrader.geojson',
  'data/hummerpotensial.geojson',
  'data/kilder.json',
  'data/kurveetiketter.geojson',
  'data/land.geojson',
  'data/stedsnavn.geojson',
  'data/tarekant.geojson',
  'ikoner/apple-touch-icon.png',
  'ikoner/favicon-32.png',
  'ikoner/ikon-192.png',
  'ikoner/ikon-512.png',
  'ikoner/ikon-maskable-512.png',
  'ikoner/teine-opptatt.svg',
  'ikoner/teine.svg',
  'index.html',
  'js/app.js',
  'js/dobbelttrykk.js',
  'js/dra-ned.js',
  'js/dybdelag.js',
  'js/dybdeoppslag.js',
  'js/firebase.js',
  'js/fredning.js',
  'js/gps.js',
  'js/hjemskjerm.js',
  'js/innstillinger.js',
  'js/kartmarkeringer.js',
  'js/konto.js',
  'js/lager.js',
  'js/markeringer.js',
  'js/markeringsark.js',
  'js/melding.js',
  'js/oversikt.js',
  'js/personer.js',
  'js/sky.js',
  'manifest.webmanifest',
  'personvern.html',
  'vendor/firebase-12.19.0/firebase-app.js',
  'vendor/firebase-12.19.0/firebase-auth.js',
  'vendor/firebase-12.19.0/firebase-firestore-lite.js',
  'vendor/leaflet-1.9.4/images/layers-2x.png',
  'vendor/leaflet-1.9.4/images/layers.png',
  'vendor/leaflet-1.9.4/images/marker-icon-2x.png',
  'vendor/leaflet-1.9.4/images/marker-icon.png',
  'vendor/leaflet-1.9.4/images/marker-shadow.png',
  'vendor/leaflet-1.9.4/leaflet.css',
  'vendor/leaflet-1.9.4/leaflet.js'
];
// </generert>

const CACHE = `hummerkart-${VERSJON}`;
const UTVIKLING = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', (hendelse) => {
  hendelse.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' sørger for ferske filer, ikke gamle kopier fra nettleserens buffer
    await cache.addAll(FILER.map((fil) => new Request(fil, { cache: 'reload' })));
    await self.skipWaiting(); // ta i bruk den nye versjonen med en gang
  })());
});

self.addEventListener('activate', (hendelse) => {
  hendelse.waitUntil((async () => {
    // Slett lagrede filer fra tidligere versjoner
    for (const navn of await caches.keys()) {
      if (navn.startsWith('hummerkart-') && navn !== CACHE) await caches.delete(navn);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (hendelse) => {
  const foresporsel = hendelse.request;
  const url = new URL(foresporsel.url);
  // Bare appens egne filer. Firebase og lignende går rett til nettet.
  if (foresporsel.method !== 'GET' || url.origin !== self.location.origin) return;

  hendelse.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch: «?simuler=…» og lignende skal treffe samme lagrede side
    const lagret = () => cache.match(foresporsel, { ignoreSearch: true });

    if (UTVIKLING) {
      try {
        return await fetch(foresporsel);
      } catch {
        return (await lagret()) || Response.error();
      }
    }
    return (await lagret()) || fetch(foresporsel);
  })());
});
