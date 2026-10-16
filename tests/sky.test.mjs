/*
 * Synkroniseringen med skyen (app/js/sky.js), med erstatninger for Firebase og nettleseren:
 * en ny konto lagrer bare på telefonen, kontoen kan kobles til og fra skyen (valget følger
 * kontoen til alle telefonene), det som ligger på telefonen, vinner over slettingene fra
 * frakoblingen, et lag kobler kontoen til, Logg ut beholder alt på telefonen, og endringer
 * synkroniseres med en gang, men bare når det er noe å sende.
 * Oppdiktede data.
 *
 * Kjør fra roten av repoet:  node tests/sky.test.mjs
 * (Kjøres også av workflowen før publisering.)
 */

import assert from 'node:assert/strict';

// ---------- Nettleseren: det sky.js og lager.js bruker ----------

// Hver telefon har sin egen localStorage. «telefon» er den som brukes nå (se nyTelefon).
let telefon = new Map();
const sett = (navn, verdi) => Object.defineProperty(globalThis, navn, { value: verdi, configurable: true, writable: true });
sett('window', { addEventListener() {} });
sett('document', { addEventListener() {}, visibilityState: 'visible' });
sett('navigator', { onLine: true });
sett('localStorage', {
  getItem: (k) => telefon.get(k) ?? null,
  setItem: (k, v) => telefon.set(k, String(v)),
  removeItem: (k) => telefon.delete(k),
});

// IndexedDB med bare det lager.js bruker. Telefonene deler den, men testen leser aldri fra
// den (markeringene ligger i minnet i hver Markeringer).
function falskIndexedDB() {
  const tabeller = new Map();
  const db = {
    objectStoreNames: { contains: (navn) => tabeller.has(navn) },
    createObjectStore: (navn) => tabeller.set(navn, new Map()),
    transaction(navn) {
      const tabell = tabeller.get(navn);
      const t = {
        objectStore: () => ({
          getAll: () => ({ result: [...tabell.values()] }),
          put: (v) => { tabell.set(v.id, structuredClone(v)); },
          delete: (id) => { tabell.delete(id); },
          clear: () => { tabell.clear(); },
        }),
      };
      setTimeout(() => t.oncomplete?.());
      return t;
    },
  };
  return {
    open() {
      const foresporsel = {};
      setTimeout(() => {
        foresporsel.result = db;
        foresporsel.onupgradeneeded?.();
        foresporsel.onsuccess?.();
      });
      return foresporsel;
    },
  };
}
sett('indexedDB', falskIndexedDB());

const { Markeringer } = await import('../app/js/markeringer.js');
const { Sky } = await import('../app/js/sky.js');

// ---------- Skyen: FirestoreTjeneste i minnet ----------

class FalskTjeneste {
  constructor() {
    this.rom = new Map();     // rom → Map(id → { data, oppdatert })
    this.kontoer = new Map(); // uid → { sky, frakoblet }
    this.lagene = new Map();  // kode → lag
    this.klokke = 0;
    this.skrevet = 0;         // antall markeringer sendt til skyen
    this.feilNeste = null;    // navnet på en metode som skal feile én gang
  }

  _feil(metode) {
    if (this.feilNeste !== metode) return;
    this.feilNeste = null;
    throw Object.assign(new Error('Fikk ikke kontakt'), { code: 'unavailable' });
  }

  _samling(rom) {
    if (!this.rom.has(rom)) this.rom.set(rom, new Map());
    return this.rom.get(rom);
  }

  /** Markeringer i rommet som ikke er slettet */
  levende(rom) {
    return [...this._samling(rom).values()].filter((d) => !d.data.slettet).map((d) => d.data);
  }

  async hentEndringer(rom, etter) {
    return [...this._samling(rom)].filter(([, d]) => !etter || d.oppdatert[0] > etter[0])
      .sort(([, a], [, b]) => a.oppdatert[0] - b.oppdatert[0])
      .map(([id, d]) => ({ id, data: structuredClone(d.data), oppdatert: d.oppdatert }));
  }

