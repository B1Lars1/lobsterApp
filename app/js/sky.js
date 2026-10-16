/*
 * Konto, lag og synkronisering med skyen (Firebase, se firebase.js).
 *
 * Telefonen er hovedkopien: markeringene ligger i IndexedDB (lager.js), og appen
 * virker uten nett og uten konto. Er du logget inn, synkroniseres de med ett «rom»:
 *   'bruker:{uid}'  kontoen din, eller
 *   'lag:{kode}'    laget du er med i (felles logg, der alle medlemmene ser og endrer alt).
 * Hver synkronisering
 *   1. sjekker hvilket lag du er med i (du kan ha blitt fjernet fra et annet sted),
 *   2. henter det som er endret i rommet siden sist («oppdatert», satt av serveren),
 *      og slår det sammen med markeringer.importer(): nyeste «endret» vinner, og
 *      slettinger følger med,
 *   3. sender markeringer og slettinger som er endret her: der «endret» er en annen
 *      enn versjonen vi vet ligger i rommet (kartet «kjent»).
 * En sletting er et dokument med slettet: true, så den når de andre telefonene.
 *
 * Bytter du rom (oppretter eller blir med i et lag, forlater det), starter «kjent» på
 * nytt. Da sendes alt som ligger på telefonen til det nye rommet: det du hadde, flyttes
 * inn i laget, og forlater du laget, får kontoen din en kopi av lagets teiner og fangst.
 *
 * Synkroniserer når du logger inn, når appen åpnes eller kommer fram igjen, kort tid
 * etter endringer, og når telefonen får nett igjen.
 *
 * Tilstanden huskes i localStorage under egen nøkkel:
 *   { uid, rom, lag, sistHentet (ms), kjent: { id: endret }, sist, feil }
 * Logger du ut, fjernes markeringene fra telefonen (de ligger i skyen). Logger en annen
 * konto inn på telefonen, spør appen før markeringene fra den forrige kontoen fjernes.
 */

import { FELT } from './markeringer.js';

const NOKKEL = 'hummerkart.sky';
const VENT_ETTER_ENDRING_MS = 10000;

