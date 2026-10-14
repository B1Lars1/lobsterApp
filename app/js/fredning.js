/*
 * Fredningsområder for hummer (Fiskeridirektoratet, lisens NLOD).
 *
 * Viser områdene rødt skravert på kartet og kan sjekke om et punkt ligger i et
 * område, så appen kan advare når en teine settes der. Dataene lages av
 * scripts/lag_fredningsomrader.py og virker uten nett.
 */

import { lagObjekter, tilVerden } from './dybdelag.js';
import { iFlate } from './dybdeoppslag.js';

export class Fredning {
  /**
   * @param {L.Map} kart
   * @param {(omrade: object) => void} naarTrykket  kalles med områdets egenskaper ved trykk
   */
  constructor(kart, naarTrykket) {
    this.kart = kart;
    this.naarTrykket = naarTrykket;
    this.omrader = []; // { navn, regel, forskrift, oversikt, ringer, ringBokser, bbox }
    this.lag = null;
    // Eget lag over dybdekartet, men under teiner og fangst
    kart.createPane('fredning').style.zIndex = 450;
  }

  async last(url = 'data/fredningsomrader.geojson') {
    const svar = await fetch(url);
    if (!svar.ok) throw new Error(`Klarte ikke å hente fredningsområdene (${svar.status})`);
    const geojson = await svar.json();
    this.omrader = lagObjekter(geojson, (p) => ({ ...p }));
    this.lag = L.geoJSON(geojson, {
      pane: 'fredning',
      bubblingMouseEvents: false, // trykk på et område skal ikke også gå til kartet
      attribution: 'Fredning: <a href="https://www.fiskeridir.no/">Fiskeridirektoratet</a> (NLOD)',
      style: () => ({ className: 'fredning', color: '#d0213a', weight: 2.5, dashArray: '8 5' }),
      onEachFeature: (f, lag) => lag.on('click', () => this.naarTrykket(f.properties)),
    });
  }

  settSynlig(paa) {
    if (!this.lag) return;
    if (paa) this.lag.addTo(this.kart);
    else this.lag.remove();
  }

  /** Fredningsområdet punktet ligger i, eller null. */
  omradeFor(lat, lon) {
    const [x, y] = tilVerden(lon, lat);
    return this.omrader.find((o) => x >= o.bbox[0] && x <= o.bbox[2] && y >= o.bbox[1] && y <= o.bbox[3]
      && iFlate(x, y, o)) ?? null;
  }
}