  async lagre(rom, dokumenter) {
    this._feil('lagre');
    for (const { id, data } of dokumenter) {
      this._samling(rom).set(id, { data: structuredClone(data), oppdatert: [++this.klokke, 0] });
      this.skrevet++;
    }
  }

  async harMarkeringer(rom) {
    return this.levende(rom).length > 0;
  }

  async slettAlle(rom) {
    this.rom.delete(rom);
  }

  async hentKonto(uid) {
    return this.kontoer.has(uid) ? { frakoblet: null, ...this.kontoer.get(uid) } : null;
  }

  async lagreKonto(uid, felt) {
    this._feil('lagreKonto');
    this.kontoer.set(uid, { ...this.kontoer.get(uid), ...felt });
  }

  async slettKonto(uid) {
    this.kontoer.delete(uid);
  }

  async finnLag(uid) {
    const lag = [...this.lagene.values()].find((l) => l.medlemmer.includes(uid));
    return lag ? structuredClone(lag) : null;
  }

  async opprettLag(uid, epost, navn) {
    const lag = { id: `LAG${this.lagene.size + 1}`.padEnd(8, 'X'), navn, medlemmer: [uid], eposter: { [uid]: epost }, initialer: {} };
    this.lagene.set(lag.id, lag);
    return structuredClone(lag);
  }

  async blimed(kode, uid, epost) {
    const lag = this.lagene.get(kode);
    if (!lag) throw Object.assign(new Error('Fant ikke laget'), { code: 'not-found' });
    lag.medlemmer.push(uid);
    lag.eposter[uid] = epost;
    return structuredClone(lag);
  }

  async hentLag(kode) {
    return this.lagene.has(kode) ? structuredClone(this.lagene.get(kode)) : null;
  }

  async fjernMedlem(kode, uid) {
    const lag = this.lagene.get(kode);
    lag.medlemmer = lag.medlemmer.filter((m) => m !== uid);
    if (!lag.medlemmer.length) {
      this.lagene.delete(kode);
      this.rom.delete(`lag:${kode}`);
    }
  }
}

// En innlogging der testen bestemmer hvem som er logget inn
class FalskInnlogging {
  lytt(naar) {
    this.naar = naar;
  }

  async loggUt() {
    await this.naar(null);
  }
}

/** En telefon med egen localStorage og egne markeringer, mot skyen. */
function nyTelefon(skyen) {
  const tlf = {
    lagring: new Map(),
    markeringer: new Markeringer(),
    innlogging: new FalskInnlogging(),
    svar: true,  // svaret på bekreft()
    spurt: [],   // det appen har spurt om
  };
  tlf.sky = new Sky(tlf.markeringer, {
    naarStatus: () => {},
    bekreft: (tekst) => {
      tlf.spurt.push(tekst);
      return tlf.svar;
    },
    innlogging: tlf.innlogging,
    tjeneste: skyen,
  });
  tlf.sky.planlegg = () => {}; // ingen tidtakere: testen synkroniserer selv
  tlf.sky.start();
  // Kjør noe på denne telefonen (med dens localStorage), og vent til det er ferdig
  tlf.kjor = async (handling) => {
    telefon = tlf.lagring;
    return handling();
  };
  tlf.loggInn = (bruker) => tlf.kjor(async () => {
    await tlf.innlogging.naar(bruker);
    await tlf.sky.synkroniser(); // venter på synkroniseringen innloggingen startet
  });
  tlf.synk = () => tlf.kjor(() => tlf.sky.synkroniser());
  tlf.koblet = () => tlf.kjor(() => tlf.sky.koblet);
  tlf.teine = (nummer) => tlf.kjor(() => tlf.markeringer.nyTeine({ lat: 58.23, lon: 8.38, kilde: 'kart', nummer }));
  tlf.numre = () => tlf.markeringer.alle().map((m) => m.nummer).sort();
  return tlf;
}

const ola = { uid: 'ola', epost: 'ola@eksempel.no' };
const kari = { uid: 'kari', epost: 'kari@eksempel.no' };
const numre = (dokumenter) => dokumenter.map((d) => d.nummer).sort();

// ---------- En ny konto lagrer bare på telefonen ----------

