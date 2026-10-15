/*
 * Fangstoversikten: et ark med nøkkeltall og en enkel tidslinje for teinene, for en
 * valgt periode (7 dager, 30 dager eller sesongen). Åpnes fra teinelisten.
 *
 * Samme regnemåte som scripts/analyser_fangst.py, men enklere:
 *   - En teinesetting går fra teinen ble satt til den ble tatt opp, eller til nå.
 *   - Fangst hører til settingen via teine_id. Fangst uten teine får egen rad nederst.
 *   - Hummer per teinedøgn: hummer fra teinene delt på døgnene teinene har stått i
 *     sjøen innenfor perioden.
 *
 * Tidslinjen er SVG, med én rad per teinenummer: en stolpe per setting (blå = ga
 * hummer, grå = ingen), lysere med pil hvis den står i sjøen nå, en rød prikk med
 * antall for hver fangst og en hul ring for 0 hummer (tom teine).
 */

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

/** Teinesettinger med fangst, og fangst som ikke hører til noen teine. */
function lagSettinger(alle, naa) {
  const teiner = alle.filter((m) => m.kategori === 'teine');
  const ider = new Set(teiner.map((t) => t.id));
  const fangst = alle.filter((m) => m.kategori === 'hummer')
    .map((f) => ({ ...f, ms: Date.parse(f.tid), hummer: f.beholdt + f.satt_ut }));
  const settinger = teiner.map((t) => {
    const fra = Date.parse(t.tid);
    const til = t.status === 'i_sjoen' ? naa : Date.parse(t.tatt_opp ?? t.tid);
    const fangstHer = fangst.filter((f) => f.teine_id === t.id);
    return {
      nummer: t.nummer, id: t.id, fra, til: Math.max(til, fra), iSjoen: t.status === 'i_sjoen',
      fangst: fangstHer, hummer: fangstHer.reduce((s, f) => s + f.hummer, 0),
    };
  });
  return { settinger, fangst, utenTeine: fangst.filter((f) => !ider.has(f.teine_id)) };
}

