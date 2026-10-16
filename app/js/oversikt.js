/*
 * Fangstoversikten: et ark med nøkkeltall og en enkel tidslinje for teinene, for en
 * valgt periode (7 dager, 30 dager eller sesongen). Åpnes fra teinelisten.
 *
 * Bare hummersesongen vises: 1. oktober til og med 30. november. Perioden er alltid
 * innenfor sesongen som pågår, eller den siste som var (før 1. oktober: fjorårets).
 *
 * Samme regnemåte som scripts/analyser_fangst.py, men enklere (testet mot samme fasit i
 * tests/, se tests/regnemaate.test.mjs og tests/test_regnemaate.py):
 *   - En teinesetting går fra teinen ble satt til den ble tatt opp, eller til nå.
 *   - Fangst hører til settingen via teine_id. Fangst uten teine får egen rad nederst.
 *   - Hummer per teinedøgn: hummer fra teinene delt på døgnene teinene har stått i
 *     sjøen innenfor perioden.
 *   - Mistede teiner er ikke med i fangstraten og andelen med hummer: fangsten er ukjent.
 *
 * Tidslinjen er SVG, med én rad per teinenummer: en stolpe per setting (blå = ga
 * hummer, grå = ingen), lysere med pil hvis den står i sjøen nå, en rød prikk med
 * antall for hver fangst, en hul ring for 0 hummer (tom teine) og et rødt «?» der en
 * teine ble meldt mistet.
 *
 * Oversikten viser dine teiner og fangsten fra dem (personer.js, Markeringer.eierAv). I et
 * lag kan du velge «Laget»: alt i laget, en tabell med tallene per person, og tidslinjen
 * gruppert per person med nummeret i personens farge.
 */

import { personer } from './personer.js';

const DAG = 24 * 60 * 60 * 1000;
const RAD = 30;      // høyde per rad
const STOLPE = 14;   // høyde på stolpene
const VENSTRE = 46;  // plass til teinenummeret
const HOYRE = 14;    // plass til pilen og prikkene ved «nå»
const TOPP = 22;     // plass til «nå» over radene
const BUNN = 36;     // plass til datoene under

const ukedag = new Intl.DateTimeFormat('nb-NO', { weekday: 'short' });
const kortDato = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'numeric' });
const langDato = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const komma = (tall, desimaler) =>
  tall.toLocaleString('nb-NO', { minimumFractionDigits: desimaler, maximumFractionDigits: desimaler });

