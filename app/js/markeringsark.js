/*
 * Arkene (panelene nederfra) og handlingene for markeringer:
 *   - «Sett teine» (ett trykk) og «Hummer her» (åpner et ark, fangsten lagres først
 *     ved «Ferdig»), begge med GPS-posisjonen
 *   - valg etter langt trykk i kartet (marker et valgfritt sted)
 *   - detaljer for en teine eller fangst: endre, ta opp, flytte, slette
 *   - listen over teiner i sjøen med avstand og retning, og under den all fangst
 *     (som kan rettes) og slettede markeringer (som kan gjenopprettes)
 *   - advarsel når en teine havner i et fredningsområde, og info om området
 *
 * I et lag har hver teine en eier (personer.js). De andres teiner har nummeret i sin farge og
 * initialene i navnet («Teine 3 (OL)»), teinelisten er delt per person, og eieren kan endres
 * i teinearket. Alle kan likevel ta opp og registrere fangst på alle teinene.
 *
 * Alt som endrer eller fjerner noe, viser en melding med «Angre».
 */

import { bekreft } from './bekreft.js';
import { MAKS_NOTAT } from './markeringer.js';
import { visMelding } from './melding.js';
import { hummersesong } from './oversikt.js';
import { personer } from './personer.js';

const tidFormat = new Intl.DateTimeFormat('nb-NO', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const formaterTid = (iso) => tidFormat.format(new Date(iso));

// <input type="datetime-local"> bruker lokal tid uten tidssone, f.eks. «2026-10-14T19:05».
function tilLokalTid(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function formaterSiden(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'nå nettopp';
  if (min < 60) return `${min} min siden`;
  const timer = Math.round(min / 60);
  if (timer < 48) return `${timer} t siden`;
  return `${Math.round(timer / 24)} døgn siden`;
}

// Anslått dybde vises i hele meter.
// Med hardt mellomrom, så «ca. 22 m» ikke brekkes over to linjer.
export const formaterDybde = (dybde) => `ca.\u00a0${Math.round(dybde)}\u00a0m`;

const formaterAvstand = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

// Kompasskurs i grader fra nord, fra a til b.
function kurs(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r)
    - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const RETNINGER = ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'];
const kompass = (grader) => RETNINGER[Math.round(grader / 45) % 8];

const PIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 19 21 12 17 5 21Z" fill="currentColor"/></svg>';

// Lag DOM fra en HTML-mal. Tekst fra brukeren settes etterpå med textContent/value, aldri i HTML.
function fraMal(html) {
  const mal = document.createElement('template');
  mal.innerHTML = html.trim();
  return mal.content;
}

// « (OL)» etter navnet på en annens teine i laget, ellers ingenting
const eierTillegg = (uid) => (personer.erMeg(uid) ? '' : ` (${personer.kortnavn(uid)})`);
// «Teine 3», eller «Teine 3 (OL)» når teinen er en annens
const teinenavn = (t) => `Teine ${t.nummer ?? '?'}${eierTillegg(t.registrert_av)}`;
const navnPa = (m) => (m.kategori === 'teine' ? teinenavn(m) : 'Fangst');

// Nummeret på en annens teine i eierens farge (symbolet er en .symbol.teine med <span> inni)
function fargeNummer(symbol, t) {
  if (personer.erMeg(t.registrert_av)) return;
  const span = symbol.querySelector('span');
  span.classList.add('annen');
  span.style.setProperty('--eier', personer.farge(t.registrert_av));
}

// Fangst med 0 beholdt og 0 satt ut: teinen var tom da den ble tatt opp (eller sjekket).
const erSjekk = (f) => f.beholdt + f.satt_ut === 0;

export class Markeringsark {
  constructor({ kart, gps, markeringer, kartmarkeringer, fredning }) {
    this.kart = kart;
    this.fredning = fredning;
    this.gps = gps;
    this.markeringer = markeringer;
    this.kartmarkeringer = kartmarkeringer;
    this.arkMarkering = document.getElementById('ark-markering');
    this.arkVelg = document.getElementById('ark-velg');
    this.arkTeiner = document.getElementById('ark-teiner');
    this.arkFredning = document.getElementById('ark-fredning');
    this.aapenId = null;
    this._utkast = null; // ny fangst som ikke er lagret ennå (se registrerFangst)
    this._utkastTittel = ''; // overskriften i arket for utkastet
    this._sikte = null;
    this._aapnetTid = 0;
    this._eldreFangst = new Map(); // sesongår → fangst fra tidligere sesonger (teinelisten)
    this._apneSesonger = new Set(); // de eldre sesongene som er åpnet i teinelisten

    for (const ark of [this.arkMarkering, this.arkVelg, this.arkTeiner, this.arkFredning]) {
      // Trykk på den mørke bakgrunnen utenfor arket lukker det.
      ark.addEventListener('click', (e) => {
        if (e.target === ark) ark.close();
      });
    }

    // Detaljarket: én lytter for alle knapper og felt. data-id er en annen markering
    // knappen gjelder (fangstradene i teinearket).
    this.arkMarkering.addEventListener('click', (e) => {
      const knapp = e.target.closest('[data-handling]');
      if (knapp) this._handling(knapp.dataset.handling, knapp.dataset.felt, knapp.dataset.id);
    });
    this.arkMarkering.addEventListener('change', (e) => this._feltEndret(e.target));
    this.arkMarkering.addEventListener('close', () => {
      if (this._utkast) {
        // Lukket uten «Ferdig» (Avbryt, dratt ned, trykk utenfor): ny fangst lagres ikke.
        this._utkast = null;
        visMelding('Fangsten ble ikke registrert');
      } else {
        const notat = this.arkMarkering.querySelector('[data-felt="notat"]');
        if (notat) this._feltEndret(notat); // lagre notat selv om feltet ikke mistet fokus
      }
      this.aapenId = null;
    });

    // Velg-arket etter langt trykk
    this.arkVelg.addEventListener('click', (e) => {
      const valg = e.target.closest('[data-valg]')?.dataset.valg;
      // Ignorer «spøkelsestrykk» fra fingeren som slipper skjermen rett etter langt trykk.
      if (!valg || Date.now() - this._aapnetTid < 450) return;
      this.arkVelg.close();
      if (valg === 'teine') this.settTeine(this._valgtPos);
      if (valg === 'hummer') this.registrerFangst(this._valgtPos);
    });
    this.arkVelg.addEventListener('close', () => this._sikte?.remove());

    // Teinelisten
    this.arkTeiner.addEventListener('click', (e) => this._listeKlikk(e));
    // En eldre sesong i fangstlisten åpnes eller lukkes («toggle» bobler ikke, så fang den
    // på vei ned). Radene lages først når sesongen åpnes.
    this.arkTeiner.addEventListener('toggle', (e) => {
      const aar = e.target.dataset?.sesong;
      if (!aar) return;
      if (!e.target.open) {
        this._apneSesonger.delete(aar);
        return;
      }
      this._apneSesonger.add(aar);
      if (!e.target.querySelector('li')) this._fyllSesong(e.target);
    }, true);

    this.arkFredning.querySelector('[data-handling="lukk"]')
      .addEventListener('click', () => this.arkFredning.close());

    // Hold arkene oppdatert når markeringene endres. Et åpent utkast lukkes ikke
    // (det finnes ikke i markeringene ennå, og f.eks. synkronisering kan endre dem).
    markeringer.naarEndret(() => {
      if (this.arkMarkering.open && !this._utkast && !markeringer.hent(this.aapenId)) this.arkMarkering.close();
      if (this.arkTeiner.open) this._tegnTeineliste();
    });
    // Laget eller initialene er endret. Det åpne detaljarket tegnes ikke på nytt (du kan
    // holde på å skrive et notat), det får de nye navnene neste gang det åpnes.
    personer.naarEndret(() => {
      if (this.arkTeiner.open) this._tegnTeineliste();
    });
  }

  // ---------- Posisjon ----------

  _gpsPosisjon() {
    const p = this.gps.posisjon;
    if (!p) {
      visMelding('Ingen GPS-posisjon ennå. Trykk lenge i kartet for å markere et sted.', { ms: 4500 });
      return null;
    }
    return { lat: p.latlng.lat, lon: p.latlng.lng, noyaktighet: Math.round(p.noyaktighet), kilde: 'gps' };
  }

  _sjekkLagring() {
    if (!this.markeringer.lagringVirker) {
      visMelding('Advarsel: telefonen lagrer ikke markeringene. Hold appen åpen til de er synkronisert.', { ms: 6000 });
    }
  }

  // ---------- Handlinger fra de store knappene ----------

  async settTeine(pos = this._gpsPosisjon()) {
    if (!pos) return;
    const t = await this.markeringer.nyTeine(pos);
    this._sjekkLagring();
    const angre = { knapp: 'Angre', handling: () => this.markeringer.slett(t.id, { husk: false }) };
    const omrade = this._fredningFor(t);
    if (omrade) {
      visMelding(`${teinenavn(t)} er satt i fredningsområdet ${omrade.navn}. Teiner er forbudt der!`,
        { ...angre, ms: 10000, fare: true });
      return;
    }
    const usikker = pos.noyaktighet > 50 ? ` (usikker GPS ± ${pos.noyaktighet} m)` : '';
    visMelding(`${teinenavn(t)} satt${usikker}`, angre);
  }

  // ---------- Fredningsområder ----------

  /** Fredningsområdet en teine i sjøen ligger i, ellers null. */
  _fredningFor(m) {
    if (!this.fredning || m.kategori !== 'teine' || m.status !== 'i_sjoen') return null;
    return this.fredning.omradeFor(m.lat, m.lon);
  }

  /** Kalles etter at en markering er flyttet: advar hvis en teine havnet i et fredningsområde. */
  etterFlytt(id) {
    const m = this.markeringer.hent(id);
    const omrade = m && this._fredningFor(m);
    if (omrade) {
      visMelding(`${teinenavn(m)} ligger i fredningsområdet ${omrade.navn}. Teiner er forbudt der!`,
        { ms: 8000, fare: true });
    }
  }

  /** Vis navn, regel og lenker for et fredningsområde. */
  visFredning(omrade) {
    const ark = this.arkFredning;
    ark.querySelector('[data-tekst="navn"]').textContent = omrade.navn;
    ark.querySelector('[data-tekst="regel"]').textContent = omrade.regel;
    ark.querySelector('[data-lenke="forskrift"]').href = omrade.forskrift;
    ark.querySelector('[data-lenke="oversikt"]').href = omrade.oversikt;
    if (!ark.open) ark.showModal();
  }

  /**
   * Begynn på en ny fangst. Den knyttes til nærmeste teine i sjøen innen 50 m, hvis ikke
   * annet er oppgitt. Fangsten er bare et utkast i arket og lagres først når du trykker
   * «Ferdig», så et feiltrykk ikke blir liggende som en registrering.
   */
  registrerFangst(pos = this._gpsPosisjon(), teine = undefined,
    { beholdt = 1, tittel = 'Ny hummerfangst', tittelTeine = null } = {}) {
    if (!pos) return;
    const fra = teine === undefined ? this.markeringer.naermesteTeine(L.latLng(pos.lat, pos.lon)) : teine;
    this._utkast = {
      ...pos, kategori: 'hummer', teine_id: fra?.id ?? null, beholdt, satt_ut: 0, notat: '',
      tid: new Date().toISOString(),
    };
    this._utkastTittel = tittel;
    this._utkastTittelTeine = tittelTeine; // teinen som står i overskriften («Teine 3 tatt opp»)
    this.aapenId = null;
    this.arkMarkering.querySelector('.innhold').replaceChildren(this._fangstInnhold(this._utkast));
    this._visUtkastUndertekst();
    if (!this.arkMarkering.open) this.arkMarkering.showModal();
  }

  async _lagreUtkast() {
    const notat = this.arkMarkering.querySelector('[data-felt="notat"]');
    const utkast = { ...this._utkast, notat: notat.value }; // notatet kan ha fokus ennå
    this._utkast = null; // før arket lukkes, så det ikke regnes som avbrutt
    this.arkMarkering.close();
    const f = await this.markeringer.nyFangst(utkast);
    this._sjekkLagring();
    // Fangst fra en teine i sjøen betyr at teinen er tatt opp i båten (også med 0 hummer).
    // Settes den ut igjen, er det en ny setting med «Sett teine».
    const teine = this._teineSomTasOpp(f.teine_id);
    if (teine) await this.markeringer.oppdater(teine.id, { status: 'tatt_opp', tatt_opp: f.tid });
    const hva = erSjekk(f) ? 'Registrert: ingen hummer' : `Fangst registrert: ${f.beholdt} beholdt, ${f.satt_ut} satt ut`;
    visMelding(`${hva}${teine ? `. ${teinenavn(teine)} er tatt opp` : ''}`, {
      knapp: 'Angre',
      handling: async () => {
        await this.markeringer.slett(f.id, { husk: false });
        if (teine) await this.markeringer.oppdater(teine.id, { status: 'i_sjoen', tatt_opp: null });
      },
    });
  }

  /**
   * «Tatt opp» for én teine: åpne arket for fangsten fra den, med 0 hummer som utgangspunkt
   * (de fleste opptak er tomme). Teinen markeres som tatt opp først når man trykker «Ferdig».
   */
  _taOppMedFangst(t) {
    this.registrerFangst({ lat: t.lat, lon: t.lon, noyaktighet: t.noyaktighet, kilde: t.kilde }, t,
      { beholdt: 0, tittel: `${teinenavn(t)} tatt opp`, tittelTeine: t.id });
  }

  // Teinen en ny fangst kommer fra, hvis den står i sjøen og derfor skal tas opp. Ellers null.
  _teineSomTasOpp(teineId) {
    const t = this.markeringer.hent(teineId);
    return t?.status === 'i_sjoen' ? t : null;
  }

  // Underteksten i arket for ny fangst: si fra hvilken teine som tas opp når man trykker
  // «Ferdig», hvis den ikke står i overskriften allerede. Står under overskriften i stedet
  // for på egen linje, så arket blir lavere. Linjen med tidspunkt og teine følger med.
  _visUtkastUndertekst() {
    if (!this._utkast) return;
    const t = this._teineSomTasOpp(this._utkast.teine_id);
    this.arkMarkering.querySelector('[data-tekst="undertekst"]').textContent =
      t && t.id !== this._utkastTittelTeine
        ? `${teinenavn(t)} tas opp når du trykker Ferdig`
        : 'Registreres når du trykker Ferdig';
    const sammendrag = this.arkMarkering.querySelector('[data-tekst="sammendrag"]');
    if (!sammendrag) return;
    const fra = this.markeringer.hent(this._utkast.teine_id);
    const naar = Date.now() - Date.parse(this._utkast.tid) < 120000 ? 'Nå' : formaterTid(this._utkast.tid);
    sammendrag.textContent = `${naar} · ${fra ? teinenavn(fra) : 'ingen teine'}`;
  }

  // ---------- Langt trykk i kartet ----------

  visVelgType(latlng) {
    this._sikte?.remove();
    this._sikte = L.marker(latlng, {
      icon: L.divIcon({ className: 'sikte', iconSize: [48, 48] }),
      interactive: false,
      keyboard: false,
    }).addTo(this.kart);
    this._valgtPos = { lat: latlng.lat, lon: latlng.lng, noyaktighet: null, kilde: 'kart' };
    this._aapnetTid = Date.now();
    this.arkVelg.showModal();
  }

  // ---------- Detaljark ----------

  visMarkering(id) {
    const m = this.markeringer.hent(id);
    if (!m) return;
    this._utkast = null;
    this.aapenId = id;
    const innhold = m.kategori === 'teine' ? this._teineInnhold(m) : this._fangstInnhold(m);
    this.arkMarkering.querySelector('.innhold').replaceChildren(innhold);
    if (!this.arkMarkering.open) this.arkMarkering.showModal();
  }

  _avstandTekst(m) {
    const her = this.gps.posisjon?.latlng;
    if (!her) return '–';
    const der = L.latLng(m.lat, m.lon);
    const avstand = her.distanceTo(der);
    return avstand < 10 ? 'Her' : `${formaterAvstand(avstand)} ${kompass(kurs(her, der))}`;
  }

  _teineInnhold(m) {
    const iSjoen = m.status === 'i_sjoen';
    const fangst = this.markeringer.alle().filter((f) => f.teine_id === m.id);
    const beholdt = fangst.reduce((s, f) => s + f.beholdt, 0);
    const sattUt = fangst.reduce((s, f) => s + f.satt_ut, 0);

    // Hovedknappen: tatt opp (i sjøen), funnet igjen (mistet) eller sett ut igjen (tatt opp)
    const hovedknapp = iSjoen
      ? '<button type="button" class="stor teine-farge" data-handling="taOpp">Tatt opp</button>'
      : m.mistet
        ? '<button type="button" class="stor teine-farge" data-handling="funnet">Funnet igjen</button>'
        : '<button type="button" class="stor teine-farge" data-handling="settUtIgjen">Sett ut igjen her</button>';
    const status = iSjoen ? ['i-sjoen', 'I sjøen'] : m.mistet ? ['mistet', 'Mistet'] : ['', 'Tatt opp'];

    const el = fraMal(`
      <div class="ark-topp">
        <div class="symbol teine ${iSjoen ? '' : 'opptatt'}"><span data-tekst="nummer"></span></div>
        <div class="ark-tittel">
          <h3><span data-tekst="tittel"></span><select class="eier-valg" data-felt="eier" aria-label="Eier" hidden></select></h3>
          <p data-tekst="undertekst"></p>
        </div>
        <span class="status ${status[0]}">${status[1]}</span>
      </div>
      <button type="button" class="fredningsvarsel" data-handling="visFredning" hidden>
        <b>Ligger i et fredningsområde</b><span data-tekst="fredning"></span>
      </button>
      <dl class="fakta">
        <div><dt>Avstand</dt><dd data-tekst="avstand"></dd></div>
        <div><dt>Dybde</dt><dd data-tekst="dybde"></dd></div>
        <div><dt>Fangst</dt><dd data-tekst="fangst"></dd></div>
      </dl>
      <ul class="liste fangst-i-teine" data-liste="fangst"></ul>
      <div class="felter">
        <label class="felt smal">Nummer<input type="number" inputmode="numeric" min="1" data-felt="nummer"></label>
        ${iSjoen ? '<label class="felt ved-siden">Satt<input type="datetime-local" data-felt="tid"></label>' : ''}
        <label class="felt">Notat<textarea rows="2" maxlength="${MAKS_NOTAT}" data-felt="notat" placeholder="F.eks. agn, bunn, merke på blåsen"></textarea></label>
      </div>
      <div class="knapper">
        ${hovedknapp}
        <div class="smaa-knapper">
          <button type="button" class="sekundar" data-handling="flytt">Flytt</button>
          ${iSjoen ? '<button type="button" class="sekundar" data-handling="mistet" aria-label="Mistet teine">Mistet</button>' : ''}
          <button type="button" class="fare" data-handling="slett">Slett</button>
        </div>
        <button type="button" class="ferdig" data-handling="lukk">Ferdig</button>
      </div>`);

    const sett = (navn, tekst) => { el.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('nummer', m.nummer ?? '?');
    fargeNummer(el.querySelector('.ark-topp .symbol'), m);
    sett('tittel', `Teine ${m.nummer ?? '?'}`);
    sett('undertekst', iSjoen
      ? this._sattTekst(m.tid)
      : `${m.mistet ? 'Mistet' : 'Tatt opp'} ${formaterTid(m.tatt_opp)}`);
    if (personer.iLag) this._fyllEiervalg(el.querySelector('[data-felt="eier"]'), m);
    sett('avstand', this._avstandTekst(m));
    sett('dybde', m.dybde != null ? formaterDybde(m.dybde) : '–');
    sett('fangst', beholdt + sattUt ? `${beholdt} beholdt, ${sattUt} satt ut` : 'Ingen ennå');
    // Hver fangstregistrering fra teinen. Fangsten ligger ofte under teinen på kartet,
    // så her er veien til å rette eller slette den.
    for (const f of [...fangst].sort((a, b) => b.tid.localeCompare(a.tid))) {
      const rad = this._fangstRad(f);
      Object.assign(rad.querySelector('.rad').dataset, { handling: 'visFangst', id: f.id });
      el.querySelector('[data-liste="fangst"]').append(rad);
    }
    el.querySelector('[data-felt="nummer"]').value = m.nummer ?? '';
    if (iSjoen) el.querySelector('[data-felt="tid"]').value = tilLokalTid(m.tid);
    el.querySelector('[data-felt="notat"]').value = m.notat;
    const omrade = this._fredningFor(m);
    if (omrade) {
      el.querySelector('.fredningsvarsel').hidden = false;
      sett('fredning', `${omrade.navn}. Teiner er forbudt her. Trykk for regler.`);
    }
    return el;
  }

  // Eieren i teinearket: deg, de andre i laget, og eieren teinen har nå hvis den er en
  // annen (tidligere medlem, ukjent). Ser ut som en merkelapp i eierens farge.
  _fyllEiervalg(valg, m) {
    const eier = m.registrert_av ?? null;
    for (const uid of personer.rekkefolge([eier])) {
      const navn = uid === personer.meg ? 'Meg' : personer.kortnavn(uid);
      valg.append(new Option(navn, uid ?? ''));
    }
    valg.value = eier ?? '';
    valg.hidden = false;
    if (!personer.erMeg(eier)) {
      valg.classList.add('annen');
      valg.style.setProperty('--eier', personer.farge(eier));
    }
  }

  // «Satt tir. 14. okt. 19:37 · 3 t siden» for en teine i sjøen
  _sattTekst(tid) {
    return `Satt ${formaterTid(tid)} · ${formaterSiden(tid)}`;
  }

  // « · av OL» når en annen i laget har registrert fangsten, ellers ingenting
  _avTekst(m) {
    return personer.iLag && !personer.erMeg(m.registrert_av) ? ` · av ${personer.kortnavn(m.registrert_av)}` : '';
  }

  // Rad for én fangstregistrering: antall, tidspunkt og teine. Den som bruker raden,
  // bestemmer hva et trykk gjør (data-vis i teinelisten, data-handling i teinearket).
  _fangstRad(f) {
    const sjekk = erSjekk(f);
    const li = fraMal(`
      <li>
        <button type="button" class="rad">
          <span class="symbol hummer${sjekk ? ' sjekk' : ''}"><span class="emoji">${sjekk ? '✓' : '🦞'}</span></span>
          <span class="radtekst"><b data-tekst="tittel"></b><small data-tekst="info"></small></span>
          <span class="endre">Endre</span>
        </button>
      </li>`);
    const teine = this.markeringer.hent(f.teine_id);
    li.querySelector('[data-tekst="tittel"]').textContent =
      sjekk ? 'Ingen hummer' : `${f.beholdt} beholdt, ${f.satt_ut} satt ut`;
    li.querySelector('[data-tekst="info"]').textContent =
      `${formaterTid(f.tid)} · ${teine ? `teine ${teine.nummer}${eierTillegg(teine.registrert_av)}` : 'ingen teine'}`
      + this._avTekst(f);
    return li;
  }

  // Fangstarket. Uten id er det en ny fangst (utkast) som lagres først ved «Ferdig».
  _fangstInnhold(m) {
    const ny = !m.id;
    const sjekk = !ny && erSjekk(m);
    const tittel = ny ? this._utkastTittel : sjekk ? 'Ingen hummer' : 'Hummerfangst';
    const el = fraMal(`
      <div class="ark-topp">
        <div class="symbol hummer${sjekk ? ' sjekk' : ''}"><span class="emoji">${sjekk ? '✓' : '🦞'}</span></div>
        <div class="ark-tittel"><h3 data-tekst="tittel"></h3><p data-tekst="undertekst"></p></div>
      </div>
      <div class="teller">
        <span>Beholdt</span>
        <button type="button" data-handling="minus" data-felt="beholdt" aria-label="Én mindre beholdt">−</button>
        <output data-tekst="beholdt"></output>
        <button type="button" data-handling="pluss" data-felt="beholdt" aria-label="Én mer beholdt">+</button>
      </div>
      <div class="teller">
        <span>Satt ut</span>
        <button type="button" data-handling="minus" data-felt="satt_ut" aria-label="Én mindre satt ut">−</button>
        <output data-tekst="satt_ut"></output>
        <button type="button" data-handling="pluss" data-felt="satt_ut" aria-label="Én mer satt ut">+</button>
      </div>
      ${ny
        ? `<div class="sammendrag">
            <span class="radtekst"><small>Tidspunkt og teine</small><b data-tekst="sammendrag"></b></span>
            <button type="button" class="lenke" data-handling="endreTidTeine">Endre</button>
          </div>`
        : ''}
      <div class="felter">
        <label class="felt" data-tid-teine ${ny ? 'hidden' : ''}>Tidspunkt<input type="datetime-local" data-felt="tid"></label>
        <label class="felt" data-tid-teine ${ny ? 'hidden' : ''}>Fra teine<select data-felt="teine_id"></select></label>
        <label class="felt">Notat<textarea rows="2" maxlength="${MAKS_NOTAT}" data-felt="notat" placeholder="F.eks. lengde, rognhummer"></textarea></label>
      </div>
      ${ny
        ? `<div class="knapper avbryt-ferdig">
            <button type="button" class="sekundar" data-handling="lukk">Avbryt</button>
            <button type="button" class="ferdig" data-handling="lagreFangst">Ferdig</button>
          </div>`
        : `<div class="knapper">
            <button type="button" class="sekundar" data-handling="flytt">Flytt</button>
            <button type="button" class="fare" data-handling="slett">Slett</button>
            <button type="button" class="ferdig" data-handling="lukk">Ferdig</button>
          </div>`}`);

    // Tittelen kan ha initialene eller e-posten til en annen i laget («Teine 3 (OL) tatt opp»),
    // så den settes som tekst, aldri i HTML-malen.
    el.querySelector('[data-tekst="tittel"]').textContent = tittel;
    // For ny fangst fylles underteksten inn av _visUtkastUndertekst()
    if (!ny) el.querySelector('[data-tekst="undertekst"]').textContent = formaterTid(m.tid) + this._avTekst(m);
    el.querySelector('[data-tekst="beholdt"]').textContent = m.beholdt;
    el.querySelector('[data-tekst="satt_ut"]').textContent = m.satt_ut;
    el.querySelector('[data-felt="tid"]').value = tilLokalTid(m.tid);
    el.querySelector('[data-felt="notat"]').value = m.notat;

    // Teinene i sjøen (dine først), pluss den fangsten allerede er knyttet til (selv om den er tatt opp)
    const valg = el.querySelector('[data-felt="teine_id"]');
    valg.append(new Option('Ingen', ''));
    const teiner = this.markeringer.teinerISjoen()
      .sort((a, b) => this.markeringer.erMin(b) - this.markeringer.erMin(a));
    const knyttet = this.markeringer.hent(m.teine_id);
    if (knyttet && !teiner.includes(knyttet)) teiner.unshift(knyttet);
    for (const t of teiner) valg.append(new Option(teinenavn(t), t.id));
    valg.value = m.teine_id ?? '';
    return el;
  }

  async _handling(navn, felt, annenId) {
    const id = this.aapenId;
    const m = this._utkast ?? this.markeringer.hent(id);
    if (!m) return;
    switch (navn) {
      case 'lukk':
        this.arkMarkering.close();
        break;
      case 'lagreFangst':
        await this._lagreUtkast();
        break;
      case 'visFangst':
        this.visMarkering(annenId);
        break;
      case 'visFredning':
        this.visFredning(this._fredningFor(m));
        break;
      case 'endreTidTeine':
        // Ny fangst: vis feltene for tidspunkt og teine i stedet for linjen
        this.arkMarkering.querySelector('.sammendrag').hidden = true;
        this.arkMarkering.querySelectorAll('[data-tid-teine]').forEach((el) => { el.hidden = false; });
        break;
      case 'taOpp':
        this._taOppMedFangst(m);
        break;
      case 'mistet':
      case 'funnet': {
        // Teinen er mistet (regnes som tatt opp, med ukjent fangst), eller funnet igjen
        this.arkMarkering.close();
        const for_ = { status: m.status, tatt_opp: m.tatt_opp, mistet: m.mistet ?? false };
        if (navn === 'mistet') await this.markeringer.merkMistet(id);
        else await this.markeringer.funnetIgjen(id);
        visMelding(navn === 'mistet'
          ? `${teinenavn(m)} er meldt mistet. Den står med «?» på kartet til du finner den.`
          : `${teinenavn(m)} er funnet og står i sjøen igjen`, {
          knapp: 'Angre',
          handling: () => this.markeringer.oppdater(id, for_),
          ms: 6000,
        });
        break;
      }
      case 'settUtIgjen': {
        // Ny utsetting med samme nummer og eier. Den gamle beholdes som historikk.
        const pos = this._gpsPosisjon();
        if (!pos) return;
        this.arkMarkering.close();
        const ny = await this.markeringer.nyTeine({ ...pos, nummer: m.nummer, registrert_av: m.registrert_av });
        visMelding(`${teinenavn(ny)} satt ut igjen`, {
          knapp: 'Angre',
          handling: () => this.markeringer.slett(ny.id, { husk: false }),
        });
        this.etterFlytt(ny.id);
        break;
      }
      case 'flytt':
        this.arkMarkering.close();
        this.startFlytt(id);
        break;
      case 'slett': {
        this.arkMarkering.close();
        const slettet = await this.markeringer.slett(id);
        visMelding(`${navnPa(slettet)} slettet`, {
          knapp: 'Angre',
          handling: () => this.markeringer.gjenopprett(slettet),
        });
        break;
      }
      case 'pluss':
      case 'minus': {
        const verdi = Math.max(0, m[felt] + (navn === 'pluss' ? 1 : -1));
        await this._endre(m, { [felt]: verdi });
        this.arkMarkering.querySelector(`[data-tekst="${felt}"]`).textContent = verdi;
        break;
      }
      default:
        break;
    }
  }

  // Endre markeringen som vises: et utkast endres bare i minnet, ellers lagres endringen.
  _endre(m, endringer) {
    if (m === this._utkast) return Object.assign(m, endringer);
    return this.markeringer.oppdater(m.id, endringer);
  }

  _feltEndret(el) {
    const m = this._utkast ?? this.markeringer.hent(this.aapenId);
    const felt = el.dataset?.felt;
    if (!m || !felt) return;
    if (felt === 'nummer') {
      const nummer = parseInt(el.value, 10);
      if (!(nummer >= 1) || nummer === m.nummer) return;
      if (this.markeringer.nummerBrukt(nummer, m.registrert_av, m.id)) {
        visMelding(`Obs: ${teinenavn({ ...m, nummer }).replace('Teine', 'teine')} finnes allerede i sjøen`);
      }
      this.markeringer.oppdater(m.id, { nummer });
      this.arkMarkering.querySelector('[data-tekst="nummer"]').textContent = nummer;
      this.arkMarkering.querySelector('[data-tekst="tittel"]').textContent = `Teine ${nummer}`;
    } else if (felt === 'eier' && (el.value || null) !== (m.registrert_av ?? null)) {
      // Teinen er en annens (eller din): samme nummer, ny eier
      const eier = el.value || null;
      if (m.status === 'i_sjoen' && this.markeringer.nummerBrukt(m.nummer, eier, m.id)) {
        visMelding(`Obs: ${teinenavn({ ...m, registrert_av: eier }).replace('Teine', 'teine')} finnes allerede i sjøen`);
      }
      this.markeringer.oppdater(m.id, { registrert_av: eier }).then(() => this.visMarkering(m.id));
    } else if (felt === 'notat' && el.value !== m.notat) {
      this._endre(m, { notat: el.value });
    } else if (felt === 'teine_id' && (el.value || null) !== m.teine_id) {
      this._endre(m, { teine_id: el.value || null });
      this._visUtkastUndertekst();
    } else if (felt === 'tid' && el.value && el.value !== tilLokalTid(m.tid)) {
      const tid = new Date(el.value).toISOString(); // feltets verdi tolkes som lokal tid
      if (tid > new Date(Date.now() + 60000).toISOString()) { // litt slingringsmonn for klokka
        visMelding('Tidspunktet kan ikke være frem i tid', { fare: true });
        el.value = tilLokalTid(m.tid);
        return;
      }
      this._endre(m, { tid });
      if (m !== this._utkast) {
        // Teine: når den ble satt (teinedøgn og tidslinje regnes fra dette). Fangst: når den ble tatt.
        this.arkMarkering.querySelector('[data-tekst="undertekst"]').textContent =
          m.kategori === 'teine' ? this._sattTekst(tid) : formaterTid(tid) + this._avTekst(m);
      }
    }
  }

  // ---------- Flytting ----------

  startFlytt(id) {
    const m = this.markeringer.hent(id);
    this.kartmarkeringer.startFlytt(id);
    this.kart.panTo([m.lat, m.lon]);
    document.body.classList.add('flyttemodus');
    const linje = document.getElementById('flyttelinje');
    linje.querySelector('[data-handling="tilMeg"]').onclick = async () => {
      const pos = this._gpsPosisjon();
      if (!pos) return;
      await this.markeringer.oppdater(id, pos);
      this.etterFlytt(id);
    };
    linje.querySelector('[data-handling="ferdig"]').onclick = () => this.stoppFlytt();
  }

  stoppFlytt() {
    this.kartmarkeringer.stoppFlytt();
    document.body.classList.remove('flyttemodus');
  }

  // ---------- Teineliste ----------

  visTeineliste() {
    this._tegnTeineliste();
    this.arkTeiner.showModal();
  }

  _tegnTeineliste() {
    const teiner = this.markeringer.teinerISjoen();
    const mine = teiner.filter((t) => this.markeringer.erMin(t));
    const her = this.gps.posisjon?.latlng;
    this.arkTeiner.querySelector('[data-tekst="antall"]').textContent = teiner.length;
    const taOppAlle = this.arkTeiner.querySelector('[data-handling="taOppAlle"]');
    taOppAlle.hidden = mine.length < 2;
    taOppAlle.textContent = `${personer.iLag ? 'Ta opp alle mine' : 'Ta opp alle'} (${mine.length})`;

    const rad = (t) => {
      const li = fraMal(`
        <li>
          <button type="button" class="rad">
            <span class="symbol teine"><span data-tekst="nummer"></span></span>
            <span class="radtekst">
              <span class="radlinje"><b data-tekst="tittel"></b>
                <span class="avstand"><span class="pil">${PIL}</span><span data-tekst="avstand"></span></span></span>
              <small data-tekst="info"></small>
            </span>
          </button>
          <button type="button" class="ta-opp">Ta opp</button>
        </li>`);
      li.querySelector('.rad').dataset.vis = t.id;
      li.querySelector('.ta-opp').dataset.taOpp = t.id;
      li.querySelector('[data-tekst="nummer"]').textContent = t.nummer;
      fargeNummer(li.querySelector('.symbol'), t);
      li.querySelector('[data-tekst="tittel"]').textContent = `Teine ${t.nummer}`;
      // Uten «ca.», så linjen får plass ved siden av symbolet også på smale telefoner
      const dybde = t.dybde != null ? ` · ${Math.round(t.dybde)}\u00a0m` : '';
      li.querySelector('[data-tekst="info"]').textContent = `Satt ${formaterSiden(t.tid)}${dybde}`;
      const der = L.latLng(t.lat, t.lon);
      const avstand = her?.distanceTo(der);
      if (avstand >= 10) {
        const grader = kurs(her, der);
        li.querySelector('.pil').style.transform = `rotate(${grader}deg)`;
        li.querySelector('[data-tekst="avstand"]').textContent = `${formaterAvstand(avstand)} ${kompass(grader)}`;
      } else {
        li.querySelector('.pil').hidden = true;
        li.querySelector('[data-tekst="avstand"]').textContent = her ? 'Her' : '';
      }
      return li;
    };
    const rader = personer.iLag ? this._grupperPerEier(teiner, rad) : teiner.map(rad);
    const liste = this.arkTeiner.querySelector('[data-liste="teiner"]');
    if (rader.length) liste.replaceChildren(...rader);
    else liste.replaceChildren(fraMal('<li class="tom">Ingen teiner i sjøen. Trykk «Sett teine» når du setter en.</li>'));

    this._tegnSlettede();

    // Din fangst i hummersesongen (den som pågår, eller den siste), som i fangstoversikten
    const sesong = hummersesong();
    const iSesongen = this.markeringer.alle().filter((m) => m.kategori === 'hummer' && this.markeringer.erMin(m)
      && Date.parse(m.tid) >= sesong.fra && Date.parse(m.tid) < sesong.til);
    const beholdt = iSesongen.reduce((s, f) => s + f.beholdt, 0);
    const sattUt = iSesongen.reduce((s, f) => s + f.satt_ut, 0);
    this.arkTeiner.querySelector('[data-tekst="sesong"]').textContent =
      `${personer.iLag ? 'Dine i sesongen' : 'Sesongen'} ${sesong.aar}: ${beholdt} beholdt · ${sattUt} satt ut`;

    // All fangst, sist registrert først. Trykk åpner fangsten, så den kan rettes eller slettes.
    // Fangsten fra sesongen som pågår (eller den siste, fra 1. oktober) vises med en gang.
    // Tidligere sesonger ligger sammenslått under, og radene lages først når en åpnes, så
    // listen holder seg rask etter flere år.
    const fangst = this.markeringer.alle().filter((m) => m.kategori === 'hummer')
      .sort((a, b) => b.tid.localeCompare(a.tid));
    const sesongAar = (f) => hummersesong(Date.parse(f.tid)).aar;
    const denne = fangst.filter((f) => sesongAar(f) >= sesong.aar);
    this._eldreFangst = new Map();
    for (const f of fangst) {
      const aar = sesongAar(f);
      if (aar < sesong.aar) {
        if (!this._eldreFangst.has(aar)) this._eldreFangst.set(aar, []);
        this._eldreFangst.get(aar).push(f);
      }
    }
    const fangstdel = this.arkTeiner.querySelector('[data-del="fangst"]');
    fangstdel.hidden = fangst.length === 0;
    fangstdel.querySelector('[data-tekst="antallFangst"]').textContent = fangst.length;
    fangstdel.querySelector('[data-liste="fangst"]').replaceChildren(...denne.map((f) => this._fangstRadIListen(f)));
    fangstdel.querySelector('[data-liste="eldre-fangst"]').replaceChildren(...[...this._eldreFangst].map(([aar, liste]) => {
      const del = fraMal(`
        <details class="utvidbar">
          <summary><span>Sesongen <span data-tekst="aar"></span> (<span data-tekst="antall"></span>)</span></summary>
          <ul class="liste"></ul>
        </details>`).firstElementChild;
      del.dataset.sesong = aar;
      del.querySelector('[data-tekst="aar"]').textContent = aar;
      del.querySelector('[data-tekst="antall"]').textContent = liste.length;
      if (this._apneSesonger.has(String(aar))) {
        this._fyllSesong(del);
        del.open = true;
      }
      return del;
    }));
  }

  // Rad i fangstlisten: trykk åpner fangsten (data-vis, se _listeKlikk)
  _fangstRadIListen(f) {
    const rad = this._fangstRad(f);
    rad.querySelector('.rad').dataset.vis = f.id;
    return rad;
  }

  // Lag radene for en eldre sesong i fangstlisten (når den åpnes)
  _fyllSesong(del) {
    const liste = this._eldreFangst.get(Number(del.dataset.sesong)) ?? [];
    del.querySelector('ul').replaceChildren(...liste.map((f) => this._fangstRadIListen(f)));
  }

  // Teinene i grupper per eier: «Mine» først, så de andre i laget (med initialene i sin farge),
  // og til slutt tidligere medlemmer og teiner uten eier.
  _grupperPerEier(teiner, rad) {
    const nokkel = (t) => (this.markeringer.erMin(t) ? personer.meg : t.registrert_av ?? null);
    const rader = [];
    for (const uid of personer.rekkefolge(teiner.map(nokkel))) {
      const gruppe = teiner.filter((t) => nokkel(t) === uid);
      if (!gruppe.length) continue;
      const overskrift = fraMal('<li class="gruppe"><span class="eier-merke"></span><span data-tekst="navn"></span></li>');
      const merke = overskrift.querySelector('.eier-merke');
      if (uid === personer.meg) {
        merke.remove();
        overskrift.querySelector('[data-tekst="navn"]').textContent = `Mine (${gruppe.length})`;
      } else {
        merke.textContent = personer.kortnavn(uid);
        merke.style.background = personer.farge(uid);
        overskrift.querySelector('[data-tekst="navn"]').textContent = `(${gruppe.length})`;
      }
      rader.push(overskrift, ...gruppe.map(rad));
    }
    return rader;
  }

  // Slettede markeringer, sist slettet først, så en sletting kan angres også senere.
  _tegnSlettede() {
    const slettede = this.markeringer.slettede();
    this.arkTeiner.querySelector('[data-del="slettede"]').hidden = slettede.length === 0;
    this.arkTeiner.querySelector('[data-tekst="antallSlettede"]').textContent = slettede.length;
    const rader = slettede.map(({ endret, markering: m }) => {
      const teine = m.kategori === 'teine';
      const li = fraMal(`
        <li>
          <span class="rad">
            <span class="symbol slettet ${teine ? 'teine' : 'hummer'}"><span data-tekst="symbol"></span></span>
            <span class="radtekst"><b data-tekst="tittel"></b><small data-tekst="info"></small></span>
          </span>
          <button type="button" class="gjenopprett">Gjenopprett</button>
        </li>`);
      const symbol = li.querySelector('[data-tekst="symbol"]');
      if (teine) symbol.textContent = m.nummer ?? '?';
      else Object.assign(symbol, { className: 'emoji', textContent: '🦞' });
      li.querySelector('[data-tekst="tittel"]').textContent = navnPa(m);
      li.querySelector('[data-tekst="info"]').textContent =
        `Slettet ${formaterSiden(endret)} · ${teine ? 'satt' : 'registrert'} ${formaterTid(m.tid)}`;
      li.querySelector('.gjenopprett').dataset.gjenopprett = m.id;
      return li;
    });
    this.arkTeiner.querySelector('[data-liste="slettede"]').replaceChildren(...rader);
  }

  async _listeKlikk(e) {
    if (e.target === this.arkTeiner) return; // bakgrunnsklikk håndteres i konstruktøren
    const vis = e.target.closest('[data-vis]')?.dataset.vis;
    const taOpp = e.target.closest('[data-ta-opp]')?.dataset.taOpp;
    const gjenopprett = e.target.closest('[data-gjenopprett]')?.dataset.gjenopprett;
    const handling = e.target.closest('[data-handling]')?.dataset.handling;

    if (vis) {
      const t = this.markeringer.hent(vis);
      this.arkTeiner.close();
      this.kart.setView([t.lat, t.lon], Math.max(this.kart.getZoom(), 16));
      this.visMarkering(vis);
    } else if (gjenopprett) {
      const slettet = this.markeringer.slettede().find((s) => s.id === gjenopprett);
      if (!slettet) return;
      const m = await this.markeringer.gjenopprett(slettet.markering);
      const nummerBrukt = m.kategori === 'teine' && m.status === 'i_sjoen'
        && this.markeringer.nummerBrukt(m.nummer, m.registrert_av, m.id);
      visMelding(`${navnPa(m)} gjenopprettet${nummerBrukt ? `. Obs: det står en ${navnPa(m).replace('Teine', 'teine')} i sjøen fra før` : ''}`,
        { ms: nummerBrukt ? 5000 : undefined });
    } else if (taOpp) {
      this.arkTeiner.close();
      this._taOppMedFangst(this.markeringer.hent(taOpp));
    } else if (handling === 'taOppAlle') {
      // I et lag bare dine egne: de andres teiner står der de står
      const teiner = this.markeringer.teinerISjoen().filter((t) => this.markeringer.erMin(t));
      if (!(await bekreft({
        tittel: personer.iLag ? `Ta opp alle dine ${teiner.length} teiner?` : `Ta opp alle ${teiner.length} teinene?`,
        tekst: ['De tas opp uten å registrere fangst, for eksempel ved sesongslutt. Det kan angres.'],
        knapp: 'Ta opp alle',
      }))) return;
      for (const t of teiner) await this.markeringer.taOpp(t.id);
      visMelding(`${teiner.length} teiner tatt opp`, {
        knapp: 'Angre',
        handling: async () => {
          for (const t of teiner) await this.markeringer.oppdater(t.id, { status: 'i_sjoen', tatt_opp: null });
        },
      });
    } else if (handling === 'lukk') {
      this.arkTeiner.close();
    }
  }
}
