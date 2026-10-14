/*
 * Lagring av markeringer i nettleserens database (IndexedDB) på telefonen.
 *
 * Dataene blir liggende til neste gang appen åpnes, også uten nett. De forsvinner
 * bare hvis nettleserdataene for siden slettes. Eksporter til GeoJSON som sikkerhetskopi.
 *
 * IndexedDB har et tungvint, hendelsesbasert API. Funksjonene her pakker det inn
 * i Promise, så resten av appen kan bruke await.
 */

const DB_NAVN = 'hummerkart';
const DB_VERSJON = 1;
const TABELL = 'markeringer';

let dbLofte = null;

function apne() {
  if (!dbLofte) {
    dbLofte = new Promise((ok, feil) => {
      const foresporsel = indexedDB.open(DB_NAVN, DB_VERSJON);
      // Kjøres første gang (og ved ny DB_VERSJON): lag tabellen.
      foresporsel.onupgradeneeded = () => {
        foresporsel.result.createObjectStore(TABELL, { keyPath: 'id' });
      };
      foresporsel.onsuccess = () => ok(foresporsel.result);
      foresporsel.onerror = () => feil(foresporsel.error);
    });
  }
  return dbLofte;
}

// Kjør én operasjon i en transaksjon og vent til den er lagret.
async function transaksjon(modus, gjor) {
  const db = await apne();
  return new Promise((ok, feil) => {
    const t = db.transaction(TABELL, modus);
    const resultat = gjor(t.objectStore(TABELL));
    t.oncomplete = () => ok(resultat && 'result' in resultat ? resultat.result : undefined);
    t.onerror = () => feil(t.error);
    t.onabort = () => feil(t.error);
  });
}

export const hentAlle = () => transaksjon('readonly', (tabell) => tabell.getAll());

export const lagre = (markering) => transaksjon('readwrite', (tabell) => tabell.put(markering));

export const slett = (id) => transaksjon('readwrite', (tabell) => tabell.delete(id));

export const lagreMange = (markeringer) =>
  transaksjon('readwrite', (tabell) => {
    for (const m of markeringer) tabell.put(m);
  });

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
