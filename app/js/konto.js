/*
 * Kontoen i appen: delen «Konto» i innstillingsarket, og arket for å logge inn,
 * opprette konto, få nytt passord og slette kontoen. Innloggingen og
 * synkroniseringen ligger i sky.js.
 *
 * Arkene er <dialog> med showModal(), så meldinger fra melding.js synes ikke mens et
 * ark er åpent. Svar vises derfor i arkene selv (feltet under knappene og
 * statuslinjen i innstillingene).
 */

import { feilTekst } from './sky.js';

const MODUS = {
  inn: {
    tittel: 'Logg inn',
    knapp: 'Logg inn',
    bytt: 'Ny her? Opprett konto',
    forklaring: 'Teiner og fangst lagres i kontoen din, og du får dem på alle telefoner du logger inn på.',
    passord: 'current-password',
  },
  opprett: {
    tittel: 'Opprett konto',
    knapp: 'Opprett konto',
    bytt: 'Har du konto? Logg inn',
    forklaring: 'Bruk e-posten din og et passord på minst 6 tegn. Det du har markert på denne '
      + 'telefonen, lagres i den nye kontoen.',
    passord: 'new-password',
  },
  slett: {
    tittel: 'Slett kontoen',
    knapp: 'Slett kontoen for godt',
    forklaring: 'Kontoen og alle teiner og fangst i skyen slettes og kan ikke hentes tilbake. '
      + 'Det som ligger på denne telefonen, blir liggende. Skriv passordet for å bekrefte.',
    passord: 'current-password',
  },
};

const $ = (id) => document.getElementById(id);

export class Konto {
  /** @param {import('./sky.js').Sky} sky */
  constructor(sky) {
    this.sky = sky;
    this.ark = $('ark-konto');
    this.skjema = this.ark.querySelector('form');
    this.modus = 'inn';

    this.skjema.addEventListener('submit', (e) => {
      e.preventDefault();
      this._send();
    });
    this.ark.addEventListener('click', (e) => {
      if (e.target === this.ark) this.ark.close(); // trykk på bakgrunnen
      const handling = e.target.closest('[data-handling]')?.dataset.handling;
      if (handling === 'bytt') this._settModus(this.modus === 'inn' ? 'opprett' : 'inn');
      if (handling === 'glemt') this._glemtPassord();
      if (handling === 'lukk') this.ark.close();
    });

    // Delen «Konto» i innstillingsarket
    $('knapp-logg-inn').addEventListener('click', () => this.vis('inn'));
    $('knapp-slett-konto').addEventListener('click', () => this.vis('slett'));
    $('knapp-synk').addEventListener('click', () => this._synkroniserNaa());
    $('knapp-logg-ut').addEventListener('click', () => this._loggUt());
  }

  /** Åpne arket for å logge inn ('inn'), opprette konto ('opprett') eller slette den ('slett'). */
  vis(modus) {
    this.skjema.reset();
    this._settModus(modus);
    if (modus === 'slett') this.skjema.elements.epost.value = this.sky.bruker?.epost ?? '';
    if (!this.ark.open) this.ark.showModal();
  }

  _settModus(modus) {
    this.modus = modus;
    const m = MODUS[modus];
    const sett = (navn, tekst) => { this.ark.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('tittel', m.tittel);
    sett('forklaring', m.forklaring);
    sett('bytt', m.bytt ?? '');
    this._visSvar('');
    const send = this.ark.querySelector('[data-handling="send"]');
    send.textContent = m.knapp;
    send.classList.toggle('fare', modus === 'slett');
    send.classList.toggle('ferdig', modus !== 'slett');
    const { epost, passord } = this.skjema.elements;
    epost.readOnly = modus === 'slett';
    passord.autocomplete = m.passord;
    this.ark.querySelector('[data-handling="bytt"]').hidden = modus === 'slett';
    this.ark.querySelector('[data-handling="glemt"]').hidden = modus !== 'inn';
  }

  // Svar til brukeren nederst i arket. feil: rød tekst.
  _visSvar(tekst, { feil = false } = {}) {
    const el = this.ark.querySelector('[data-tekst="svar"]');
    el.textContent = tekst;
    el.hidden = !tekst;
    el.classList.toggle('feil', feil);
  }

  async _send() {
    const epost = this.skjema.elements.epost.value.trim();
    const passord = this.skjema.elements.passord.value;
    if (!epost || !passord) {
      this._visSvar('Skriv inn e-post og passord.', { feil: true });
      return;
    }
    const knapp = this.ark.querySelector('[data-handling="send"]');
    knapp.disabled = true;
    this._visSvar(this.modus === 'slett' ? 'Sletter …' : 'Et øyeblikk …');
    try {
      if (this.modus === 'inn') await this.sky.loggInn(epost, passord);
      if (this.modus === 'opprett') await this.sky.opprettKonto(epost, passord);
      if (this.modus === 'slett') {
        await this.sky.slettKonto(passord);
        this.visStatus({ tilstand: 'av', tekst: 'Kontoen er slettet. Teiner og fangst på telefonen er beholdt.' });
      }
      this.ark.close();
    } catch (feil) {
      console.error(feil);
      this._visSvar(feilTekst(feil), { feil: true });
    } finally {
      knapp.disabled = false;
    }
  }

  async _glemtPassord() {
    const epost = this.skjema.elements.epost.value.trim();
    if (!epost) {
      this._visSvar('Skriv e-posten din først, så sender vi en lenke for å lage nytt passord.', { feil: true });
      return;
    }
    try {
      await this.sky.glemtPassord(epost);
      this._visSvar(`Har ${epost} en konto, kommer det en e-post med lenke for å lage nytt passord. `
        + 'Sjekk også søppelposten.');
    } catch (feil) {
      this._visSvar(feilTekst(feil), { feil: true });
    }
  }

  async _synkroniserNaa() {
    const r = await this.sky.synkroniser();
    if (r && !r.feil) {
      const hentet = r.hentet ? `${r.hentet} endringer hentet` : 'ingen nye endringer';
      const sendt = r.sendt ? `, ${r.sendt} sendt` : '';
      this.visStatus({ tilstand: 'ok', tekst: `Synkronisert: ${hentet}${sendt}.` });
    }
  }

  async _loggUt() {
    if (await this.sky.loggUt()) {
      this.visStatus({ tilstand: 'av', tekst: 'Logget ut. Teiner og fangst er fjernet fra telefonen, men ligger i kontoen.' });
    }
  }

  /** Vis innlogget/utlogget i innstillingsarket. */
  visBruker(bruker) {
    document.querySelector('.konto [data-vis="utlogget"]').hidden = Boolean(bruker);
    document.querySelector('.konto [data-vis="innlogget"]').hidden = !bruker;
    document.querySelector('.konto [data-tekst="epost"]').textContent = bruker?.epost ?? '';
  }

  /** Statuslinjen for synkroniseringen i innstillingsarket. */
  visStatus({ tilstand, tekst }) {
    $('skystatus').textContent = tekst;
    $('skystatus').dataset.tilstand = tilstand;
  }
}
