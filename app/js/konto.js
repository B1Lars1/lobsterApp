/*
 * Kontoen i appen: kontokortet øverst i innstillingsarket, undersidene Konto og Lag (også
 * om kontoen er koblet til skyen eller bare lagrer på telefonen), og arket for å logge inn,
 * få nytt passord og slette kontoen. Innloggingen og synkroniseringen ligger i sky.js, og
 * navigeringen mellom undersidene i app.js.
 * Kontoer kan ikke opprettes i appen: den som driver appen, legger dem til i
 * Firebase-konsollen (se README, «Oppsett i Firebase»).
 *
 * Arkene er <dialog> med showModal(), så meldinger fra melding.js synes ikke mens et
 * ark er åpent. Svar vises derfor i arkene selv: feltet under knappene, statuslinjen på
 * undersiden Konto (#skystatus) og linjen på undersiden Lag (#lagmelding).
 */

import { GYLDIGE_INITIALER, personer } from './personer.js';
import { feilTekst, rensKode, synkTekst, visKode } from './sky.js';

const MODUS = {
  inn: {
    tittel: 'Logg inn',
    knapp: 'Logg inn',
    forklaring: 'Du må være logget inn for å sette teiner og registrere fangst. Som standard lagres de '
      + 'bare på telefonen. I innstillingene kan du koble kontoen til skyen for sikkerhetskopi, flere '
      + 'telefoner og lag. Kontoer lages av den som driver appen. Trykk Avbryt for å bare se på kartet.',
    passord: 'current-password',
  },
  slett: {
    tittel: 'Slett kontoen',
    knapp: 'Slett kontoen for godt',
    forklaring: 'Kontoen og det som ligger i den i skyen, slettes og kan ikke hentes tilbake. '
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
    forklaring: (n, koblet) => `Alt du har (${n}) flyttes inn i laget${koblet ? '' : ' i skyen'}. `
      + 'Etterpå får du en kode som de andre skriver inn for å bli med. Alle i laget ser og kan '
      + `endre alle teiner og all fangst.${koblet ? '' : KOBLES_TIL}`,
  },
  blimed: {
    tittel: 'Bli med i lag',
    etikett: 'Kode',
    plassholder: 'ABCD-EFGH',
    knapp: 'Bli med',
    forklaring: (n, koblet) => `Skriv koden du har fått. Alt du har (${n}) flyttes inn i laget, og du `
      + `får lagets teiner og fangst.${koblet ? '' : KOBLES_TIL}`,
  },
};

// Til lagarket når kontoen bare lagrer på telefonen
const KOBLES_TIL = ' Kontoen kobles til skyen, og det tas sikkerhetskopi.';

// Spørsmålene før kontoen kobles til eller fra skyen (window.confirm)
const KOBLE_TIL = (antall) => 'Koble til skyen?\n\n'
  + `Teinene og fangsten din (${antall}), og alt du lagrer senere, lastes opp til kontoen din i skyen `
  + '(Google Firebase, i EU). Du får dem på alle telefonene du logger inn på, og det tas '
  + 'sikkerhetskopi hver natt, og hver time fra 1. oktober til 15. desember. Sikkerhetskopien '
  + 'ligger hos den som driver appen.\n\nDu kan koble fra igjen senere.';