// Lokal midnatt, og et antall dager fram eller tilbake (riktig også ved sommertid).
function midnatt(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dagerFra(ms, dager) {
  const d = new Date(ms);
  d.setDate(d.getDate() + dager);
  return d.getTime();
}

/**
 * Teinesettinger med fangst, og fangst som ikke hører til noen teine. eierAv gir eieren
 * (bruker-id eller null) av en teine eller fangst. «gruppe» er personens nøkkel i
 * oversikten: din bruker-id for alt som er ditt (se personer.erMeg), ellers eieren.
 */
export function lagSettinger(alle, naa, eierAv) {
  const gruppe = (m) => {
    const eier = eierAv(m);
    return personer.erMeg(eier) ? personer.meg : eier ?? null;
  };
  const teiner = alle.filter((m) => m.kategori === 'teine');
  const ider = new Set(teiner.map((t) => t.id));
  const fangst = alle.filter((m) => m.kategori === 'hummer')
    .map((f) => ({ ...f, ms: Date.parse(f.tid), hummer: f.beholdt + f.satt_ut, gruppe: gruppe(f) }));
  const settinger = teiner.map((t) => {
    const fra = Date.parse(t.tid);
    const til = t.status === 'i_sjoen' ? naa : Date.parse(t.tatt_opp ?? t.tid);
    const fangstHer = fangst.filter((f) => f.teine_id === t.id);
    return {
      nummer: t.nummer, id: t.id, lat: t.lat, lon: t.lon, fra, til: Math.max(til, fra), iSjoen: t.status === 'i_sjoen',
      mistet: t.mistet === true, fangst: fangstHer, hummer: fangstHer.reduce((s, f) => s + f.hummer, 0),
      gruppe: gruppe(t),
    };
  });
  return { settinger, fangst, utenTeine: fangst.filter((f) => !ider.has(f.teine_id)) };
}

/**
 * Nøkkeltallene for teinesettinger og fangst i perioden (samme regnemåte som analyser_fangst.py).
 * Bare tiden innenfor perioden teller, og bare fangst fra teinene teller i fangstraten.
 * Mistede teiner er ikke med: vi vet ikke hva de fanget.
 */
export function regnUt(periode, naa, iPerioden, fangstIPerioden) {
  const sum = (liste, felt) => liste.reduce((s, f) => s + f[felt], 0);
  const telles = iPerioden.filter((t) => !t.mistet);
  const teinedogn = telles.reduce((s, t) =>
    s + Math.max(0, Math.min(t.til, naa, periode.til) - Math.max(t.fra, periode.fra)), 0) / DAG;
  const ider = new Set(telles.map((t) => t.id));
  const fraTeiner = sum(fangstIPerioden.filter((f) => ider.has(f.teine_id)), 'hummer');
  const med = telles.filter((t) => t.hummer > 0).length;
  return {
    hummer: sum(fangstIPerioden, 'hummer'),
    beholdt: sum(fangstIPerioden, 'beholdt'),
    sattUt: sum(fangstIPerioden, 'satt_ut'),
    teinedogn,
    fraTeiner,
    rate: teinedogn > 0 ? komma(fraTeiner / teinedogn, 2) : '–',
    treff: telles.length ? `${Math.round((100 * med) / telles.length)} %` : '–',
    med,
    settinger: telles.length,
    mistet: iPerioden.length - telles.length,
  };
}

// Hummersesongen: 1. oktober til og med 30. november (månedene teller fra januar = 0)
const SESONG_START_MAANED = 9;  // 1. oktober
const SESONG_SLUTT_MAANED = 11; // 1. desember, første dag etter sesongen

/**
 * Hummersesongen som pågår, eller den siste som var: { aar, fra, til } i millisekunder,
 * der til er midnatt 1. desember (ikke med i sesongen).
 */
export function hummersesong(naa = Date.now()) {
  const d = new Date(naa);
  const aar = d.getMonth() >= SESONG_START_MAANED ? d.getFullYear() : d.getFullYear() - 1;
  return {
    aar,
    fra: new Date(aar, SESONG_START_MAANED, 1).getTime(),
    til: new Date(aar, SESONG_SLUTT_MAANED, 1).getTime(),
  };
}

/**
 * Perioden som vises: hele dager innenfor sesongen, til og med i dag (eller 30. november
 * når sesongen er over). 7 og 30 dager er de siste dagene, men aldri før 1. oktober.
 */
function lagPeriode(valg, naa) {
  const sesong = hummersesong(naa);
  const til = Math.min(dagerFra(midnatt(naa), 1), sesong.til);
  const fra = valg === 'sesong' ? sesong.fra : Math.max(dagerFra(til, -Number(valg)), sesong.fra);
  return { fra, til, aar: sesong.aar, over: naa >= sesong.til, sesong: valg === 'sesong' };
}

export class Fangstoversikt {
  constructor(markeringer) {
    this.markeringer = markeringer;
    this.ark = document.getElementById('ark-oversikt');
    this.tidslinje = this.ark.querySelector('[data-tidslinje]');

    this.ark.addEventListener('click', (e) => {
      if (e.target === this.ark || e.target.closest('[data-handling="lukk"]')) this.ark.close();
    });
    this.ark.addEventListener('change', () => this._tegn());
    markeringer.naarEndret(() => {
      if (this.ark.open) this._tegn();
    });
    personer.naarEndret(() => {
      if (this.ark.open) this._tegn();
    });
    window.addEventListener('resize', () => {
      if (this.ark.open) this._tegn();
    });
  }

  vis() {
    this.ark.showModal();
    this._tegn(); // etter showModal, så bredden på tidslinjen er kjent
  }

  _tegn() {
    const naa = Date.now();
    const valg = this.ark.querySelector('input[name="periode"]:checked')?.value ?? '7';
    // Uten lag er alt ditt, og valget Mine/Laget vises ikke
    this.ark.querySelector('[data-hvem]').hidden = !personer.iLag;
    const laget = personer.iLag && this.ark.querySelector('input[name="hvem"]:checked')?.value === 'laget';
    const medtas = (x) => laget || x.gruppe === personer.meg;

    const { settinger, fangst, utenTeine } = lagSettinger(this.markeringer.alle(), naa, (m) => this.markeringer.eierAv(m));
    const periode = lagPeriode(valg, naa);
    const iPerioden = settinger.filter((s) => medtas(s) && s.til > periode.fra && s.fra < periode.til);
    const fangstIPerioden = fangst.filter((f) => medtas(f) && f.ms >= periode.fra && f.ms < periode.til);

    this._tegnTall(periode, regnUt(periode, naa, iPerioden, fangstIPerioden));
    this._tegnPerPerson(laget ? { periode, naa, iPerioden, fangstIPerioden } : null);
    this.tidslinje.replaceChildren();
    if (!iPerioden.length && !fangstIPerioden.length) {
      const tom = document.createElement('p');
      tom.className = 'hjelp';
      tom.textContent = 'Ingen teiner eller fangst i perioden.';
      this.tidslinje.append(tom);
      return;
    }
    const utenIPerioden = utenTeine.filter((f) => medtas(f) && f.ms >= periode.fra && f.ms < periode.til);
    this.tidslinje.innerHTML = this._svg(periode, naa, iPerioden, utenIPerioden, laget);
  }

  _tegnTall(periode, tall) {
    const sett = (navn, tekst) => { this.ark.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    // Når sesongen er over, vises den siste sesongen helt ut (til 30. november)
    sett('periode', `${langDato.format(periode.fra)} – ${periode.over
      ? `${langDato.format(dagerFra(periode.til, -1))} ${periode.aar}` : 'i dag'}`);
    sett('hummer', tall.hummer);
    sett('beholdt', `${tall.beholdt} beholdt, ${tall.sattUt} satt ut`);
    sett('rate', tall.rate);
    sett('treff', tall.treff);
    sett('settinger', `${tall.med} av ${tall.settinger} settinger${tall.mistet ? ` (${tall.mistet} mistet)` : ''}`);
  }

  // «Laget»: én rad per person med de samme tallene. Navnene settes som tekst (textContent).
  _tegnPerPerson(data) {
    const tabell = this.ark.querySelector('[data-per-person]');
    tabell.hidden = !data;
    if (!data) return;
    const { periode, naa, iPerioden, fangstIPerioden } = data;
    const grupper = personer.rekkefolge([...iPerioden, ...fangstIPerioden].map((x) => x.gruppe));
    const rader = [];
    for (const uid of grupper) {
      const settinger = iPerioden.filter((t) => t.gruppe === uid);
      const fangst = fangstIPerioden.filter((f) => f.gruppe === uid);
      if (!settinger.length && !fangst.length) continue;
      const tall = regnUt(periode, naa, settinger, fangst);
      const tr = document.createElement('tr');
      const merke = document.createElement('span');
      merke.className = 'eier-merke';
      if (uid === personer.meg) {
        merke.classList.add('min');
        merke.textContent = 'Meg';
      } else {
        merke.textContent = personer.kortnavn(uid);
        merke.style.background = personer.farge(uid);
      }
      const celler = [merke, `${tall.hummer}`, tall.rate, tall.treff];
      for (const innhold of celler) {
        const td = document.createElement('td');
        td.append(innhold);
        tr.append(td);
      }
      const detaljer = document.createElement('small');
      detaljer.textContent = ` ${tall.beholdt}+${tall.sattUt}`;
      tr.children[1].append(detaljer);
      rader.push(tr);
    }
    tabell.querySelector('tbody').replaceChildren(...rader);
  }

  // Tidslinjen som SVG. Alt som settes inn er tall vi har regnet ut selv, og fargene fra
  // personer.js (konstanter). Med «Laget» grupperes radene per person.
  _svg(periode, naa, iPerioden, utenTeine, laget = false) {
    const bredde = this.tidslinje.clientWidth || 340;

    // Én rad per teinenummer (sortert), per person i laget, og en rad nederst for fangst uten teine
    const grupper = laget ? personer.rekkefolge(iPerioden.map((t) => t.gruppe)) : [personer.meg];
    const radnokkel = (t) => `${laget ? grupper.indexOf(t.gruppe) : 0}|${t.nummer ?? 0}`;
    const nokler = [...new Map(iPerioden.map((t) => [radnokkel(t), t])).values()]
      .sort((a, b) => (laget ? grupper.indexOf(a.gruppe) - grupper.indexOf(b.gruppe) : 0)
        || (a.nummer || 1e9) - (b.nummer || 1e9));
    const radFor = new Map(nokler.map((t, i) => [radnokkel(t), i]));
    const rader = nokler.length + (utenTeine.length ? 1 : 0);
    const hoyde = TOPP + rader * RAD + BUNN;
    const yFor = (rad) => TOPP + rad * RAD + RAD / 2;

    const x0 = VENSTRE;
    const x1 = bredde - HOYRE;
    const x = (ms) => x0 + ((ms - periode.fra) / (periode.til - periode.fra)) * (x1 - x0);
    const bunn = TOPP + rader * RAD;
    const deler = [];

    // Datoer og rutenett. Er det plass, får hver dag en kolonne med ukedag og dato.
    const dager = Math.round((periode.til - periode.fra) / DAG);
    const pxPerDag = (x1 - x0) / dager;
    if (pxPerDag >= 30) {
      for (let d = periode.fra; d < periode.til; d = dagerFra(d, 1)) {
        const neste = dagerFra(d, 1);
        const midt = (x(d) + x(neste)) / 2;
        const iDag = d === midnatt(naa);
        if (iDag) deler.push(`<rect class="tl-idag" x="${x(d)}" y="${TOPP - 4}" width="${x(neste) - x(d)}" height="${bunn - TOPP + 4}" rx="6"/>`);
        deler.push(`<line class="tl-rutenett" x1="${x(d)}" x2="${x(d)}" y1="${TOPP - 4}" y2="${bunn}"/>`);
        deler.push(`<text class="tl-dato${iDag ? ' idag' : ''}" x="${midt}" y="${bunn + 15}">${ukedag.format(d).replace('.', '')}</text>`);
        deler.push(`<text class="tl-dato${iDag ? ' idag' : ''}" x="${midt}" y="${bunn + 30}">${new Date(d).getDate()}.</text>`);
      }
    } else {
      // Smalere dager: en strek med dato hver 2., 7., 14. eller 28. dag (minst 48 px mellom).
      // Sesongen regnes fra 1. oktober og fremover, så datoene står fast. 7 og 30 dager
      // regnes bakover fra den siste dagen (i dag, eller 30. november), så den har en dato.
      const steg = [2, 7, 14, 28].find((n) => n * pxPerDag >= 48) ?? 28;
      const start = periode.sesong ? periode.fra : dagerFra(periode.til, -1);
      const retning = periode.sesong ? 1 : -1;
      for (let i = 0, d = start; d >= periode.fra && d < periode.til; d = dagerFra(start, retning * steg * ++i)) {
        const tx = Math.min(Math.max(x(d), x0 + 16), x1 - 16); // datoen skal ikke gå utenfor kanten
        deler.push(`<line class="tl-rutenett" x1="${x(d)}" x2="${x(d)}" y1="${TOPP - 4}" y2="${bunn}"/>`);
        deler.push(`<text class="tl-dato" x="${tx}" y="${bunn + 18}">${kortDato.format(d)}</text>`);
      }
    }

    // Teinenummer til venstre, i personens farge for de andres teiner. Strek mellom personene.
    for (const [rad, t] of nokler.entries()) {
      const y = yFor(rad);
      const annen = laget && t.gruppe !== personer.meg;
      if (laget && rad > 0 && t.gruppe !== nokler[rad - 1].gruppe) {
        deler.push(`<line class="tl-gruppe" x1="0" x2="${bredde}" y1="${y - RAD / 2}" y2="${y - RAD / 2}"/>`);
      }
      deler.push(`<rect class="tl-nummer" x="4" y="${y - 11}" width="34" height="22" rx="11"${annen
        ? ` style="fill: ${personer.farge(t.gruppe)}; stroke: #fff"` : ''}/>`);
      deler.push(`<text class="tl-nummertekst${annen ? ' annen' : ''}" x="21" y="${y + 4.5}">${t.nummer || '?'}</text>`);
    }
    if (utenTeine.length) {
      deler.push(`<text class="tl-uten-teine" x="21" y="${yFor(nokler.length) + 4}">Uten</text>`);
    }

    // «Nå», bare mens sesongen pågår
    if (!periode.over) {
      deler.push(`<line class="tl-naa" x1="${x(naa)}" x2="${x(naa)}" y1="${TOPP - 4}" y2="${bunn}"/>`);
      deler.push(`<text class="tl-naatekst" x="${Math.min(x(naa), x1 - 6)}" y="${TOPP - 8}">nå</text>`);
    }

    // Stolper: én per teinesetting
    const prikker = [];
    const mistede = [];
    for (const t of iPerioden) {
      const y = yFor(radFor.get(radnokkel(t)));
      const fra = x(Math.max(t.fra, periode.fra));
      const til = x(Math.min(t.til, periode.til));
      const klasse = `${t.hummer > 0 ? 'tl-med' : 'tl-uten'}${t.iSjoen ? ' tl-isjoen' : ''}`;
      deler.push(`<rect class="${klasse}" x="${fra}" y="${y - STOLPE / 2}" width="${Math.max(4, til - fra)}" height="${STOLPE}" rx="4"/>`);
      if (t.iSjoen) deler.push(`<path class="${klasse} tl-pil" d="M${til + 1} ${y - 7}l7 7-7 7z"/>`);
      if (t.mistet && t.til < periode.til) mistede.push({ x: til, y });
      for (const f of t.fangst) if (f.ms >= periode.fra && f.ms < periode.til) prikker.push({ f, y });
    }
    // Mistet teine: rødt «?» der den ble meldt mistet
    for (const { x: xm, y } of mistede) {
      deler.push(`<circle class="tl-mistet" cx="${xm}" cy="${y}" r="8"/>`);
      deler.push(`<text class="tl-antall" x="${xm}" y="${y + 4}">?</text>`);
    }
    for (const f of utenTeine) prikker.push({ f, y: yFor(nokler.length) });

    // Fangst oppå stolpene: rød prikk med antall, hul ring for 0 hummer. Mindre når
    // dagene er smale (30 dager, sesong), så prikkene ikke dekker hverandre.
    const smal = pxPerDag < 30;
    for (const { f, y } of prikker) {
      const xf = Math.min(x(f.ms), x1);
      if (!f.hummer) {
        deler.push(`<circle class="tl-tom" cx="${xf}" cy="${y}" r="${smal ? 4.5 : 5.5}"/>`);
      } else {
        const r = (smal ? 7.5 : 10) + (f.hummer > 9 ? 1.5 : 0);
        deler.push(`<circle class="tl-fangst" cx="${xf}" cy="${y}" r="${r}"/>`);
        deler.push(`<text class="tl-antall${smal ? ' smal' : ''}" x="${xf}" y="${y + (smal ? 3.5 : 4)}">${f.hummer}</text>`);
      }
    }

    return `<svg viewBox="0 0 ${bredde} ${hoyde}" width="${bredde}" height="${hoyde}" role="img"
      aria-label="Tidslinje for teinene i perioden">${deler.join('')}</svg>`;
  }
}
