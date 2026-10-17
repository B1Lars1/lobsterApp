/*
 * Konto, lag og synkronisering med skyen (Firebase, se firebase.js).
 *
 * Telefonen er hovedkopien: markeringene ligger i IndexedDB (lager.js), og appen virker
 * uten nett. Som standard lagres teiner og fangst bare på telefonen, også når du er
 * logget inn. Kobler du kontoen til skyen (eller oppretter eller blir med i et lag),
 * synkroniseres de med ett «rom»:
 *   'bruker:{uid}'  kontoen din, eller
 *   'lag:{kode}'    laget du er med i (felles logg, der alle medlemmene ser og endrer alt).
 *
 * Valget gjelder kontoen, ikke telefonen. Det ligger i brukere/{uid} ({ sky: true/false })
 * og leses ved hver synkronisering, så alle telefonene med kontoen følger det: kobles
 * kontoen til på én telefon, sender de andre det de har, og kobles den fra, slutter de å
 * synkronisere og beholder det de har. Kontoer fra før valget fantes, har ikke dokumentet.
 * De regnes som koblet til hvis telefonen var det, eller kontoen er med i et lag eller har
 * markeringer i skyen.
 *
 * Hver synkronisering
 *   1. leser kontoens valg. Er kontoen ikke koblet til skyen, stopper den her,
 *   2. sjekker hvilket lag du er med i (du kan ha blitt fjernet fra et annet sted),
 *   3. henter det som er endret i rommet siden sist («oppdatert», satt av serveren),
 *      og slår det sammen med markeringer.importer(): nyeste «endret» vinner, og
 *      slettinger følger med,
 *   4. sender markeringer og slettinger som er endret her: der «endret» er en annen
 *      enn versjonen vi vet ligger i rommet (kartet «kjent»).
 * En sletting er et dokument med slettet: true, så den når de andre telefonene.
 *
 * Bytter du rom (kobler til, oppretter eller blir med i et lag, forlater det), starter
 * «kjent» på nytt. Da sendes alt som ligger på telefonen til det nye rommet: det du hadde,
 * flyttes inn i laget, og forlater du laget, får kontoen din en kopi av lagets teiner og
 * fangst.
 *
 * Kobler du fra skyen (bare utenfor lag), slettes markeringene i kontoen i skyen med
 * slettedokumenter, så sikkerhetskopien også får det med. Alle får samme «endret», som
 * huskes i brukere/{uid} (frakoblet). Kobles kontoen til igjen, vinner det som ligger på
 * telefonen over disse slettingene og sendes på nytt, selv om det er eldre.
 *
 * Synkroniserer når du logger inn, når appen åpnes eller kommer fram igjen, når telefonen
 * får nett igjen, når du trykker på synkroniseringsknappen, og rett etter hver lagret
 * endring (bare når kontoen er koblet til).
 *
 * Tilstanden huskes i localStorage under egen nøkkel:
 *   { uid, sky: true | false | null (ikke sjekket ennå), frakobler, rom, lag,
 *     sistHentet: [sekunder, nanosekunder], kjent: { id: endret }, sist, feil }
 * Logger du ut, blir markeringene og tilstanden liggende på telefonen, og logger du inn
 * igjen med samme konto, fortsetter det der det slapp. Logger en annen konto inn på
 * telefonen, fjernes markeringene fra den forrige kontoen. Appen spør først hvis noe av det
 * ikke ligger i skyen (kontoen var ikke koblet til, eller noe er ikke sendt ennå).
 */

import { FELT } from './markeringer.js';

const NOKKEL = 'hummerkart.sky';
// Endringer sendes med en gang. Den korte ventetiden samler endringene fra én handling
// (fangsten og teinen som er tatt opp, «Ta opp alle mine») i én synkronisering.
const VENT_ETTER_ENDRING_MS = 500;

