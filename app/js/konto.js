/*
 * Kontoen i appen: delen «Konto» i innstillingsarket, og arket for å logge inn,
 * opprette konto, få nytt passord og slette kontoen. Innloggingen og
 * synkroniseringen ligger i sky.js.
 *
 * Arkene er <dialog> med showModal(), så meldinger fra melding.js synes ikke mens et
 * ark er åpent. Svar vises derfor i arkene selv (feltet under knappene og
 * statuslinjen i innstillingene).
 */

import { feilTekst, rensKode, visKode } from './sky.js';

const MODUS = {
  inn: {
    tittel: 'Logg inn',
    knapp: 'Logg inn',
    bytt: 'Ny her? Opprett konto',
    forklaring: 'Teiner og fangst lagres i kontoen din, og du får dem på alle telefoner du logger inn på. '
      + 'Uten konto ligger alt bare på denne telefonen: trykk Avbryt for å bruke appen uten.',
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

const LAGMODUS = {
  opprett: {
    tittel: 'Opprett lag',
    etikett: 'Navn på laget',
    plassholder: 'F.eks. Båten vår',
    knapp: 'Opprett lag',
    forklaring: (n) => `Alt du har (${n}) flyttes inn i laget. Etterpå får du en kode som de andre `
      + 'skriver inn for å bli med. Alle i laget ser og kan endre alle teiner og all fangst.',
  },
  blimed: {
    tittel: 'Bli med i lag',
    etikett: 'Kode',
    plassholder: 'ABCD-EFGH',
    knapp: 'Bli med',
    forklaring: (n) => `Skriv koden du har fått. Alt du har (${n}) flyttes inn i laget, og du `
      + 'får lagets teiner og fangst.',
  },
};

const $ = (id) => document.getElementById(id);

function antallTekst(markeringer) {
  const alle = markeringer.alle();
  const teiner = alle.filter((m) => m.kategori === 'teine').length;
  const fangst = alle.length - teiner;
  return `${teiner} ${teiner === 1 ? 'teine' : 'teiner'} og ${fangst} `
    + (fangst === 1 ? 'fangstregistrering' : 'fangstregistreringer');
}

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

    // Lag
    this.lagArk = $('ark-lag');
    this.lagSkjema = this.lagArk.querySelector('form');
    this.lagModus = 'opprett';
    this.lagSkjema.addEventListener('submit', (e) => {
      e.preventDefault();
      this._sendLag();
    });
    this.lagArk.addEventListener('click', (e) => {
      if (e.target === this.lagArk || e.target.closest('[data-handling="lukk"]')) this.lagArk.close();
    });
    $('knapp-opprett-lag').addEventListener('click', () => this.visLagArk('opprett'));
    $('knapp-bli-med').addEventListener('click', () => this.visLagArk('blimed'));
    $('knapp-del-kode').addEventListener('click', () => this._delKode());
    $('knapp-forlat-lag').addEventListener('click', () => this._forlatLag());
    document.querySelector('.konto [data-liste="medlemmer"]').addEventListener('click', (e) => {
      const uid = e.target.closest('[data-fjern]')?.dataset.fjern;
      if (uid) this._fjernMedlem(uid);
    });
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
        this._melding('Kontoen er slettet. Teiner og fangst på telefonen er beholdt.');
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
      this._melding('Logget ut. Teiner og fangst er fjernet fra telefonen, men ligger i skyen.');
    }
  }

  // Melding under kontodelen som blir stående etter at du har logget ut eller slettet kontoen
  _melding(tekst) {
    $('kontomelding').textContent = tekst;
  }

  /** Vis innlogget/utlogget i innstillingsarket. */
  visBruker(bruker) {
    document.querySelector('.konto [data-vis="utlogget"]').hidden = Boolean(bruker);
    document.querySelector('.konto [data-vis="innlogget"]').hidden = !bruker;
    document.querySelector('.konto [data-tekst="epost"]').textContent = bruker?.epost ?? '';
    if (bruker) this._melding('');
  }

  // ---------- Lag ----------

  /** Vis laget du er med i (eller valgene for å opprette og bli med) i innstillingsarket. */
  visLag(lag) {
    const del = document.querySelector('.konto');
    del.querySelector('[data-lag="uten"]').hidden = Boolean(lag);
    del.querySelector('[data-lag="med"]').hidden = !lag;
    if (!lag) return;
    del.querySelector('[data-tekst="lagnavn"]').textContent = lag.navn;
    del.querySelector('[data-tekst="lagkode"]').textContent = visKode(lag.id);
    const meg = this.sky.bruker?.uid;
    const rader = lag.medlemmer.map((uid) => {
      const li = document.createElement('li');
      const tekst = document.createElement('span');
      tekst.className = 'radtekst';
      const b = document.createElement('b');
      b.textContent = lag.eposter?.[uid] ?? 'Ukjent';
      tekst.append(b);
      if (uid === meg) {
        const small = document.createElement('small');
        small.textContent = 'deg';
        tekst.append(small);
      }
      li.append(tekst);
      if (uid !== meg) {
        const knapp = document.createElement('button');
        Object.assign(knapp, { type: 'button', className: 'fjern', textContent: 'Fjern' });
        knapp.dataset.fjern = uid;
        li.append(knapp);
      }
      return li;
    });
    del.querySelector('[data-liste="medlemmer"]').replaceChildren(...rader);
  }

  visLagArk(modus) {
    this.lagModus = modus;
    const m = LAGMODUS[modus];
    this.lagSkjema.reset();
    const sett = (navn, tekst) => { this.lagArk.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('tittel', m.tittel);
    sett('etikett', m.etikett);
    sett('forklaring', m.forklaring(antallTekst(this.sky.markeringer)));
    this._visLagSvar('');
    const felt = this.lagSkjema.elements.verdi;
    felt.placeholder = m.plassholder;
    felt.autocapitalize = modus === 'blimed' ? 'characters' : 'sentences';
    felt.maxLength = modus === 'blimed' ? 12 : 40;
    this.lagArk.querySelector('[data-handling="send"]').textContent = m.knapp;
    if (!this.lagArk.open) this.lagArk.showModal();
  }

  _visLagSvar(tekst, { feil = false } = {}) {
    const el = this.lagArk.querySelector('[data-tekst="svar"]');
    el.textContent = tekst;
    el.hidden = !tekst;
    el.classList.toggle('feil', feil);
  }

  async _sendLag() {
    const verdi = this.lagSkjema.elements.verdi.value.trim();
    const kode = rensKode(verdi);
    if (this.lagModus === 'opprett' && !verdi) {
      this._visLagSvar('Gi laget et navn.', { feil: true });
      return;
    }
    if (this.lagModus === 'blimed' && kode.length !== 8) {
      this._visLagSvar('Koden har 8 tegn, for eksempel ABCD-EFGH.', { feil: true });
      return;
    }
    if (!navigator.onLine) {
      this._visLagSvar('Du må ha nett for å opprette eller bli med i et lag.', { feil: true });
      return;
    }
    const knapp = this.lagArk.querySelector('[data-handling="send"]');
    knapp.disabled = true;
    this._visLagSvar('Et øyeblikk …');
    try {
      const r = this.lagModus === 'opprett'
        ? await this.sky.opprettLag(verdi)
        : await this.sky.blimedILag(kode);
      if (r?.feil) throw Object.assign(new Error(r.feil), { tekst: r.feil });
      this.lagArk.close();
    } catch (feil) {
      console.error(feil);
      const ukjentKode = this.lagModus === 'blimed' && ['not-found', 'permission-denied'].includes(feil?.code);
      this._visLagSvar(ukjentKode ? 'Fant ikke noe lag med den koden. Sjekk at den er skrevet riktig.'
        : feil.tekst ?? feilTekst(feil), { feil: true });
    } finally {
      knapp.disabled = false;
    }
  }

  async _delKode() {
    const lag = this.sky.lag;
    if (!lag) return;
    const adresse = `${location.origin}${location.pathname}`;
    const tekst = `Bli med i laget «${lag.navn}» i Hummerkart. Åpne appen (${adresse}), logg inn, `
      + `og velg Innstillinger → Lag → Bli med i lag. Koden er ${visKode(lag.id)}.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Hummerkart', text: tekst });
      } else {
        await navigator.clipboard.writeText(tekst);
        this.visStatus({ tilstand: 'ok', tekst: 'Invitasjonen med koden er kopiert. Lim den inn i en melding.' });
      }
    } catch (feil) {
      if (feil?.name !== 'AbortError') this.visStatus({ tilstand: 'feil', tekst: `Koden er ${visKode(lag.id)}.` });
    }
  }

  async _forlatLag() {
    const lag = this.sky.lag;
    if (!lag) return;
    const siste = lag.medlemmer.length <= 1;
    if (!window.confirm(`Forlate laget «${lag.navn}»? Kontoen din får en kopi av lagets teiner og fangst.`
      + (siste ? ' Du er den siste i laget, så laget slettes.' : ''))) return;
    try {
      await this.sky.forlatLag();
    } catch (feil) {
      this.visStatus({ tilstand: 'feil', tekst: `Feil: ${feilTekst(feil)}` });
    }
  }

  async _fjernMedlem(uid) {
    const lag = this.sky.lag;
    const epost = lag?.eposter?.[uid] ?? 'medlemmet';
    if (!window.confirm(`Fjerne ${epost} fra laget? De beholder en kopi av det som ligger i laget nå.`)) return;
    try {
      await this.sky.fjernMedlem(uid);
    } catch (feil) {
      this.visStatus({ tilstand: 'feil', tekst: `Feil: ${feilTekst(feil)}` });
    }
  }

  /** Statuslinjen for synkroniseringen i innstillingsarket. */
  visStatus({ tilstand, tekst }) {
    $('skystatus').textContent = tekst;
    $('skystatus').dataset.tilstand = tilstand;
  }
}
