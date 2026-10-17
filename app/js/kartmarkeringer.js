/*
 * Viser markeringene på kartet med egne symboler (utseendet ligger i app.css):
 *   teine i sjøen   svart bøyleteine sett fra siden, med nummer
 *   teine tatt opp  grå, stiplet teine (bare når «Teiner tatt opp» er slått på)
 *   mistet teine    grå, stiplet teine med rødt «?», med teinene i sjøen, så du kan lete etter den
 *   hummer          hvit sirkel med hummer og rød kant, antall som merke
 *   ingen hummer    hvit sirkel med grått kryss: fangst med 0 hummer (teinen var tom)
 *   rødt «!»        teinen ligger i et fredningsområde
 *   farget nummer   teinen er en annens i laget (fargen er personens, se personer.js)
 *
 * Zoomet ut (under FANGST_FULL_ZOOM) er fangsten små prikker, mens teinene er like store:
 *   rød prikk        ga hummer (større jo flere, opptil 4)
 *   hvit, rød kant   bare satt ut
 *   liten grå ring   ingen hummer
 * Mistede teiner har da ikke rødt «?», siden det lignet en fangstprikk.
 *
 * Symbolene er vanlige HTML-elementer (L.divIcon). Det går fint for noen hundre
 * markeringer. Derfor vises fangst og opptatte teiner bare fra hummersesongen som pågår
 * (eller den siste, fra 1. oktober): over flere år ville det blitt tusenvis av symboler.
 * Teiner i sjøen og mistede teiner vises fra alle sesonger. Kartet oppdateres automatisk når
 * markeringene endres.
 *
 * Bryterne i kartlagarket gjelder dine teiner og fangsten fra dem (Markeringer.erMin). I et
 * lag har de andres egne brytere («Laget»). Uten lag gjelder dine for alt.
 */

import { hummersesong } from './oversikt.js';
import { personer } from './personer.js';

// Lenger ut enn dette er fangsten prikker. Fangst fra en teine ligger der teinen stod, så
// over en sesong blir det mange symboler, og fulle symboler ville skjult teinene.
const FANGST_FULL_ZOOM = 16;

export class Kartmarkeringer {
  /**
   * @param {L.Map} kart
   * @param {import('./markeringer.js').Markeringer} markeringer
   * @param {{naarTrykket: (id: string) => void, naarFlyttet: (id: string, latlng: L.LatLng) => void}} hendelser
   */
  constructor(kart, markeringer, hendelser) {
    this.kart = kart;
    this.markeringer = markeringer;
    this.hendelser = hendelser;
    this.lag = L.layerGroup().addTo(kart);
    this._markorer = new Map(); // id -> { markor, noekkel }
    // Hva som vises av dine og av de andres i laget (settValg)
    this.valg = {
      mine: { teiner: true, fangst: true, opptatte: false },
      laget: { teiner: true, fangst: true, opptatte: false },
    };
    this.flytter = null; // id til markeringen som flyttes nå
    this.iFredning = () => false; // settes når fredningsområdene er lastet
    this.liten = kart.getZoom() < FANGST_FULL_ZOOM; // zoomet ut: fangsten vises som prikker
    // Tegn på nytt bare når zoomen går forbi FANGST_FULL_ZOOM
    kart.on('zoomend', () => {
      if ((kart.getZoom() < FANGST_FULL_ZOOM) !== this.liten) this.tegn();
    });
    markeringer.naarEndret(() => this.tegn());
    personer.naarEndret(() => this.tegn()); // laget eller initialene er endret
  }

  /** valg: { mine, laget }, hver med { teiner, fangst, opptatte } (true = vis). */
  settValg(valg) {
    this.valg = valg;
    this.tegn();
  }

  _synlig(m, sesongStart) {
    if (m.id === this.flytter) return true;
    const valg = !personer.iLag || this.markeringer.erMin(m) ? this.valg.mine : this.valg.laget;
    if (m.kategori === 'teine' && (m.status === 'i_sjoen' || m.mistet)) return valg.teiner;
    // Fangst og opptatte teiner: bare fra sesongen (tidligere år finnes i listene og analysen)
    const fraSesongen = Date.parse(m.kategori === 'hummer' ? m.tid : m.tatt_opp ?? m.tid) >= sesongStart;
    return fraSesongen && (m.kategori === 'hummer' ? valg.fangst : valg.opptatte);
  }