function hentTilstand() {
  try {
    return { kjent: {}, ...JSON.parse(localStorage.getItem(NOKKEL) || '{}') };
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

function tilDokument(m) {
  const data = { slettet: false, lat: m.lat, lon: m.lon };
  for (const f of FELT) data[f] = m[f] ?? null;
  return data;
}

/** «ABCDEFGH» → «ABCD-EFGH», lettere å lese og skrive av. */
export const visKode = (kode) => `${kode.slice(0, 4)}-${kode.slice(4)}`;

/** Det brukeren skrev inn → koden (store bokstaver, uten mellomrom og bindestrek). */
export const rensKode = (tekst) => tekst.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Feil fra Firestore og Firebase Auth med forklaring på norsk
export function feilTekst(feil) {
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
   * @param {(status: {tilstand: string, tekst: string}) => void} valg.naarStatus
   * @param {(bruker: {uid: string, epost: string} | null) => void} valg.naarBruker
   * @param {(lag: object | null) => void} valg.naarLag  laget du er med i, når det endres
   * @param {(tekst: string) => boolean} valg.bekreft  spør brukeren (standard: window.confirm)
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

    // Synkroniser kort tid etter at noe er endret (ikke for hver lille endring). Under en
    // synkronisering overses det, ellers ville importen av det som hentes, starte en ny.
    markeringer.naarEndret(() => {
      if (this.bruker && !this.pagar) this.planlegg();
    });
    window.addEventListener('online', () => {
      if (this.bruker) this.planlegg(1000);
    });
    // Hent endringer fra andre telefoner når appen kommer fram igjen
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

  get pagar() {
    return Boolean(this._pagaende);
  }

  /** Laget du er med i ({ id, navn, medlemmer, eposter, initialer }), eller null. */
  get lag() {
    return this.bruker ? hentTilstand().lag ?? null : null;
  }

  async _brukerEndret(bruker) {
    if (bruker) {
      const tilstand = hentTilstand();
      if (tilstand.uid && tilstand.uid !== bruker.uid && this.markeringer.alle().length) {
        // Markeringene på telefonen hører til en annen konto. Ikke bland dem inn i denne.
        const fjern = this.bekreft(
          `Telefonen har teiner og fangst fra en annen konto. De fjernes fra telefonen når du `
          + `logger inn som ${bruker.epost}. De ligger fortsatt i den andre kontoen. Fortsette?`);
        if (!fjern) {
          await this.innlogging.loggUt();
          return;
        }
        await this.markeringer.tomAlt();
        lagreTilstand({ uid: bruker.uid, kjent: {} });
      } else if (tilstand.uid !== bruker.uid) {
        // Første innlogging på telefonen: det som ligger her, lastes opp
        lagreTilstand({ uid: bruker.uid, kjent: {} });
      }
    }
    this.bruker = bruker;
    this.markeringer.registrertAv = bruker?.uid ?? null; // nye markeringer får med hvem som satte dem
    this.naarBruker?.(bruker);
    this.naarLag?.(this.lag);
    this.naarStatus(this.statusTekst());
    if (bruker) this.synkroniser();
  }

  statusTekst() {
    if (!this.bruker) return { tilstand: 'av', tekst: '' }; // innstillingsarket forklarer det selv
    const { sist, feil } = hentTilstand();
    if (feil) return { tilstand: 'feil', tekst: `Feil: ${feil}` };
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

  /** Antall endringer på telefonen som ikke er lagret i skyen ennå. */
  antallUsendte() {
    return this._usendte().length;
  }

  /**
   * Synkroniser nå. Returnerer { hentet, sendt }, { feil: tekst } eller null hvis det ikke
   * ble gjort (ikke innlogget eller uten nett). Pågår en synkronisering allerede, ventes
   * det på den.
   */
  synkroniser() {
    if (this._pagaende) return this._pagaende;
    if (!this.bruker) return Promise.resolve(null);
    if (!navigator.onLine) {
      this.naarStatus({ tilstand: 'venter', tekst: 'Uten nett. Synkroniserer når du får nett.' });
      return Promise.resolve(null);
    }
    clearTimeout(this._timer);
    this._pagaende = this._synkroniser().finally(() => {
      this._pagaende = null;
    });
    return this._pagaende;
  }

  async _synkroniser() {
    this.naarStatus({ tilstand: 'pagar', tekst: 'Synkroniserer …' });
    let resultat = null;
    try {
      // 1. Hvilket lag er du med i?
      await this._oppdaterLag();
      const rom = this._rom();

      // 2. Hent det som er endret i rommet siden sist
      const tilstand = hentTilstand();
      const endringer = await this.tjeneste.hentEndringer(rom, tilstand.sistHentet ?? null);
      const features = [];
      const slettet = [];
      for (const { id, data, oppdatertMs } of endringer) {
        tilstand.kjent[id] = data.endret;
        if (oppdatertMs != null) tilstand.sistHentet = Math.max(tilstand.sistHentet ?? 0, oppdatertMs);
        if (data.slettet) {
          slettet.push({ id, endret: data.endret });
        } else {
          const { lat, lon, slettet: _, ...egenskaper } = data;
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: egenskaper });
        }
      }
      let hentet = 0;
      if (endringer.length) {
        const r = await this.markeringer.importer({ type: 'FeatureCollection', features, slettet });
        hentet = r.nye + r.oppdaterte + r.slettet;
      }
      lagreTilstand(tilstand);

      // 3. Send det som er endret her
      const usendte = this._usendte();
      if (usendte.length) {
        await this.tjeneste.lagre(rom, usendte);
        const etter = hentTilstand();
        for (const { id, data } of usendte) etter.kjent[id] = data.endret;
        lagreTilstand(etter);
      }
      lagreTilstand({ ...hentTilstand(), sist: new Date().toISOString(), feil: null });
      this.naarStatus(this.statusTekst());
      resultat = { hentet, sendt: usendte.length };
      // Endret mens synkroniseringen pågikk? (naarEndret overses da, se konstruktøren)
      if (this._usendte().length) this.planlegg();
    } catch (feil) {
      console.error(feil);
      const tekst = feilTekst(feil);
      // Feil som ikke går over av seg selv, vises til de er rettet
      if (feil?.code === 'permission-denied' || feil?.code === 'not-found') {
        lagreTilstand({ ...hentTilstand(), feil: tekst });
      }
      this.naarStatus({ tilstand: 'feil', tekst: `Feil: ${tekst}` });
      resultat = { feil: tekst };
    }
    return resultat;
  }

  // ---------- Lag ----------

  /** Opprett et lag. Det du har, flyttes inn i laget. */
  async opprettLag(navn) {
    await this.synkroniser(); // få med siste endringer i kontoen først
    const lag = await this.tjeneste.opprettLag(this.bruker.uid, this.bruker.epost, navn);
    this._byttRom(`lag:${lag.id}`, lag);
    return this.synkroniser();
  }

  /** Bli med i laget med koden. Det du har, flyttes inn i laget, og du får lagets. */
  async blimedILag(kode) {
    await this.synkroniser();
    const lag = await this.tjeneste.blimed(kode, this.bruker.uid, this.bruker.epost);
    this._byttRom(`lag:${lag.id}`, lag);
    return this.synkroniser();
  }

  /** Forlat laget. Kontoen din får en kopi av lagets teiner og fangst. */
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
   * Logg ut. Lagrer først det som ikke er sendt. Uten nett spør den om det skal
   * kastes. Markeringene fjernes fra telefonen (de ligger i skyen).
   * Returnerer false hvis brukeren angret.
   */
  async loggUt() {
    await this.synkroniser();
    const usendte = this.antallUsendte();
    const hva = usendte === 1 ? '1 endring er' : `${usendte} endringer er`;
    if (usendte && !this.bekreft(`${hva} ikke lagret i kontoen ennå (uten nett?). `
      + 'Logger du ut nå, går det tapt. Logge ut likevel?')) {
      return false;
    }
    clearTimeout(this._timer);
    await this.innlogging.loggUt();
    await this.markeringer.tomAlt();
    lagreTilstand({ kjent: {} });
    return true;
  }

  /**
   * Slett kontoen og alt i kontoen. Er du med i et lag, går du ut av det (det du har
   * registrert der, blir liggende). Markeringene på telefonen beholdes.
   */
  async slettKonto(passord) {
    const uid = this.bruker.uid;
    await this.innlogging.bekreftPassord(passord);
    const lag = this.lag;
    if (lag) await this.tjeneste.fjernMedlem(lag.id, uid);
    await this.tjeneste.slettAlle(`bruker:${uid}`);
    await this.innlogging.slettBruker();
    lagreTilstand({ kjent: {} });
  }
}
