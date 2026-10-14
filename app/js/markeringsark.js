/*
 * Arkene (panelene nederfra) og handlingene for markeringer:
 *   - «Sett teine» og «Hummer her» (ett trykk, bruker GPS-posisjonen)
 *   - valg etter langt trykk i kartet (marker et valgfritt sted)
 *   - detaljer for en teine eller fangst: endre, ta opp, flytte, slette
 *   - listen over teiner i sjøen med avstand og retning, og under den slettede
 *     markeringer som kan gjenopprettes
 *   - advarsel når en teine havner i et fredningsområde, og info om området
 *
 * Alt som endrer eller fjerner noe, viser en melding med «Angre».
 */

import { visMelding } from './melding.js';

const tidFormat = new Intl.DateTimeFormat('nb-NO', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const formaterTid = (iso) => tidFormat.format(new Date(iso));

function formaterSiden(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'nå nettopp';
  if (min < 60) return `${min} min siden`;
  const timer = Math.round(min / 60);
  if (timer < 48) return `${timer} t siden`;
  return `${Math.round(timer / 24)} døgn siden`;
}

// Anslått dybde vises i hele meter.
export const formaterDybde = (dybde) => `ca. ${Math.round(dybde)} m`;

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

const navnPa = (m) => (m.kategori === 'teine' ? `Teine ${m.nummer}` : 'Fangst');

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
    this._sikte = null;
    this._aapnetTid = 0;

    for (const ark of [this.arkMarkering, this.arkVelg, this.arkTeiner, this.arkFredning]) {
      // Trykk på den mørke bakgrunnen utenfor arket lukker det.
      ark.addEventListener('click', (e) => {
        if (e.target === ark) ark.close();
      });
    }

    // Detaljarket: én lytter for alle knapper og felt.
    this.arkMarkering.addEventListener('click', (e) => {
      const knapp = e.target.closest('[data-handling]');
      if (knapp) this._handling(knapp.dataset.handling, knapp.dataset.felt);
    });
    this.arkMarkering.addEventListener('change', (e) => this._feltEndret(e.target));
    this.arkMarkering.addEventListener('close', () => {
      const notat = this.arkMarkering.querySelector('[data-felt="notat"]');
      if (notat) this._feltEndret(notat); // lagre notat selv om feltet ikke mistet fokus
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

    this.arkFredning.querySelector('[data-handling="lukk"]')
      .addEventListener('click', () => this.arkFredning.close());

    // Hold arkene oppdatert når markeringene endres
    markeringer.naarEndret(() => {
      if (this.arkMarkering.open && !markeringer.hent(this.aapenId)) this.arkMarkering.close();
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
      visMelding('Advarsel: nettleseren lagrer ikke markeringene. Eksporter før du lukker appen.', { ms: 6000 });
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
      visMelding(`Teine ${t.nummer} er satt i fredningsområdet ${omrade.navn}. Teiner er forbudt der!`,
        { ...angre, ms: 10000, fare: true });
      return;
    }
    const usikker = pos.noyaktighet > 50 ? ` (usikker GPS ± ${pos.noyaktighet} m)` : '';
    visMelding(`Teine ${t.nummer} satt${usikker}`, angre);
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
      visMelding(`Teine ${m.nummer} ligger i fredningsområdet ${omrade.navn}. Teiner er forbudt der!`,
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

  /** Registrer fangst. Knyttes til nærmeste teine i sjøen innen 50 m, hvis ikke annet er oppgitt. */
  async registrerFangst(pos = this._gpsPosisjon(), teine = undefined) {
    if (!pos) return;
    const fra = teine === undefined ? this.markeringer.naermesteTeine(L.latLng(pos.lat, pos.lon)) : teine;
    const f = await this.markeringer.nyFangst({ ...pos, teine_id: fra?.id ?? null });
    this._sjekkLagring();
    this.visMarkering(f.id);
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

    const el = fraMal(`
      <div class="ark-topp">
        <div class="symbol teine ${iSjoen ? '' : 'opptatt'}"><span data-tekst="nummer"></span></div>
        <div class="ark-tittel"><h3 data-tekst="tittel"></h3><p data-tekst="undertekst"></p></div>
        <span class="status ${iSjoen ? 'i-sjoen' : ''}">${iSjoen ? 'I sjøen' : 'Tatt opp'}</span>
      </div>
      <button type="button" class="fredningsvarsel" data-handling="visFredning" hidden>
        <b>Ligger i et fredningsområde</b><span data-tekst="fredning"></span>
      </button>
      <dl class="fakta">
        <div><dt>Avstand</dt><dd data-tekst="avstand"></dd></div>
        <div><dt>Dybde</dt><dd data-tekst="dybde"></dd></div>
        <div><dt>Fangst</dt><dd data-tekst="fangst"></dd></div>
      </dl>
      <div class="felter">
        <label class="felt smal">Nummer<input type="number" inputmode="numeric" min="1" data-felt="nummer"></label>
        <label class="felt">Notat<textarea rows="2" data-felt="notat" placeholder="F.eks. agn, bunn, merke på blåsen"></textarea></label>
      </div>
      <div class="knapper">
        ${iSjoen
          ? '<button type="button" class="stor teine-farge" data-handling="taOpp">Tatt opp</button>'
          : '<button type="button" class="stor teine-farge" data-handling="settUtIgjen">Sett ut igjen her</button>'}
        ${iSjoen ? '<button type="button" class="sekundar" data-handling="fangst">🦞 Registrer fangst</button>' : ''}
        <button type="button" class="sekundar" data-handling="flytt">Flytt</button>
        <button type="button" class="fare" data-handling="slett">Slett</button>
        <button type="button" class="ferdig" data-handling="lukk">Ferdig</button>
      </div>`);

    const sett = (navn, tekst) => { el.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('nummer', m.nummer ?? '?');
    sett('tittel', `Teine ${m.nummer ?? '?'}`);
    sett('undertekst', iSjoen
      ? `Satt ${formaterTid(m.tid)} · ${formaterSiden(m.tid)}`
      : `Tatt opp ${formaterTid(m.tatt_opp)}`);
    sett('avstand', this._avstandTekst(m));
    sett('dybde', m.dybde != null ? formaterDybde(m.dybde) : '–');
    sett('fangst', fangst.length ? `${beholdt} beholdt, ${sattUt} satt ut` : 'Ingen ennå');
    el.querySelector('[data-felt="nummer"]').value = m.nummer ?? '';
    el.querySelector('[data-felt="notat"]').value = m.notat;
    const omrade = this._fredningFor(m);
    if (omrade) {
      el.querySelector('.fredningsvarsel').hidden = false;
      sett('fredning', `${omrade.navn}. Teiner er forbudt her. Trykk for regler.`);
    }
    return el;
  }

  _fangstInnhold(m) {
    const el = fraMal(`
      <div class="ark-topp">
        <div class="symbol hummer"><span class="emoji">🦞</span></div>
        <div class="ark-tittel"><h3>Hummerfangst</h3><p data-tekst="undertekst"></p></div>
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
      <div class="felter">
        <label class="felt">Fra teine<select data-felt="teine_id"></select></label>
        <label class="felt">Notat<textarea rows="2" data-felt="notat" placeholder="F.eks. lengde, rognhummer"></textarea></label>
      </div>
      <div class="knapper">
        <button type="button" class="sekundar" data-handling="flytt">Flytt</button>
        <button type="button" class="fare" data-handling="slett">Slett</button>
        <button type="button" class="ferdig" data-handling="lukk">Ferdig</button>
      </div>`);

    el.querySelector('[data-tekst="undertekst"]').textContent = formaterTid(m.tid);
    el.querySelector('[data-tekst="beholdt"]').textContent = m.beholdt;
    el.querySelector('[data-tekst="satt_ut"]').textContent = m.satt_ut;
    el.querySelector('[data-felt="notat"]').value = m.notat;

    // Teinene i sjøen, pluss den fangsten allerede er knyttet til (selv om den er tatt opp)
    const valg = el.querySelector('[data-felt="teine_id"]');
    valg.append(new Option('Ingen', ''));
    const teiner = this.markeringer.teinerISjoen();
    const knyttet = this.markeringer.hent(m.teine_id);
    if (knyttet && !teiner.includes(knyttet)) teiner.unshift(knyttet);
    for (const t of teiner) valg.append(new Option(`Teine ${t.nummer}`, t.id));
    valg.value = m.teine_id ?? '';
    return el;
  }

  async _handling(navn, felt) {
    const id = this.aapenId;
    const m = this.markeringer.hent(id);
    if (!m) return;
    switch (navn) {
      case 'lukk':
        this.arkMarkering.close();
        break;
      case 'visFredning':
        this.visFredning(this._fredningFor(m));
        break;
      case 'taOpp':
        this.arkMarkering.close();
        await this.markeringer.taOpp(id);
        visMelding(`Teine ${m.nummer} tatt opp`, {
          knapp: 'Angre',
          handling: () => this.markeringer.oppdater(id, { status: 'i_sjoen', tatt_opp: null }),
        });
        break;
      case 'settUtIgjen': {
        // Ny utsetting med samme nummer. Den gamle beholdes som historikk.
        const pos = this._gpsPosisjon();
        if (!pos) return;
        this.arkMarkering.close();
        const ny = await this.markeringer.nyTeine({ ...pos, nummer: m.nummer });
        visMelding(`Teine ${ny.nummer} satt ut igjen`, {
          knapp: 'Angre',
          handling: () => this.markeringer.slett(ny.id, { husk: false }),
        });
        this.etterFlytt(ny.id);
        break;
      }
      case 'fangst':
        await this.registrerFangst({ lat: m.lat, lon: m.lon, noyaktighet: m.noyaktighet, kilde: m.kilde }, m);
        break;
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
        await this.markeringer.oppdater(id, { [felt]: verdi });
        this.arkMarkering.querySelector(`[data-tekst="${felt}"]`).textContent = verdi;
        break;
      }
      default:
        break;
    }
  }

  _feltEndret(el) {
    const m = this.markeringer.hent(this.aapenId);
    const felt = el.dataset?.felt;
    if (!m || !felt) return;
    if (felt === 'nummer') {
      const nummer = parseInt(el.value, 10);
      if (!(nummer >= 1) || nummer === m.nummer) return;
      if (this.markeringer.teinerISjoen().some((t) => t.nummer === nummer && t.id !== m.id)) {
        visMelding(`Obs: teine ${nummer} finnes allerede i sjøen`);
      }
      this.markeringer.oppdater(m.id, { nummer });
      this.arkMarkering.querySelector('[data-tekst="nummer"]').textContent = nummer;
      this.arkMarkering.querySelector('[data-tekst="tittel"]').textContent = `Teine ${nummer}`;
    } else if (felt === 'notat' && el.value !== m.notat) {
      this.markeringer.oppdater(m.id, { notat: el.value });
    } else if (felt === 'teine_id' && (el.value || null) !== m.teine_id) {
      this.markeringer.oppdater(m.id, { teine_id: el.value || null });
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
    const her = this.gps.posisjon?.latlng;
    this.arkTeiner.querySelector('[data-tekst="antall"]').textContent = teiner.length;
    this.arkTeiner.querySelector('[data-handling="taOppAlle"]').hidden = teiner.length < 2;

    const rader = teiner.map((t) => {
      const li = fraMal(`
        <li>
          <button type="button" class="rad" data-vis="${t.id}">
            <span class="symbol teine"><span data-tekst="nummer"></span></span>
            <span class="radtekst"><b data-tekst="tittel"></b><small data-tekst="info"></small></span>
            <span class="avstand"><span class="pil">${PIL}</span><span data-tekst="avstand"></span></span>
          </button>
          <button type="button" class="ta-opp" data-ta-opp="${t.id}">Ta opp</button>
        </li>`);
      li.querySelector('[data-tekst="nummer"]').textContent = t.nummer;
      li.querySelector('[data-tekst="tittel"]').textContent = `Teine ${t.nummer}`;
      const dybde = t.dybde != null ? ` · ${formaterDybde(t.dybde)}` : '';
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
    });
    const liste = this.arkTeiner.querySelector('[data-liste="teiner"]');
    if (rader.length) liste.replaceChildren(...rader);
    else liste.replaceChildren(fraMal('<li class="tom">Ingen teiner i sjøen. Trykk «Sett teine» når du setter en.</li>'));

    this._tegnSlettede();

    // Fangst i år
    const aar = new Date().getFullYear();
    const iAar = this.markeringer.alle().filter((m) => m.kategori === 'hummer' && new Date(m.tid).getFullYear() === aar);
    const beholdt = iAar.reduce((s, f) => s + f.beholdt, 0);
    const sattUt = iAar.reduce((s, f) => s + f.satt_ut, 0);
    this.arkTeiner.querySelector('[data-tekst="sesong"]').textContent =
      `Fangst i ${aar}: ${beholdt} beholdt · ${sattUt} satt ut`;
  }

  // Slettede markeringer, sist slettet først, så en sletting kan angres også senere.
  _tegnSlettede() {
    const slettede = this.markeringer.slettede();
    this.arkTeiner.querySelector('.slettede').hidden = slettede.length === 0;
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
        && this.markeringer.teinerISjoen().some((t) => t.nummer === m.nummer && t.id !== m.id);
      visMelding(`${navnPa(m)} gjenopprettet${nummerBrukt ? `. Obs: teine ${m.nummer} finnes allerede i sjøen` : ''}`,
        { ms: nummerBrukt ? 5000 : undefined });
    } else if (taOpp) {
      const t = this.markeringer.hent(taOpp);
      await this.markeringer.taOpp(taOpp);
      visMelding(`Teine ${t.nummer} tatt opp`, {
        knapp: 'Angre',
        handling: () => this.markeringer.oppdater(taOpp, { status: 'i_sjoen', tatt_opp: null }),
      });
    } else if (handling === 'taOppAlle') {
      const teiner = this.markeringer.teinerISjoen();
      if (!window.confirm(`Ta opp alle ${teiner.length} teinene?`)) return;
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
