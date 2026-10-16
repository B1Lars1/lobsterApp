/*
 * Service worker: lagrer appen og alle kartdataene på telefonen, så den virker uten nett.
 *
 * - Første gang appen åpnes med nett, lagres alle filene i FILER.
 * - Deretter hentes de alltid fra telefonen, uten nett også.
 * - Når VERSJON endres (ny versjon publisert), lagres den nye versjonen neste gang
 *   appen åpnes med nett, og appen sier fra at den kan lastes inn på nytt. Bare filene
 *   som er endret, lastes ned. Resten (som de 40 MB med kartdata) kopieres fra forrige
 *   versjon på telefonen, ut fra sjekksummen hver fil har i FILER.
 * - Hver fil som lastes ned, sjekkes mot sjekksummen. Stemmer den ikke (en gammel kopi
 *   underveis i en publisering), avbrytes installeringen og prøves igjen senere, så en
 *   feil fil aldri blir kopiert videre til neste versjon.
 * - På localhost hentes filene fra serveren først, så endringer vises med en gang
 *   når du utvikler. Lagret versjon brukes bare hvis serveren ikke svarer.
 *
 * VERSJON og FILER fylles inn av scripts/lag_service_worker.py. Ikke endre dem for hånd.
 */

// <generert av scripts/lag_service_worker.py>
const VERSJON = '8f3dfa3a3626';
// Fil → sjekksum. Filer med samme sjekksum som i forrige versjon kopieres fra telefonen.
const FILER = {
  './': '9d188c11c32c',
  'css/app.css': '9cd59d25a8e6',
  'data/bunnhint.geojson': '7dff6ecb1079',
  'data/dybdeareal.geojson': 'dfaa36d0802f',
  'data/dybdekurver.geojson': '35043cb8406f',
  'data/dybdetall.geojson': '7df2bb9ed855',
  'data/fredningsomrader.geojson': '38942d10a30d',
  'data/hummerpotensial.geojson': '8955665326b0',
  'data/kilder.json': '38acc52abbb0',
  'data/kurveetiketter.geojson': 'd63200ba45b9',
  'data/land.geojson': 'aebf9580b0bc',
  'data/stedsnavn.geojson': 'ba8f8284ee4e',
  'data/tarekant.geojson': '6b1cd0891462',
  'ikoner/apple-touch-icon.png': '8b471f3fa70f',
  'ikoner/favicon-32.png': 'c707511f30c1',
  'ikoner/ikon-192.png': 'f0dcb9a49eb9',
  'ikoner/ikon-512.png': 'dd106a5cd7a2',
  'ikoner/ikon-maskable-512.png': '1d78cbc5ffe9',
  'ikoner/teine-opptatt.svg': '9eee59c46144',
  'ikoner/teine.svg': 'cee886a00886',
  'index.html': '9d188c11c32c',
  'js/app.js': '6cdd31fd0361',
  'js/dobbelttrykk.js': '0a34a6673128',
  'js/dra-ned.js': '39c76367ab2f',
  'js/dybdelag.js': '7ac35d895f1f',
  'js/dybdeoppslag.js': '443fbeec51c7',
  'js/firebase.js': '1e828d2e105b',
  'js/fredning.js': 'a01071ad418e',
  'js/gps.js': '4a09b6aae3f5',
  'js/hjemskjerm.js': '0b74cec06010',
  'js/innstillinger.js': '3478d31ae64b',
  'js/kartmarkeringer.js': '199420a49f22',
  'js/konto.js': 'd4d1a483fc94',
  'js/lager.js': 'aff648d08146',
  'js/markeringer.js': 'ad5d55f50c43',
  'js/markeringsark.js': '4b534ad381c6',
  'js/melding.js': '612e55afbbb0',
  'js/oversikt.js': '6978b8c38091',
  'js/personer.js': '8b4e2a71e414',
  'js/sky.js': '5e224d2b1950',
  'js/tema.js': '665d59d8188a',
  'manifest.webmanifest': '19e7beb80bc1',
  'personvern.html': '417addf0805d',
  'vendor/firebase-12.19.0/firebase-app.js': '39a50952b5de',
  'vendor/firebase-12.19.0/firebase-auth.js': '0f99fc82c189',
  'vendor/firebase-12.19.0/firebase-firestore-lite.js': 'bb91d6218384',
  'vendor/leaflet-1.9.4/leaflet.css': '337bfca5cabd',
  'vendor/leaflet-1.9.4/leaflet.js': 'db49d009c841'
};
// </generert>

const CACHE = `hummerkart-${VERSJON}`;
const UTVIKLING = ['localhost', '127.0.0.1'].includes(self.location.hostname);
// Sjekksummene til filene i et lager, så neste versjon vet hvilke den kan kopiere
const SJEKKSUMMER = '__sjekksummer.json';

// SHA-256 av innholdet, de 12 første tegnene (som i lag_service_worker.py)
async function sjekksum(svar) {
  const digest = await crypto.subtle.digest('SHA-256', await svar.clone().arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Lageret til forrige versjon og sjekksummene der, eller null (første gang, eller en
// versjon fra før det fantes sjekksummer)
async function forrigeVersjon() {
  for (const navn of await caches.keys()) {
    if (!navn.startsWith('hummerkart-') || navn === CACHE) continue;
    const lager = await caches.open(navn);
    const liste = await lager.match(SJEKKSUMMER);
    if (liste) return { lager, sjekksummer: await liste.json() };
  }
  return null;
}

self.addEventListener('install', (hendelse) => {
  hendelse.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const forrige = await forrigeVersjon();
    try {
      await Promise.all(Object.entries(FILER).map(async ([fil, sum]) => {
        if (forrige?.sjekksummer[fil] === sum) {
          const lagret = await forrige.lager.match(fil);
          if (lagret) return cache.put(fil, lagret); // uendret: ingen nedlasting
        }
        // cache: 'reload' sørger for ferske filer, ikke gamle kopier fra nettleserens buffer
        const svar = await fetch(new Request(fil, { cache: 'reload' }));
        if (!svar.ok) throw new Error(`Klarte ikke å hente ${fil} (${svar.status})`);
        // På localhost kan filene ha Windows-linjeskift, så sjekksummen stemmer ikke der
        if (!UTVIKLING && (await sjekksum(svar)) !== sum) throw new Error(`${fil} har feil innhold`);
        return cache.put(fil, svar);
      }));
    } catch (feil) {
      await caches.delete(CACHE); // ikke la et halvferdig lager ta plass på telefonen
      throw feil; // installeringen prøves igjen neste gang appen åpnes med nett
    }
    await cache.put(SJEKKSUMMER, new Response(JSON.stringify(FILER)));
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