/** Perioden som vises: fra midnatt den første dagen til midnatt etter i dag. */
function lagPeriode(valg, naa, settinger, fangst) {
  const iDag = midnatt(naa);
  const slutt = dagerFra(iDag, 1);
  if (valg !== 'sesong') return { fra: dagerFra(iDag, 1 - Number(valg)), til: slutt };
  // Sesongen: fra den første teinen eller fangsten i år, men minst en uke
  const aarStart = new Date(new Date(naa).getFullYear(), 0, 1).getTime();
  const tider = [
    ...settinger.filter((s) => s.til >= aarStart).map((s) => Math.max(s.fra, aarStart)),
    ...fangst.filter((f) => f.ms >= aarStart).map((f) => f.ms),
  ];
  const forste = tider.length ? Math.min(...tider) : naa;
  return { fra: Math.min(midnatt(forste), dagerFra(iDag, -6)), til: slutt };
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
    const { settinger, fangst, utenTeine } = lagSettinger(this.markeringer.alle(), naa);
    const periode = lagPeriode(valg, naa, settinger, fangst);
    const iPerioden = settinger.filter((s) => s.til > periode.fra && s.fra < periode.til);
    const fangstIPerioden = fangst.filter((f) => f.ms >= periode.fra && f.ms < periode.til);

    this._tegnTall(periode, naa, iPerioden, fangstIPerioden);
    this.tidslinje.replaceChildren();
    if (!iPerioden.length && !fangstIPerioden.length) {
      const tom = document.createElement('p');
      tom.className = 'hjelp';
      tom.textContent = 'Ingen teiner eller fangst i perioden.';
      this.tidslinje.append(tom);
      return;
    }
    const utenIPerioden = utenTeine.filter((f) => f.ms >= periode.fra && f.ms < periode.til);
    this.tidslinje.innerHTML = this._svg(periode, naa, iPerioden, utenIPerioden);
  }

  _tegnTall(periode, naa, iPerioden, fangstIPerioden) {
    const sett = (navn, tekst) => { this.ark.querySelector(`[data-tekst="${navn}"]`).textContent = tekst; };
    sett('periode', `${langDato.format(periode.fra)} – i dag`);

    const sum = (liste, felt) => liste.reduce((s, f) => s + f[felt], 0);
    const hummer = sum(fangstIPerioden, 'hummer');
    sett('hummer', hummer);
    sett('beholdt', `${sum(fangstIPerioden, 'beholdt')} beholdt, ${sum(fangstIPerioden, 'satt_ut')} satt ut`);

    // Bare tiden innenfor perioden teller, og bare fangst fra teinene
    const teinedogn = iPerioden.reduce((s, t) => s + Math.max(0, Math.min(t.til, naa) - Math.max(t.fra, periode.fra)), 0) / DAG;
    const ider = new Set(iPerioden.map((t) => t.id));
    const fraTeiner = sum(fangstIPerioden.filter((f) => ider.has(f.teine_id)), 'hummer');
    sett('rate', teinedogn > 0 ? komma(fraTeiner / teinedogn, 2) : '–');

    const med = iPerioden.filter((t) => t.hummer > 0).length;
    sett('treff', iPerioden.length ? `${Math.round((100 * med) / iPerioden.length)} %` : '–');
    sett('settinger', `${med} av ${iPerioden.length} settinger`);
  }

  // Tidslinjen som SVG. Alt som settes inn er tall vi har regnet ut selv.
  _svg(periode, naa, iPerioden, utenTeine) {
    const bredde = this.tidslinje.clientWidth || 340;

    // Én rad per teinenummer (sortert), og en rad nederst for fangst uten teine
    const nummer = [...new Set(iPerioden.map((t) => t.nummer ?? 0))].sort((a, b) => (a || 1e9) - (b || 1e9));
    const radFor = new Map(nummer.map((n, i) => [n, i]));
    const rader = nummer.length + (utenTeine.length ? 1 : 0);
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
      // Smalere dager: en strek med dato hver 2., 7., 14. eller 28. dag (minst 48 px mellom),
      // regnet bakover fra i dag, så i dag alltid har en dato
      const steg = [2, 7, 14, 28].find((n) => n * pxPerDag >= 48) ?? 28;
      for (let i = 0, d = midnatt(naa); d >= periode.fra; d = dagerFra(midnatt(naa), -steg * ++i)) {
        const xd = x(d);
        const tx = Math.min(Math.max(xd, x0 + 16), x1 - 16); // datoen skal ikke gå utenfor kanten
        deler.push(`<line class="tl-rutenett" x1="${xd}" x2="${xd}" y1="${TOPP - 4}" y2="${bunn}"/>`);
        deler.push(`<text class="tl-dato" x="${tx}" y="${bunn + 18}">${kortDato.format(d)}</text>`);
      }
    }

    // Teinenummer til venstre
    for (const [n, rad] of radFor) {
      const y = yFor(rad);
      deler.push(`<rect class="tl-nummer" x="4" y="${y - 11}" width="34" height="22" rx="11"/>`);
      deler.push(`<text class="tl-nummertekst" x="21" y="${y + 4.5}">${n || '?'}</text>`);
    }
    if (utenTeine.length) {
      deler.push(`<text class="tl-uten-teine" x="21" y="${yFor(nummer.length) + 4}">Uten</text>`);
    }

    // «Nå»
    deler.push(`<line class="tl-naa" x1="${x(naa)}" x2="${x(naa)}" y1="${TOPP - 4}" y2="${bunn}"/>`);
    deler.push(`<text class="tl-naatekst" x="${Math.min(x(naa), x1 - 6)}" y="${TOPP - 8}">nå</text>`);

    // Stolper: én per teinesetting
    const prikker = [];
    for (const t of iPerioden) {
      const y = yFor(radFor.get(t.nummer ?? 0));
      const fra = x(Math.max(t.fra, periode.fra));
      const til = x(Math.min(t.til, periode.til));
      const klasse = `${t.hummer > 0 ? 'tl-med' : 'tl-uten'}${t.iSjoen ? ' tl-isjoen' : ''}`;
      deler.push(`<rect class="${klasse}" x="${fra}" y="${y - STOLPE / 2}" width="${Math.max(4, til - fra)}" height="${STOLPE}" rx="4"/>`);
      if (t.iSjoen) deler.push(`<path class="${klasse} tl-pil" d="M${til + 1} ${y - 7}l7 7-7 7z"/>`);
      for (const f of t.fangst) if (f.ms >= periode.fra) prikker.push({ f, y });
    }
    for (const f of utenTeine) prikker.push({ f, y: yFor(nummer.length) });

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