function hentTilstand() {
  try {
    const tilstand = { kjent: {}, ...JSON.parse(localStorage.getItem(NOKKEL) || '{}') };
    // Logget inn med en versjon fra før kontoen kunne lagre bare på telefonen: da var den
    // koblet til skyen
    if (tilstand.uid && !('sky' in tilstand)) tilstand.sky = true;
    return tilstand;
  } catch {
    return { kjent: {} };
  }
}

function lagreTilstand(tilstand) {
  try {
    localStorage.setItem(NOKKEL, JSON.stringify(tilstand));
  } catch {
    // Uten localStorage sendes alt på nytt neste gang. Det går fint, men koster litt mer.
  }
}

// Når det siste vi har hentet, ble skrevet: [sekunder, nanosekunder] fra serveren, eller null.
// Eldre versjoner lagret millisekunder (et tall), som gjøres om her.
function sistHentet(tilstand) {
  const s = tilstand.sistHentet;
  if (Array.isArray(s) && s.length === 2) return s;
  if (typeof s === 'number') return [Math.floor(s / 1000), Math.floor((s % 1000) * 1e6)];
  return null;
}

// Er tidspunktet a ([sekunder, nanosekunder]) senere enn b (eller null)?
const senere = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

function tilDokument(m) {
  const data = { slettet: false, lat: m.lat, lon: m.lon };
  for (const f of FELT) data[f] = m[f] ?? null;
  return data;
}

const endringer = (n) => (n === 1 ? '1 endring' : `${n} endringer`);

/** Svaret fra en synkronisering som gikk bra ({ hentet, sendt }), til brukeren. */
export function synkTekst({ hentet, sendt }) {
  return `Synkronisert: ${hentet ? `${endringer(hentet)} hentet` : 'ingen nye endringer'}`
    + `${sendt ? `, ${sendt} sendt` : ''}.`;
}

// Feil fra appen selv, med forklaringen til brukeren i «tekst» (se feilTekst)
const appFeil = (tekst) => Object.assign(new Error(tekst), { tekst });

/** «ABCDEFGH» → «ABCD-EFGH», lettere å lese og skrive av. */
export const visKode = (kode) => `${kode.slice(0, 4)}-${kode.slice(4)}`;

/** Det brukeren skrev inn → koden (store bokstaver, uten mellomrom og bindestrek). */
export const rensKode = (tekst) => tekst.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Feil fra Firestore og Firebase Auth med forklaring på norsk
export function feilTekst(feil) {
  if (feil?.tekst) return feil.tekst; // fra appen selv (appFeil)
  const kode = feil?.code ?? '';
  const tekster = {
    'permission-denied': 'Ingen tilgang til lagringen. Er tilgangsreglene lagt inn i Firebase?',
    'unauthenticated': 'Du må logge inn på nytt.',
    'not-found': 'Fant ikke databasen i Firebase.',
    'unavailable': 'Fikk ikke kontakt med skyen.',
    'resource-exhausted': 'Kvoten i Firebase er brukt opp for i dag.',
    'auth/invalid-credential': 'Feil e-post eller passord.',
    'auth/wrong-password': 'Feil passord.',
    'auth/user-not-found': 'Fant ingen konto med den e-posten.',
    'auth/invalid-email': 'E-postadressen ser ikke riktig ut.',
    'auth/missing-password': 'Skriv inn passordet.',
    'auth/too-many-requests': 'For mange forsøk. Vent litt og prøv igjen.',
    'auth/network-request-failed': 'Ingen nettforbindelse.',
    'auth/requires-recent-login': 'Logg inn på nytt og prøv igjen.',
    'auth/operation-not-allowed': 'Innlogging med e-post og passord er ikke slått på i Firebase.',
  };
  return tekster[kode] ?? (feil?.message ? `Noe gikk galt (${kode || feil.message}).` : 'Noe gikk galt.');
}