const KOBLE_FRA = 'Lagre bare på denne telefonen?\n\n'
  + '• Du kan ikke være med i et lag.\n'
  + '• Det tas ingen sikkerhetskopi. Mister eller bytter du telefon, eller fjerner appen fra '
  + 'hjemskjermen, er teinene og fangsten borte. Lagre en kopi til fil innimellom '
  + '(Innstillinger → Sikkerhetskopi).\n'
  + '• De kommer ikke lenger på andre telefoner. Hver telefon med kontoen beholder det den har.\n\n'
  + 'Alt i kontoen din i skyen slettes, men det som ligger på telefonen, blir liggende. Eldre '
  + 'sikkerhetskopier slettes ikke av seg selv. Be den som driver appen om det hvis du vil.';

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
      if (handling === 'glemt') this._glemtPassord();
      if (handling === 'lukk') this.ark.close();
    });

    // Undersiden Konto i innstillingsarket (kontokortet på hovedsiden kobles opp i app.js)
    this.innst = $('ark-innstillinger');
    $('knapp-slett-konto').addEventListener('click', () => this.vis('slett'));
    $('knapp-synk').addEventListener('click', () => this._synkroniserNaa());
    $('knapp-logg-ut').addEventListener('click', () => this._loggUt());
    $('knapp-koble-til').addEventListener('click', () => this._kobleTil());
    $('knapp-koble-fra').addEventListener('click', () => this._kobleFra());

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
    // Trykk på et annet medlem viser «Fjern fra laget» under det
    this._aapentMedlem = null;
    this.innst.querySelector('[data-liste="medlemmer"]').addEventListener('click', (e) => {
      const uid = e.target.closest('[data-fjern]')?.dataset.fjern;
      if (uid) {
        this._fjernMedlem(uid);
        return;
      }
      const rad = e.target.closest('[data-medlem]');
      if (!rad) return;
      const apen = rad.getAttribute('aria-expanded') !== 'true';
      this._aapentMedlem = apen ? rad.dataset.medlem : null;
      this._visMedlemsvalg();
    });
    $('felt-initialer').addEventListener('change', () => this._lagreInitialer());
    $('felt-initialer').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // ikke send skjemaet (det lukker innstillingene)
        e.target.blur();
      }
    });
  }

  /** Åpne arket for å logge inn ('inn') eller slette kontoen ('slett'). */
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
    this._visSvar('');
    const send = this.ark.querySelector('[data-handling="send"]');
    send.textContent = m.knapp;
    send.classList.toggle('fare', modus === 'slett');
    send.classList.toggle('ferdig', modus !== 'slett');
    const { epost, passord } = this.skjema.elements;
    epost.readOnly = modus === 'slett';
    passord.autocomplete = m.passord;
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
    if (r && !r.feil && !r.lokal) this._skystatus({ tilstand: 'ok', tekst: synkTekst(r) });
  }

  async _loggUt() {
    await this.sky.loggUt();
    this._melding('Logget ut. Teiner og fangst ligger fortsatt på telefonen.');
  }

  async _kobleTil() {
    if (!navigator.onLine) {
      this._skystatus({ tilstand: 'feil', tekst: 'Du må ha nett for å koble til skyen.' });
      return;
    }
    if (!window.confirm(KOBLE_TIL(antallTekst(this.sky.markeringer)))) return;
    try {
      await this.sky.kobleTil(); // statuslinjen viser hvordan det gikk
    } catch (feil) {
      this._skystatus({ tilstand: 'feil', tekst: `Feil: ${feilTekst(feil)}` });
    }
  }

  async _kobleFra() {
    if (!navigator.onLine) {
      this._skystatus({ tilstand: 'feil', tekst: 'Du må ha nett for å koble fra skyen.' });
      return;
    }
    if (!window.confirm(KOBLE_FRA)) return;
    try {
      const r = await this.sky.kobleFra();
      if (!r?.feil && !this.sky.koblet) {
        this._melding('Koblet fra skyen. Teiner og fangst lagres bare på denne telefonen.');
      }
    } catch (feil) {
      this._skystatus({ tilstand: 'feil', tekst: `Feil: ${feilTekst(feil)}` });
    }
  }

  // Melding under kontokortet som blir stående etter at du har logget ut eller slettet kontoen
  _melding(tekst) {
    $('kontomelding').textContent = tekst;
  }

  /** Vis innlogget/utlogget i innstillingsarket. */
  visBruker(bruker) {
    for (const el of this.innst.querySelectorAll('[data-vis="utlogget"]')) el.hidden = Boolean(bruker);
    for (const el of this.innst.querySelectorAll('[data-vis="innlogget"]')) el.hidden = !bruker;
    this.innst.querySelector('[data-tekst="epost"]').textContent = bruker?.epost ?? '';
    if (bruker) this._melding('');
    this._visKontokort();
  }

  // Kontokortet: initialene (fra laget, ellers første bokstav i e-posten), e-posten og om
  // kontoen er koblet til skyen. Statusen er den siste fra sky.js (se visStatus).
  _visKontokort() {
    const bruker = this.sky.bruker;
    const kort = $('knapp-konto');
    const sett = (navn, tekst) => { kort.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    const status = this._sistStatus ?? this.sky.statusTekst();
    let { tilstand, tekst } = status;
    if (!bruker) {
      tilstand = 'av';
      tekst = 'for å sette teiner og registrere fangst';
    } else if (tilstand === 'lokal' || (!this.sky.koblet && !['feil', 'venter'].includes(tilstand))) {
      tilstand = 'lokal';
      tekst = 'Bare på denne telefonen';
    } else if (tilstand === 'ok' || tilstand === 'pagar') {
      tekst = `Koblet til skyen · ${tekst.charAt(0).toLowerCase()}${tekst.slice(1)}`;
    }
    sett('avatar', bruker ? this.sky.lag?.initialer?.[bruker.uid] ?? (bruker.epost ?? '?').charAt(0).toUpperCase() : '');
    sett('kontonavn', bruker ? bruker.epost : 'Logg inn');
    sett('kontostatus', tekst.replace(/\.$/, ''));
    kort.querySelector('[data-tekst="kontostatus"]').dataset.tilstand = tilstand;
    kort.setAttribute('aria-label', bruker ? `Konto: ${bruker.epost}. ${tekst}` : 'Logg inn');
  }

  // ---------- Lag ----------

  /** Vis laget du er med i (eller valgene for å opprette og bli med) i innstillingsarket. */
  visLag(lag) {
    const side = this.innst.querySelector('[data-side="lag"]');
    side.querySelector('[data-lag="uten"]').hidden = Boolean(lag);
    side.querySelector('[data-lag="med"]').hidden = !lag;
    this.innst.querySelector('[data-tekst="lagverdi"]').textContent =
      lag ? `${lag.navn} · ${lag.medlemmer.length}` : 'Ikke med i et lag';
    this._visSky();
    this._visKontokort();
    if (!lag) return;
    side.querySelector('[data-tekst="lagnavn"]').textContent = lag.navn;
    side.querySelector('[data-tekst="lagkode"]').textContent = visKode(lag.id);
    const meg = this.sky.bruker?.uid;
    const rader = lag.medlemmer.map((uid) => {
      const li = document.createElement('li');
      const epost = lag.eposter?.[uid] ?? 'Ukjent';
      const initialer = lag.initialer?.[uid];
      // Initialene i personens farge, ellers starten av e-posten, så alle står på linje
      const merke = document.createElement('span');
      merke.className = 'eier-merke';
      merke.textContent = initialer ?? epost.slice(0, 2);
      const tekst = document.createElement('span');
      tekst.className = 'radtekst';
      const b = document.createElement('b');
      b.textContent = epost;
      const small = document.createElement('small');
      small.textContent = uid === meg ? 'deg' : initialer ? '' : 'Har ikke satt initialer';
      tekst.append(b);
      if (small.textContent) tekst.append(small);
      if (uid === meg) {
        merke.classList.add('min');
        li.append(merke, tekst);
        return li;
      }
      merke.style.background = personer.farge(uid);
      const rad = document.createElement('button');
      Object.assign(rad, { type: 'button', className: 'rad' });
      rad.dataset.medlem = uid;
      rad.append(merke, tekst);
      const fjern = document.createElement('button');
      Object.assign(fjern, { type: 'button', className: 'fjern', textContent: 'Fjern fra laget' });
      fjern.dataset.fjern = uid;
      li.append(rad, fjern);
      return li;
    });
    side.querySelector('[data-liste="medlemmer"]').replaceChildren(...rader);
    if (!lag.medlemmer.includes(this._aapentMedlem)) this._aapentMedlem = null;
    this._visMedlemsvalg();
    if (document.activeElement !== $('felt-initialer')) $('felt-initialer').value = lag.initialer?.[meg] ?? '';
  }

  // «Fjern fra laget» under medlemmet som er trykket på (høyst ett om gangen). Huskes når
  // listen tegnes på nytt ved synkroniseringen.
  _visMedlemsvalg() {
    for (const rad of this.innst.querySelectorAll('[data-medlem]')) {
      const apen = rad.dataset.medlem === this._aapentMedlem;
      rad.setAttribute('aria-expanded', String(apen));
      rad.nextElementSibling.hidden = !apen;
    }
  }

  // Initialene dine i laget: 1–3 bokstaver, lagres når feltet forlates. Tomt felt fjerner dem.
  async _lagreInitialer() {
    const felt = $('felt-initialer');
    const initialer = felt.value.toUpperCase().replace(/[^A-ZÆØÅ]/g, '');
    const hjelp = $('initialer-hjelp');
    if (initialer && !GYLDIGE_INITIALER.test(initialer)) {
      hjelp.textContent = 'Initialene kan ha 1–3 bokstaver, for eksempel BL.';
      hjelp.classList.add('feil');
      return;
    }
    felt.value = initialer;
    if (initialer === (this.sky.lag?.initialer?.[this.sky.bruker?.uid] ?? '')) return;
    if (!navigator.onLine) {
      hjelp.textContent = 'Du må ha nett for å lagre initialene.';
      hjelp.classList.add('feil');
      return;
    }
    try {
      await this.sky.settInitialer(initialer || null);
      hjelp.textContent = initialer ? `Lagret. De andre i laget ser ${initialer} på teinene dine.` : 'Initialene er fjernet.';
      hjelp.classList.remove('feil');
    } catch (feil) {
      console.error(feil);
      hjelp.textContent = feilTekst(feil);
      hjelp.classList.add('feil');
    }
  }

  visLagArk(modus) {
    this.lagModus = modus;
    const m = LAGMODUS[modus];
    this.lagSkjema.reset();
    const sett = (navn, tekst) => { this.lagArk.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('tittel', m.tittel);
    sett('etikett', m.etikett);
    sett('forklaring', m.forklaring(antallTekst(this.sky.markeringer), this.sky.koblet));
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
        this._lagmelding('Invitasjonen med koden er kopiert. Lim den inn i en melding.');
      }
    } catch (feil) {
      if (feil?.name !== 'AbortError') this._lagmelding(`Koden er ${visKode(lag.id)}.`, { feil: true });
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
      this._lagmelding(`Feil: ${feilTekst(feil)}`, { feil: true });
    }
  }

  async _fjernMedlem(uid) {
    const lag = this.sky.lag;
    const epost = lag?.eposter?.[uid] ?? 'medlemmet';
    if (!window.confirm(`Fjerne ${epost} fra laget? De beholder en kopi av det som ligger i laget nå.`)) return;
    try {
      await this.sky.fjernMedlem(uid);
    } catch (feil) {
      this._lagmelding(`Feil: ${feilTekst(feil)}`, { feil: true });
    }
  }

  /** Statusen fra sky.js: i kontokortet og i statuslinjen på undersiden Konto. */
  visStatus(status) {
    this._sistStatus = status;
    this._skystatus(status);
    this._visKontokort();
  }

  // Statuslinjen på undersiden Konto, også for svar på det du gjør der
  _skystatus({ tilstand, tekst }) {
    $('skystatus').textContent = tekst;
    $('skystatus').dataset.tilstand = tilstand;
    this._visSky();
  }

  // Linjen på undersiden Lag: svar på det du gjør der (kopiert invitasjon, feil)
  _lagmelding(tekst, { feil = false } = {}) {
    $('lagmelding').textContent = tekst;
    $('lagmelding').classList.toggle('feil', feil);
  }

  // Koblet til skyen eller bare på telefonen: vis tekstene og knappene som gjelder.
  // Koble fra skyen går ikke i et lag.
  _visSky() {
    const koblet = this.sky.koblet;
    this.innst.querySelectorAll('[data-sky]').forEach((el) => {
      el.hidden = (el.dataset.sky === 'koblet') !== koblet;
    });
    const kobleFra = $('knapp-koble-fra');
    kobleFra.disabled = Boolean(this.sky.lag);
    kobleFra.querySelector('[data-tekst="kobleFra"]').textContent =
      this.sky.lag ? 'Gå ut av laget først' : 'Lagre bare på denne telefonen';
  }
}