  // Lager eller oppdaterer symbolene, og fjerner de som ikke skal vises lenger.
  tegn() {
    const sesongStart = hummersesong().fra;
    this.liten = this.kart.getZoom() < FANGST_FULL_ZOOM;
    const synlige = new Set();
    for (const m of this.markeringer.alle()) {
      if (!this._synlig(m, sesongStart)) continue;
      synlige.add(m.id);
      const annen = m.kategori === 'teine' && !this.markeringer.erMin(m) ? personer.farge(m.registrert_av) : null;
      // Markeringen som flyttes, er alltid full størrelse
      const liten = this.liten && m.id !== this.flytter;
      const { html, klasse, storrelse, z } = symbol(m, this.iFredning(m), annen, liten);
      const noekkel = html + klasse;
      const finnes = this._markorer.get(m.id);
      if (finnes) {
        finnes.markor.setLatLng([m.lat, m.lon]);
        if (finnes.noekkel !== noekkel) {
          finnes.markor.setIcon(ikon(html, klasse, storrelse));
          finnes.markor.setZIndexOffset(z);
          finnes.noekkel = noekkel;
        }
        continue;
      }
      const markor = L.marker([m.lat, m.lon], {
        icon: ikon(html, klasse, storrelse),
        zIndexOffset: z,
        keyboard: false,
        riseOnHover: false,
      });
      markor.on('click', () => {
        if (this.flytter !== m.id) this.hendelser.naarTrykket(m.id);
      });
      markor.on('dragend', () => this.hendelser.naarFlyttet(m.id, markor.getLatLng()));
      markor.addTo(this.lag);
      this._markorer.set(m.id, { markor, noekkel });
    }
    for (const [id, { markor }] of this._markorer) {
      if (!synlige.has(id)) {
        markor.remove();
        this._markorer.delete(id);
      }
    }
  }

  /** Gjør en markering flyttbar med fingeren. */
  startFlytt(id) {
    this.stoppFlytt();
    this.flytter = id;
    this.tegn();
    const { markor } = this._markorer.get(id);
    markor.dragging.enable();
    markor.getElement().classList.add('flyttes');
  }

  stoppFlytt() {
    if (!this.flytter) return;
    const finnes = this._markorer.get(this.flytter);
    if (finnes) {
      finnes.markor.dragging.disable();
      finnes.markor.getElement()?.classList.remove('flyttes');
    }
    this.flytter = null;
    this.tegn();
  }
}

function ikon(html, klasse, [bredde, hoyde]) {
  return L.divIcon({ html, className: `symbol ${klasse}`, iconSize: [bredde, hoyde] });
}

// annen: fargen til eieren hvis teinen er en annens i laget (en konstant fra personer.js), ellers null
// liten: zoomet ut, fangst som prikk og mistet teine uten «?». Teinene er like store uansett.
function symbol(m, iFredning, annen = null, liten = false) {
  if (m.kategori === 'teine') {
    const iSjoen = m.status === 'i_sjoen';
    let varsel = iSjoen && iFredning ? '<b class="varsel" title="I fredningsområde">!</b>' : '';
    if (m.mistet) varsel = liten ? '' : '<b class="varsel" title="Mistet">?</b>';
    const nummer = annen ? `<span class="annen" style="--eier: ${annen}">` : '<span>';
    return {
      html: `${nummer}${m.nummer ?? '?'}</span>${varsel}`,
      klasse: iSjoen ? 'teine' : 'teine opptatt',
      storrelse: [58, 40], // bredere enn høy, som tegningen av teinen
      z: iSjoen ? 500 : m.mistet ? 100 : -200,
    };
  }
  const antall = m.beholdt + m.satt_ut;
  if (liten) {
    // Prikken (--d) står midt i en større, usynlig flate, så den er lett å treffe
    const d = antall === 0 ? 10 : 12 + 2 * Math.min(antall, 4);
    const type = antall === 0 ? ' sjekk' : m.beholdt > 0 ? '' : ' bare-satt-ut';
    return { html: `<i style="--d: ${d}px"></i>`, klasse: `hummer liten${type}`, storrelse: [24, 24], z: 0 };
  }
  if (antall === 0) {
    // Ingen hummer (fangst med 0 beholdt og 0 satt ut): grått kryss
    return { html: '<span class="emoji">✕</span>', klasse: 'hummer sjekk', storrelse: [36, 36], z: 0 };
  }
  return {
    html: `<span class="emoji">🦞</span>${antall > 1 ? `<b class="antall">${antall}</b>` : ''}`,
    klasse: m.beholdt > 0 ? 'hummer' : 'hummer bare-satt-ut',
    storrelse: [36, 36],
    z: 0,
  };
}