export class Sky {
  /**
   * @param {import('./markeringer.js').Markeringer} markeringer
   * @param {object} valg
   * @param {(status: {tilstand: string, tekst: string}) => void} valg.naarStatus  også når
   *   kontoen kobles til eller fra skyen
   * @param {(bruker: {uid: string, epost: string} | null) => void} valg.naarBruker
   * @param {(lag: object | null) => void} valg.naarLag  laget du er med i, når det endres
   * @param {(tekst: string) => boolean | Promise<boolean>} valg.bekreft  spør brukeren
   *   (app.js bruker arket i bekreft.js, standard: window.confirm)
   * @param {object} valg.innlogging  FirebaseInnlogging eller en erstatning (tester)
   * @param {object} valg.tjeneste    FirestoreTjeneste eller en erstatning (tester)
   */
  constructor(markeringer, {
    naarStatus, naarBruker, naarLag, bekreft = (t) => window.confirm(t), innlogging, tjeneste,
  }) {
    this.markeringer = markeringer;
    this.naarStatus = naarStatus;
    this.naarBruker = naarBruker;
    this.naarLag = naarLag;
    this.bekreft = bekreft;
    this.innlogging = innlogging;
    this.tjeneste = tjeneste;
    this.bruker = null;
    this._pagaende = null; // løftet for synkroniseringen som pågår
    this._timer = null;
    this._frakoblet = null; // «endret» på slettingene fra da kontoen sist ble koblet fra skyen

    // Synkroniser rett etter at noe er lagret, men bare hvis det er noe å sende (dybden som
    // fylles inn, endrer ikke «endret»). Under en synkronisering overses det, ellers ville
    // importen av det som hentes, starte en ny. Det som endres underveis, sendes etterpå.
    markeringer.naarEndret(() => {
      if (this.koblet && !this.pagar && this._usendte().length) this.planlegg();
    });
    // Når appen får nett eller kommer fram igjen: hent endringer fra andre telefoner, og
    // sjekk om kontoen er koblet til eller fra skyen et annet sted
    window.addEventListener('online', () => {
      if (this.bruker) this.planlegg(1000);
    });
    document.addEventListener('visibilitychange', () => {
      if (this.bruker && document.visibilityState === 'visible') this.planlegg(500);
    });
  }

  /** Begynn å følge innloggingen. Kalles når markeringene er lest inn fra telefonen. */
  start() {
    this.innlogging.lytt((bruker) => this._brukerEndret(bruker));
  }

  get innlogget() {
    return Boolean(this.bruker);
  }

  /** Er kontoen koblet til skyen? Ellers lagres teiner og fangst bare på telefonen. */
  get koblet() {
    return Boolean(this.bruker) && hentTilstand().sky === true;
  }

  get pagar() {
    return Boolean(this._pagaende);
  }

  /** Antall markeringer og slettinger som ikke er sendt til skyen ennå (0 uten skyen). */
  get antallUsendte() {
    return this.koblet ? this._usendte().length : 0;
  }

  /** Laget du er med i ({ id, navn, medlemmer, eposter, initialer }), eller null. */
  get lag() {
    return this.koblet ? hentTilstand().lag ?? null : null;
  }

  async _brukerEndret(bruker) {
    if (bruker) {
      const tilstand = hentTilstand();
      if (tilstand.uid && tilstand.uid !== bruker.uid && this.markeringer.alle().length) {
        // Markeringene på telefonen hører til en annen konto. Ikke bland dem inn i denne.
        // Ligger alt i den andre kontoen i skyen, fjernes de uten å spørre.
        const sporsmal = this._annenKontoTekst(tilstand, bruker.epost);
        if (sporsmal && !(await this.bekreft(sporsmal))) {
          await this.innlogging.loggUt();
          return;
        }
        await this.markeringer.tomAlt();
        lagreTilstand({ uid: bruker.uid, sky: null, kjent: {} });
      } else if (tilstand.uid !== bruker.uid) {
        // Første innlogging på telefonen. Om det som ligger her, sendes til skyen, avgjør
        // kontoens valg ved første synkronisering (_sjekkKobling).
        lagreTilstand({ uid: bruker.uid, sky: null, kjent: {} });
      }
    }
    this.bruker = bruker;
    this.markeringer.registrertAv = bruker?.uid ?? null; // nye markeringer får med hvem som satte dem
    this.naarBruker?.(bruker);
    this.naarLag?.(this.lag);
    this.naarStatus(this.statusTekst());
    if (bruker) this.synkroniser();
  }

