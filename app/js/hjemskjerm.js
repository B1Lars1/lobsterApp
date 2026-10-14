/*
 * Veiledning for å legge appen til på hjemskjermen.
 *
 * Åpnes siden i nettleseren på en telefon (ikke fra hjemskjermen), vises et ark med
 * fremgangsmåten for iPhone eller Android:
 *   - Android (Chrome): nettleseren kan installere appen direkte. Chrome sender
 *     «beforeinstallprompt», og knappen «Installer appen» åpner Chromes eget vindu.
 *   - iPhone: en nettside kan ikke installere seg selv, så arket viser veien via
 *     Del-knappen i Safari. iPhone-appen fra hjemskjermen har egen lagring, atskilt
 *     fra Safari, så arket sier også fra om det.
 * Lukkes arket, vises det ikke av seg selv igjen på en uke. Det kan også åpnes fra
 * innstillingsarket.
 */

const NOKKEL = 'hummerkart.hjemskjerm';
const VIS_IGJEN_ETTER_MS = 7 * 24 * 60 * 60 * 1000;
const VENT_FOR_VISNING_MS = 1500; // la kartet komme opp først

/** True når appen er åpnet fra hjemskjermen (som app), ikke i nettleseren. */
export const erIApp = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** 'iphone', 'android' eller null (PC). iPad oppgir seg som Mac, men har berøringsskjerm. */
export function telefontype() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  return null;
}

/** Skal knappen i innstillingsarket vises? */
export const kanLeggesTil = () => !erIApp() && telefontype() !== null;

let installering = null; // Chrome: hendelsen som åpner installeringsvinduet, når den finnes

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // vi viser vår egen veiledning i stedet for Chromes egen linje
  installering = e;
  oppdaterAndroid();
});

const ark = () => document.getElementById('ark-hjemskjerm');

// Med Chromes installering: vis knappen. Ellers: vis fremgangsmåten via menyen.
function oppdaterAndroid() {
  const a = ark();
  if (!a) return;
  a.querySelector('[data-handling="installer"]').hidden = !installering;
  a.querySelector('[data-steg="android"]').hidden = Boolean(installering);
}

function nyligLukket() {
  try {
    const { lukket } = JSON.parse(localStorage.getItem(NOKKEL) || '{}');
    return Boolean(lukket) && Date.now() - new Date(lukket) < VIS_IGJEN_ETTER_MS;
  } catch {
    return false;
  }
}

function huskLukket() {
  try {
    localStorage.setItem(NOKKEL, JSON.stringify({ lukket: new Date().toISOString() }));
  } catch {
    // Uten localStorage vises veiledningen igjen neste gang. Ikke kritisk.
  }
}

export function visHjemskjermVeiledning() {
  const a = ark();
  const type = telefontype();
  a.querySelector('[data-for="iphone"]').hidden = type !== 'iphone';
  a.querySelector('[data-for="android"]').hidden = type !== 'android';
  oppdaterAndroid();
  if (!a.open) a.showModal();
}

/** Koble opp arket, og vis det av seg selv når siden er åpnet i nettleseren på en telefon. */
export function settOppHjemskjerm() {
  const a = ark();
  a.addEventListener('click', async (e) => {
    if (e.target === a) a.close(); // trykk på den mørke bakgrunnen
    const handling = e.target.closest('[data-handling]')?.dataset.handling;
    if (handling === 'lukk') a.close();
    if (handling === 'installer' && installering) {
      installering.prompt();
      const { outcome } = await installering.userChoice;
      installering = null; // kan bare brukes én gang
      if (outcome === 'accepted') a.close();
      else oppdaterAndroid();
    }
  });
  a.addEventListener('close', huskLukket);

  if (kanLeggesTil() && !nyligLukket()) setTimeout(visHjemskjermVeiledning, VENT_FOR_VISNING_MS);
}
