/*
 * Lagring av markeringer i nettleserens database (IndexedDB) på telefonen.
 *
 * Dataene blir liggende til neste gang appen åpnes, også uten nett, og når du logger ut.
 * De forsvinner bare hvis nettleserdataene for siden slettes (eller appen fjernes fra
 * hjemskjermen). Er kontoen koblet til skyen, lagres de også der (sky.js), og skyen
 * kopieres hver natt, og hver time fra 1. oktober til 15. desember, til en sikkerhetskopi.
 * Ellers ligger de bare her, og brukeren kan lagre en kopi til fil.
 *
 * To tabeller:
 *   markeringer  teiner og fangst
 *   slettinger   id og tidspunkt for markeringer du har slettet, så slettingen også
 *                gjelder for kopien i skyen og andre telefoner, og en kopi av
 *                markeringen, så den kan gjenopprettes (eldre slettinger mangler kopien)
 *
 * IndexedDB har et tungvint, hendelsesbasert API. Funksjonene her pakker det inn
 * i Promise, så resten av appen kan bruke await.
 */

const DB_NAVN = 'hummerkart';
const DB_VERSJON = 2; // 2: tabellen «slettinger» lagt til
const MARKERINGER = 'markeringer';
const SLETTINGER = 'slettinger';

let dbLofte = null;

function apne() {
  if (!dbLofte) {
    dbLofte = new Promise((ok, feil) => {
      const foresporsel = indexedDB.open(DB_NAVN, DB_VERSJON);
      // Kjøres første gang og ved ny DB_VERSJON: lag tabellene som mangler.
      // Eksisterende markeringer blir liggende urørt.
      foresporsel.onupgradeneeded = () => {
        const db = foresporsel.result;
        for (const navn of [MARKERINGER, SLETTINGER]) {
          if (!db.objectStoreNames.contains(navn)) db.createObjectStore(navn, { keyPath: 'id' });
        }
      };
      foresporsel.onsuccess = () => {
        const db = foresporsel.result;
        db.onversionchange = () => db.close(); // en nyere versjon av appen vil oppgradere
        ok(db);
      };
      foresporsel.onerror = () => feil(foresporsel.error);
    });
  }
  return dbLofte;
}

// Kjør én operasjon i en transaksjon og vent til den er lagret.
async function transaksjon(tabell, modus, gjor) {
  const db = await apne();
  return new Promise((ok, feil) => {
    const t = db.transaction(tabell, modus);
    const resultat = gjor(t.objectStore(tabell));
    t.oncomplete = () => ok(resultat && 'result' in resultat ? resultat.result : undefined);
    t.onerror = () => feil(t.error);
    t.onabort = () => feil(t.error);
  });
}

export const hentAlle = () => transaksjon(MARKERINGER, 'readonly', (t) => t.getAll());

export const lagre = (markering) => transaksjon(MARKERINGER, 'readwrite', (t) => t.put(markering));

export const slett = (id) => transaksjon(MARKERINGER, 'readwrite', (t) => t.delete(id));

export const lagreMange = (markeringer) =>
  transaksjon(MARKERINGER, 'readwrite', (t) => {
    for (const m of markeringer) t.put(m);
  });

export const hentSlettinger = () => transaksjon(SLETTINGER, 'readonly', (t) => t.getAll());

export const lagreSletting = (sletting) => transaksjon(SLETTINGER, 'readwrite', (t) => t.put(sletting));

export const fjernSletting = (id) => transaksjon(SLETTINGER, 'readwrite', (t) => t.delete(id));

/** Tøm begge tabellene (når en annen konto logger inn på telefonen). */
export async function tomAlt() {
  await transaksjon(MARKERINGER, 'readwrite', (t) => t.clear());
  await transaksjon(SLETTINGER, 'readwrite', (t) => t.clear());
}

/**
 * Be nettleseren om varig lagring, så dataene ikke slettes ved lite plass.
 * Returnerer true hvis lagringen er varig.
 */
export async function beOmVarigLagring() {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}