  // Spørsmålet før markeringene fra en annen konto fjernes fra telefonen, eller null når
  // alt ligger i den andre kontoen i skyen (eller laget), så ingenting går tapt
  _annenKontoTekst(tilstand, epost) {
    if (tilstand.sky !== true || tilstand.frakobler) {
      return 'Telefonen har teiner og fangst fra en annen konto, og de ligger bare på denne '
        + `telefonen. Logger du inn som ${epost}, slettes de for godt. Vil du ta vare på dem, `
        + 'trykk Avbryt og lagre en kopi til fil først (Innstillinger → Sikkerhetskopi). '
        + 'Fortsette og slette dem?';
    }
    const usendte = this._usendte().length;
    if (!usendte) return null;
    return `Telefonen har teiner og fangst fra en annen konto. De fjernes fra telefonen når du `
      + `logger inn som ${epost}. De ligger i den andre kontoen i skyen, unntatt `
      + `${endringer(usendte)} som ikke er sendt ennå og går tapt. Fortsette?`;
  }

  statusTekst() {
    if (!this.bruker) return { tilstand: 'av', tekst: '' }; // innstillingsarket forklarer det selv
    const { sky, sist, feil, frakobler } = hentTilstand();
    if (frakobler) return { tilstand: 'venter', tekst: 'Kobler fra skyen …' };
    if (feil) return { tilstand: 'feil', tekst: `Feil: ${feil}` };
    if (sky == null) return { tilstand: 'venter', tekst: 'Ikke sjekket ennå om kontoen er koblet til skyen.' };
    if (!sky) return { tilstand: 'lokal', tekst: '' }; // innstillingsarket forklarer det selv
    if (!sist) return { tilstand: 'venter', tekst: 'Ikke synkronisert ennå.' };
    const tid = new Date(sist).toLocaleString('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return { tilstand: 'ok', tekst: `Synkronisert ${tid}.` };
  }

  planlegg(ms = VENT_ETTER_ENDRING_MS) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.synkroniser(), ms);
  }

  // ---------- Rom: kontoen eller laget ----------

  _rom() {
    const t = hentTilstand();
    return t.rom ?? `bruker:${this.bruker.uid}`; // uten «rom» (eldre versjon): kontoen
  }

  /** Bytt rom. Nytt rom: alt på telefonen sendes dit ved neste synkronisering. */
  _byttRom(rom, lag) {
    const t = hentTilstand();
    const gammelt = t.rom ?? (t.uid ? `bruker:${t.uid}` : null);
    if (gammelt !== rom) lagreTilstand({ ...t, rom, lag, sistHentet: null, kjent: {} });
    else lagreTilstand({ ...t, rom, lag });
    this.naarLag?.(lag);
  }

  /** Sjekk hvilket lag brukeren er med i nå, og bytt rom hvis det er endret. */
  async _oppdaterLag() {
    const lag = await this.tjeneste.finnLag(this.bruker.uid);
    this._byttRom(lag ? `lag:${lag.id}` : `bruker:${this.bruker.uid}`, lag);
  }

  // ---------- Koblet til skyen, eller bare på telefonen ----------

  /** Les kontoens valg i skyen og følg det. Returnerer true hvis kontoen er koblet til. */
  async _sjekkKobling() {
    const { uid } = this.bruker;
    const t = hentTilstand();
    const konto = await this.tjeneste.hentKonto(uid);
    let koblet = konto?.sky;
    if (!konto) {
      // Kontoen er fra før valget fantes (eller helt ny)
      koblet = t.sky === true || Boolean(await this.tjeneste.finnLag(uid))
        || await this.tjeneste.harMarkeringer(`bruker:${uid}`);
      await this.tjeneste.lagreKonto(uid, { sky: koblet });
    }
    this._frakoblet = konto?.frakoblet ?? null;
    if (koblet && t.sky !== true) {
      this._bliKoblet(); // koblet til på en annen telefon, eller kontoen har data i skyen
    } else if (!koblet && t.sky !== false) {
      // Koblet fra på en annen telefon, eller en ny konto: alt blir liggende på telefonen
      lagreTilstand({ uid, sky: false, kjent: {} });
      this.naarLag?.(null);
    }
    return koblet;
  }

  // Kontoen er koblet til skyen. Var den ikke det på telefonen, sendes alt som ligger her
  // ved neste synkronisering. En frakobling som ikke er fullført, stoppes.
  _bliKoblet() {
    const { frakobler, ...t } = hentTilstand();
    lagreTilstand(t.sky === true ? t
      : { ...t, sky: true, rom: null, lag: null, sistHentet: null, kjent: {} });
  }

  /**
   * Koble kontoen til skyen: alt på telefonen lastes opp til kontoen, og du får
   * sikkerhetskopi og teinene og fangsten på alle telefonene dine.
   */
  async kobleTil() {
    if (!navigator.onLine) throw appFeil('Du må ha nett for å koble til skyen.');
    await this.tjeneste.lagreKonto(this.bruker.uid, { sky: true });
    this._bliKoblet();
    this.naarStatus(this.statusTekst());
    return this.synkroniser();
  }

  /**
   * Koble kontoen fra skyen, så teiner og fangst bare lagres på telefonen. Det som ligger i
   * kontoen i skyen, slettes, og telefonen beholder alt. Ikke mulig i et lag.
   */
  async kobleFra() {
    if (!navigator.onLine) throw appFeil('Du må ha nett for å koble fra skyen.');
    if (this.lag) throw appFeil('Forlat laget først.');
    // Hent og send det siste først, så telefonen har alt som ligger i skyen
    const r = await this.synkroniser();
    if (r?.feil) throw appFeil(r.feil);
    if (!this.koblet) return r; // koblet fra på en annen telefon i mellomtiden
    if (this.lag) throw appFeil('Forlat laget først.'); // ble med i et lag på en annen telefon
    lagreTilstand({ ...hentTilstand(), frakobler: new Date().toISOString() });
    this.naarStatus(this.statusTekst());
    // Fullføres av synkroniseringen, så den gjøres ferdig senere hvis den blir avbrutt
    return this.synkroniser();
  }

  async _fullforFrakobling() {
    const { uid } = this.bruker;
    const t = hentTilstand();
    const tid = t.frakobler;
    if (t.rom?.startsWith('lag:')) {
      const { frakobler, ...uten } = t;
      lagreTilstand(uten);
      throw appFeil('Forlat laget først.');
    }
    // Valget først, så de andre telefonene slutter å synkronisere før slettingene kommer
    await this.tjeneste.lagreKonto(uid, { sky: false, frakoblet: tid });
    const slettinger = this.markeringer.alle()
      .filter((m) => m.id in t.kjent)
      .map((m) => ({ id: m.id, data: { id: m.id, endret: tid, slettet: true } }));
    if (slettinger.length) await this.tjeneste.lagre(`bruker:${uid}`, slettinger);
    lagreTilstand({ uid, sky: false, kjent: {} });
    this.naarLag?.(null);
  }

  // ---------- Synkronisering ----------

  /** Markeringer og slettinger som er endret her siden de sist var i skyen. */
  _usendte() {
    const { kjent } = hentTilstand();
    const dokumenter = [];
    for (const m of this.markeringer.alle()) {
      if (kjent[m.id] !== m.endret) dokumenter.push({ id: m.id, data: tilDokument(m) });
    }
    for (const { id, endret } of this.markeringer.slettinger()) {
      if (kjent[id] !== endret) dokumenter.push({ id, data: { id, endret, slettet: true } });
    }
    return dokumenter;
  }

  /**
   * Synkroniser nå. Returnerer { hentet, sendt }, { lokal: true } (kontoen er ikke koblet
   * til skyen), { feil: tekst } eller null hvis det ikke ble gjort (ikke innlogget eller
   * uten nett). Pågår en synkronisering allerede, ventes det på den.
   */
  synkroniser() {
    if (this._pagaende) return this._pagaende;
    if (!this.bruker) return Promise.resolve(null);
    if (!navigator.onLine) {
      if (this.koblet) this.naarStatus({ tilstand: 'venter', tekst: 'Uten nett. Synkroniserer når du får nett.' });
      return Promise.resolve(null);
    }
    clearTimeout(this._timer);
    this._pagaende = this._synkroniser().finally(() => {
      this._pagaende = null;
    });
    return this._pagaende;
  }

  async _synkroniser() {
    if (this.koblet) this.naarStatus({ tilstand: 'pagar', tekst: 'Synkroniserer …' });
    let resultat = { lokal: true };
    try {
      if (hentTilstand().frakobler) {
        await this._fullforFrakobling();
      } else if (await this._sjekkKobling()) {
        resultat = await this._utveksle();
      }
      lagreTilstand({ ...hentTilstand(), feil: null });
      this.naarStatus(this.statusTekst());
      // Endret mens synkroniseringen pågikk? (naarEndret overses da, se konstruktøren)
      if (this.koblet && this._usendte().length) this.planlegg();
    } catch (feil) {
      console.error(feil);
      const tekst = feilTekst(feil);
      // Feil som ikke går over av seg selv, vises til de er rettet
      if (feil?.code === 'permission-denied' || feil?.code === 'not-found') {
        lagreTilstand({ ...hentTilstand(), feil: tekst });
      }
      // Bare på telefonen: ikke vis at skyen var utilgjengelig (feil som varer, vises likevel)
      this.naarStatus(this.koblet ? { tilstand: 'feil', tekst: `Feil: ${tekst}` } : this.statusTekst());
      resultat = { feil: tekst };
    }
    return resultat;
  }

  // Trinn 2–4: lag, hent og send
  async _utveksle() {
    // 2. Hvilket lag er du med i?
    await this._oppdaterLag();
    const rom = this._rom();

    // 3. Hent det som er endret i rommet siden sist
    const tilstand = hentTilstand();
    tilstand.sistHentet = sistHentet(tilstand);
    const nye = await this.tjeneste.hentEndringer(rom, tilstand.sistHentet);
    const features = [];
    const slettet = [];
    for (const { id, data, oppdatert } of nye) {
      if (oppdatert && senere(oppdatert, tilstand.sistHentet)) tilstand.sistHentet = oppdatert;
      if (data.slettet && data.endret === this._frakoblet && this.markeringer.hent(id)) {
        // Slettet da kontoen ble koblet fra skyen, men ligger her: telefonen vinner og
        // sender den på nytt
        delete tilstand.kjent[id];
        continue;
      }
      tilstand.kjent[id] = data.endret;
      if (data.slettet) {
        slettet.push({ id, endret: data.endret });
      } else {
        const { lat, lon, slettet: _, ...egenskaper } = data;
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: egenskaper });
      }
    }
    let hentet = 0;
    if (features.length || slettet.length) {
      const r = await this.markeringer.importer({ type: 'FeatureCollection', features, slettet });
      hentet = r.nye + r.oppdaterte + r.slettet;
    }
    lagreTilstand(tilstand);

    // 4. Send det som er endret her
    const usendte = this._usendte();
    if (usendte.length) {
      await this.tjeneste.lagre(rom, usendte);
      const etter = hentTilstand();
      for (const { id, data } of usendte) etter.kjent[id] = data.endret;
      lagreTilstand(etter);
    }
    lagreTilstand({ ...hentTilstand(), sist: new Date().toISOString() });
    return { hentet, sendt: usendte.length };
  }

  // ---------- Lag ----------

  /** Opprett et lag. Det du har, flyttes inn i laget. */
  async opprettLag(navn) {
    if (this.koblet) await this.synkroniser(); // få med siste endringer i kontoen først
    const lag = await this.tjeneste.opprettLag(this.bruker.uid, this.bruker.epost, navn);
    return this._gaInnILag(lag);
  }

  /** Bli med i laget med koden. Det du har, flyttes inn i laget, og du får lagets. */
  async blimedILag(kode) {
    if (this.koblet) await this.synkroniser();
    const lag = await this.tjeneste.blimed(kode, this.bruker.uid, this.bruker.epost);
    return this._gaInnILag(lag);
  }

  // Et lag ligger i skyen, så kontoen kobles til. Det som ligger på telefonen, sendes rett
  // til laget, ikke til kontoen først.
  async _gaInnILag(lag) {
    if (!this.koblet) {
      await this.tjeneste.lagreKonto(this.bruker.uid, { sky: true });
      this._bliKoblet();
    }
    this._byttRom(`lag:${lag.id}`, lag);
    return this.synkroniser();
  }

  /** Forlat laget. Kontoen din får en kopi av lagets teiner og fangst, og er fortsatt koblet til skyen. */
  async forlatLag() {
    await this.synkroniser(); // få med siste endringer i laget først
    const lag = this.lag;
    if (lag) await this.tjeneste.fjernMedlem(lag.id, this.bruker.uid);
    this._byttRom(`bruker:${this.bruker.uid}`, null);
    return this.synkroniser();
  }

  /** Sett initialene dine i laget («BL»), eller fjern dem (null). De andre ser dem på teinene dine. */
  async settInitialer(initialer) {
    const lag = this.lag;
    if (!lag) return;
    await this.tjeneste.settInitialer(lag.id, this.bruker.uid, initialer);
    const oppdatert = await this.tjeneste.hentLag(lag.id);
    this._byttRom(`lag:${lag.id}`, oppdatert);
  }

  /** Fjern et annet medlem fra laget. */
  async fjernMedlem(uid) {
    const lag = this.lag;
    if (!lag) return;
    await this.tjeneste.fjernMedlem(lag.id, uid);
    const oppdatert = await this.tjeneste.hentLag(lag.id);
    this._byttRom(`lag:${lag.id}`, oppdatert);
  }

  // ---------- Konto ----------

  async loggInn(epost, passord) {
    await this.innlogging.loggInn(epost, passord);
  }

  async glemtPassord(epost) {
    await this.innlogging.glemtPassord(epost);
  }

  /**
   * Logg ut. Teiner og fangst blir liggende på telefonen. Er kontoen koblet til skyen,
   * sendes det som er endret, først. Uten nett sendes det når du logger inn igjen med
   * samme konto.
   */
  async loggUt() {
    if (this.koblet) await this.synkroniser();
    clearTimeout(this._timer);
    await this.innlogging.loggUt();
  }

  /**
   * Slett kontoen og alt i kontoen i skyen. Er du med i et lag, går du ut av det (det du
   * har registrert der, blir liggende). Markeringene på telefonen beholdes.
   */
  async slettKonto(passord) {
    const { uid } = this.bruker;
    await this.innlogging.bekreftPassord(passord);
    const lag = this.lag;
    if (lag) await this.tjeneste.fjernMedlem(lag.id, uid);
    await this.tjeneste.slettAlle(`bruker:${uid}`);
    await this.tjeneste.slettKonto(uid);
    await this.innlogging.slettBruker();
    lagreTilstand({ kjent: {} });
  }
}
