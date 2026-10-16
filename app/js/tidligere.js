/*
 * Fangst fra tidligere sesonger som et eget kartlag, så erfaringen fra i fjor kan brukes når
 * teinene settes i år. Resten av kartet viser bare sesongen som pågår (kartmarkeringer.js).
 *
 * Hver teinesetting fra før sesongen (før 1. oktober i år, eller før 1. oktober i fjor når
 * sesongen er over) er et punkt der teinen stod:
 *   rød prikk med hvit kant  ga hummer (større jo flere, opptil 4)
 *   hul grå ring             ingen hummer
 * Fangst uten teine er en rød prikk. Mistede teiner er ikke med, siden fangsten er ukjent.
 * Teinene til de andre i laget er også med: det er erfaring om stedet.
 *
 * Trykk på et punkt viser hva teinene innen NAER_M har gitt, regnet som i fangstoversikten
 * (lagSettinger i oversikt.js): andelen settinger med hummer og hummer per teinedøgn.
 *
 * Punktene tegnes på canvas (L.circleMarker med L.canvas), ikke som HTML-symboler, så
 * tusenvis av settinger fra mange år går fint.
 */

import { visMelding } from './melding.js';
import { hummersesong, lagSettinger } from './oversikt.js';

const NAER_M = 50; // settinger så nær hverandre regnes som samme sted når du trykker
const DAG = 24 * 60 * 60 * 1000;
const HUMMER = '#d0213a'; // samme røde som fangsten ellers i appen
const INGEN = '#6b7580';

const komma = (tall, desimaler) =>
  tall.toLocaleString('nb-NO', { minimumFractionDigits: desimaler, maximumFractionDigits: desimaler });

export class TidligereFangst {
  /**
   * @param {L.Map} kart
   * @param {import('./markeringer.js').Markeringer} markeringer
   */
  constructor(kart, markeringer) {
    this.kart = kart;
    this.markeringer = markeringer;
    this.synlig = false;
    this._punkter = []; // { lat, lon, hummer, dogn (null for fangst uten teine), aar }
    this._signatur = ''; // tegnes bare på nytt når punktene er endret
    this._timer = null;
    // Eget lag over fredningsområdene (450), men under teinene og fangsten fra i år
    kart.createPane('tidligere').style.zIndex = 460;
    this._tegner = L.canvas({ pane: 'tidligere', tolerance: 10 }); // romslig for fingeren
    this.lag = L.layerGroup();
    // Synkroniseringen kan endre mange markeringer på rad: tegn én gang etterpå
    markeringer.naarEndret(() => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.tegn(), 300);
    });
  }

  settSynlig(paa) {
    this.synlig = paa;
    if (paa) {
      this.tegn();
      this.lag.addTo(this.kart);
    } else {
      this.lag.remove();
    }
  }

  /** Teinesettinger og fangst uten teine fra før sesongen som pågår (eller den siste). */
  _hentPunkter() {
    const start = hummersesong().fra;
    const { settinger, utenTeine } = lagSettinger(this.markeringer.alle(), Date.now(),
      (m) => this.markeringer.eierAv(m));
    const aar = (ms) => hummersesong(ms).aar;
    return [
      ...settinger.filter((s) => s.fra < start && !s.iSjoen && !s.mistet)
        .map((s) => ({ lat: s.lat, lon: s.lon, hummer: s.hummer, dogn: (s.til - s.fra) / DAG, aar: aar(s.fra) })),
      ...utenTeine.filter((f) => f.ms < start)
        .map((f) => ({ lat: f.lat, lon: f.lon, hummer: f.hummer, dogn: null, aar: aar(f.ms) })),
    ];
  }

  tegn() {
    if (!this.synlig) return;
    const punkter = this._hentPunkter();
    const signatur = JSON.stringify(punkter.map((p) => [p.lat, p.lon, p.hummer, p.dogn]));
    if (signatur === this._signatur) return;
    this._signatur = signatur;
    this._punkter = punkter;
    this.lag.clearLayers();
    // De tomme først, så prikkene med hummer ligger øverst
    for (const p of [...punkter].sort((a, b) => (a.hummer > 0) - (b.hummer > 0))) {
      const med = p.hummer > 0;
      L.circleMarker([p.lat, p.lon], {
        renderer: this._tegner,
        radius: med ? 4 + Math.min(p.hummer, 4) * 1.5 : 4.5,
        color: med ? '#ffffff' : INGEN,
        weight: med ? 1.5 : 2,
        fillColor: med ? HUMMER : '#ffffff',
        fillOpacity: med ? 0.9 : 0.5,
        bubblingMouseEvents: false, // trykket skal ikke også vise bunnhintet (kartets klikk)
      }).on('click', () => this._visHer(p)).addTo(this.lag);
    }
  }

  // «Tidligere her (sesongen 2025, innen 50 m): 2 av 3 teinesettinger ga hummer, 4 hummer,
  // 0,89 per teinedøgn»
  _visHer(p) {
    const her = L.latLng(p.lat, p.lon);
    const naer = this._punkter.filter((q) => her.distanceTo([q.lat, q.lon]) <= NAER_M);
    const settinger = naer.filter((q) => q.dogn != null);
    const med = settinger.filter((q) => q.hummer > 0).length;
    const dogn = settinger.reduce((s, q) => s + q.dogn, 0);
    const fraTeiner = settinger.reduce((s, q) => s + q.hummer, 0);
    const hummer = naer.reduce((s, q) => s + q.hummer, 0);
    const aar = [...new Set(naer.map((q) => q.aar))].sort((a, b) => a - b);
    const sesonger = aar.length > 1 ? `sesongene ${aar[0]}–${aar.at(-1)}` : `sesongen ${aar[0]}`;
    const deler = [];
    if (settinger.length) {
      deler.push(`${med} av ${settinger.length} ${settinger.length === 1 ? 'teinesetting' : 'teinesettinger'} ga hummer`);
    }
    deler.push(`${hummer} hummer`);
    if (dogn > 0) deler.push(`${komma(fraTeiner / dogn, 2)} per teinedøgn`);
    visMelding(`Tidligere her (${sesonger}, innen ${NAER_M} m): ${deler.join(', ')}`, { ms: 7000 });
  }
}
