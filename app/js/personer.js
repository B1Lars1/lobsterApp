/*
 * Personene i laget: hvem du er, initialene og fargen til de andre, og om en teine er din.
 * Brukes av kartsymbolene, arkene og fangstoversikten. app.js holder den oppdatert fra sky.js.
 *
 * Eieren av en teine er registrert_av (den som satte den, kan endres i teinearket). Fangst
 * hører til eieren av teinen den kom fra (se Markeringer.eierAv). Uten lag er alt ditt. I et
 * lag er teiner uten eier (fra før dere hadde konto) «ukjent»: de er ikke dine, og eieren kan
 * settes i teinearket.
 *
 * Initialene setter hver person selv under Lag i innstillingene. De ligger i lagdokumentet
 * (lag/{kode}.initialer). Mangler de, brukes starten av e-posten.
 */

// Fargene til de andre i laget, i rekkefølgen i lag.medlemmer (uten deg). Dine egne teiner
// ser ut som før. Ikke rødt (fredning, hummer), oransje (teinene, tarekanten) eller lilla
// (hummerpotensialet), og mørke nok til hvit tekst.
const FARGER = ['#185fa5', '#1e7d4a', '#a3345e', '#0f6e6e', '#7a5a12', '#3c3489'];
const UKJENT_FARGE = '#6b7580';

// Samme regel som i firestore.rules
export const GYLDIGE_INITIALER = /^[A-ZÆØÅ]{1,3}$/;

export class Personer {
  constructor() {
    this.meg = null; // bruker-id når du er logget inn
    this.lag = null; // { id, navn, medlemmer, eposter, initialer } eller null
    this._lyttere = new Set();
  }

  /** Oppdater hvem du er og laget (kalles av app.js når sky.js melder endringer). */
  sett({ meg = this.meg, lag = this.lag } = {}) {
    // sky.js melder laget ved hver synkronisering. Tegn bare på nytt når noe er endret.
    const ny = JSON.stringify([meg ?? null, lag ?? null]);
    if (ny === this._forrige) return;
    this._forrige = ny;
    this.meg = meg ?? null;
    this.lag = lag ?? null;
    for (const f of this._lyttere) f();
  }

  naarEndret(funksjon) {
    this._lyttere.add(funksjon);
  }

  get iLag() {
    return Boolean(this.lag);
  }

  /** Er eieren (bruker-id eller null) deg? Uten eier er den din bare når du ikke er i et lag. */
  erMeg(uid) {
    if (uid == null) return !this.lag;
    return uid === this.meg;
  }

  /** De andre i laget, i fast rekkefølge. */
  andre() {
    return (this.lag?.medlemmer ?? []).filter((uid) => uid !== this.meg);
  }

  /** Initialene, ellers starten av e-posten, «Tidligere medlem» eller «Ukjent». */
  kortnavn(uid) {
    if (uid == null) return 'Ukjent';
    const initialer = this.lag?.initialer?.[uid];
    if (initialer) return initialer;
    const epost = this.lag?.eposter?.[uid];
    return epost ? epost.split('@')[0] : 'Tidligere medlem';
  }

  /** Fargen på nummeret til en annens teine. Tidligere medlemmer og ukjente er grå. */
  farge(uid) {
    const i = this.andre().indexOf(uid);
    return i >= 0 ? FARGER[i % FARGER.length] : UKJENT_FARGE;
  }

  /**
   * Eierne som skal vises, i rekkefølge: deg, de andre i laget, og til slutt eiere som
   * finnes i eiere (tidligere medlemmer, ukjent). Brukes til grupper i lister og tidslinjen.
   */
  rekkefolge(eiere = []) {
    const liste = [this.meg, ...this.andre()];
    for (const uid of eiere) if (!liste.includes(uid ?? null)) liste.push(uid ?? null);
    return liste;
  }
}

export const personer = new Personer();