const skyen = new FalskTjeneste();
const a = nyTelefon(skyen);
await a.loggInn(ola);
await a.teine(1);
assert.deepEqual(await a.synk(), { lokal: true });
assert.equal(await a.koblet(), false, 'ny konto er ikke koblet til skyen');
assert.equal(skyen.kontoer.get('ola').sky, false, 'valget er lagret i kontoen');
assert.equal(skyen.skrevet, 0, 'ingenting er sendt til skyen');

// ---------- Koble til: alt lastes opp, og en ny telefon med kontoen får alt ----------

await a.kjor(() => a.sky.kobleTil());
assert.equal(await a.koblet(), true);
assert.deepEqual(numre(skyen.levende('bruker:ola')), [1]);
await a.teine(2);
await a.synk();
assert.deepEqual(numre(skyen.levende('bruker:ola')), [1, 2]);

const b = nyTelefon(skyen);
await b.loggInn(ola);
assert.equal(await b.koblet(), true, 'valget følger kontoen til en ny telefon');
assert.deepEqual(b.numre(), [1, 2]);

// ---------- Koble fra: skyen tømmes, og alle telefonene beholder sitt ----------

await a.kjor(() => a.sky.kobleFra());
assert.equal(await a.koblet(), false);
assert.equal(skyen.kontoer.get('ola').sky, false);
assert.deepEqual(skyen.levende('bruker:ola'), [], 'alt i kontoen i skyen er slettet');
assert.deepEqual(a.numre(), [1, 2], 'telefonen beholder alt');

await b.synk();
assert.equal(await b.koblet(), false, 'den andre telefonen følger valget');
assert.deepEqual(b.numre(), [1, 2], 'og beholder alt (slettingene i skyen hentes ikke)');
const skrevet = skyen.skrevet;
await b.teine(3);
await b.synk();
assert.equal(skyen.skrevet, skrevet, 'ingenting sendes etter frakoblingen');

// ---------- Koble til igjen: telefonen vinner over slettingene fra frakoblingen ----------

// Teine 1 slettes på A mens kontoen er koblet fra. Den slettingen skal gjelde.
const teine1 = a.markeringer.alle().find((m) => m.nummer === 1);
await a.kjor(() => a.markeringer.slett(teine1.id));
await a.kjor(() => a.sky.kobleTil());
assert.deepEqual(numre(skyen.levende('bruker:ola')), [2], 'teine 2 er sendt på nytt, selv om den er eldre');

await b.synk();
assert.equal(await b.koblet(), true, 'B kobles til igjen');
assert.deepEqual(b.numre(), [2, 3], 'B mister teine 1 (slettet etter frakoblingen) og beholder teine 2');
assert.deepEqual(numre(skyen.levende('bruker:ola')), [2, 3], 'B sender teine 3');
await a.synk();
assert.deepEqual(a.numre(), [2, 3]);

// ---------- Logg ut beholder alt, og samme konto fortsetter der den slapp ----------

await a.kjor(() => a.sky.loggUt());
assert.deepEqual(a.numre(), [2, 3], 'Logg ut beholder alt på telefonen');
const skrevetFor = skyen.skrevet;
await a.loggInn(ola);
assert.equal(await a.koblet(), true);
assert.equal(skyen.skrevet, skrevetFor, 'ingenting sendes på nytt etter ny innlogging');

// ---------- Koble fra fullføres selv om den blir avbrutt ----------

skyen.feilNeste = 'lagre';
const consoleError = console.error;
console.error = () => {}; // sky.js skriver feilen til konsollen
const r = await a.kjor(() => a.sky.kobleFra());
console.error = consoleError;
assert.ok(r.feil, 'slettingene i skyen feilet');
assert.equal(skyen.kontoer.get('ola').sky, false, 'valget er lagret før slettingene');
assert.equal(skyen.levende('bruker:ola').length, 2);
await a.synk();
assert.equal(await a.koblet(), false);
assert.deepEqual(skyen.levende('bruker:ola'), [], 'slettingene er sendt ved neste synkronisering');
assert.deepEqual(a.numre(), [2, 3]);

// ---------- Et lag kobler kontoen til, og det på telefonen går rett til laget ----------

const c = nyTelefon(skyen);
await c.loggInn(kari);
await c.teine(7);
assert.equal(await c.koblet(), false);
await c.kjor(() => c.sky.opprettLag('Båten'));
const lag = await c.kjor(() => c.sky.lag);
assert.equal(await c.koblet(), true, 'kontoen er koblet til');
assert.deepEqual(numre(skyen.levende(`lag:${lag.id}`)), [7], 'teinen er i laget');
assert.deepEqual(skyen.levende('bruker:kari'), [], 'og ikke i kontoen');
await assert.rejects(c.kjor(() => c.sky.kobleFra()), { tekst: 'Forlat laget først.' });

// Forlat laget: kontoen er fortsatt koblet til, med en kopi
await c.kjor(() => c.sky.forlatLag());
assert.equal(await c.koblet(), true);
assert.deepEqual(numre(skyen.levende('bruker:kari')), [7]);

// ---------- Kontoer fra før valget fantes ----------

const skyen2 = new FalskTjeneste();
const per = { uid: 'per', epost: 'per@eksempel.no' };
// Telefon som var logget inn med en eldre versjon av appen: koblet til
const d = nyTelefon(skyen2);
d.lagring.set('hummerkart.sky', JSON.stringify({ uid: 'per', rom: 'bruker:per', kjent: {}, sist: '2026-10-01T08:00:00.000Z' }));
await d.teine(4);
await d.loggInn(per);
assert.equal(await d.koblet(), true, 'telefon fra før valget fantes er koblet til');
assert.equal(skyen2.kontoer.get('per').sky, true);
assert.deepEqual(numre(skyen2.levende('bruker:per')), [4]);
// Ny telefon for en konto med data i skyen, men uten valget: koblet til
skyen2.kontoer.delete('per');
const e = nyTelefon(skyen2);
await e.loggInn(per);
assert.equal(await e.koblet(), true, 'konto med data i skyen er koblet til');
assert.deepEqual(e.numre(), [4]);

// ---------- En annen konto på en telefon der alt bare ligger på telefonen ----------

const f = nyTelefon(new FalskTjeneste());
await f.loggInn(ola);
await f.teine(9);
await f.kjor(() => f.sky.loggUt());
f.svar = false;
await f.loggInn(kari);
assert.match(f.spurt.at(-1), /slettes de for godt/, 'advarer om at de slettes for godt');
assert.equal(await f.kjor(() => f.sky.innlogget), false, 'Avbryt logger ut igjen');
assert.deepEqual(f.numre(), [9], 'og beholder dem');
f.svar = true;
await f.loggInn(kari);
assert.equal(await f.kjor(() => f.sky.innlogget), true);
assert.deepEqual(f.numre(), [], 'fjernet når brukeren sier ja');

// ---------- Endringer synkroniseres med en gang, men bare når det er noe å sende ----------

const g = nyTelefon(new FalskTjeneste());
let planlagt = 0;
g.sky.planlegg = () => planlagt++;
await g.loggInn(ola);
await g.teine(1);
assert.equal(planlagt, 0, 'bare på telefonen: ingen synkronisering etter endringer');
await g.kjor(() => g.sky.kobleTil());
assert.equal(await g.kjor(() => g.sky.antallUsendte), 0);
planlagt = 0;
await g.teine(2);
assert.equal(planlagt, 1, 'koblet til: synkroniseres rett etter endringen');
assert.equal(await g.kjor(() => g.sky.antallUsendte), 1);
// Uten nett venter endringen, og synkroniseringsknappen viser at den ikke er sendt
navigator.onLine = false;
assert.equal(await g.synk(), null);
assert.equal(await g.kjor(() => g.sky.antallUsendte), 1);
navigator.onLine = true;
assert.deepEqual(await g.synk(), { hentet: 0, sendt: 1 });
assert.equal(await g.kjor(() => g.sky.antallUsendte), 0);
// Dybden som fylles inn, endrer ikke «endret», så det er ingenting å sende
await g.kjor(() => g.markeringer.settDybdeoppslag(() => 12));
assert.equal(planlagt, 1, 'ingen synkronisering når ingenting skal sendes');

console.log('Synkroniseringen med skyen virker som den skal');
