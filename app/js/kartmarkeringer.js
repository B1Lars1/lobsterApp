/*
 * Viser markeringene på kartet med egne symboler (utseendet ligger i app.css):
 *   teine i sjøen   svart bøyleteine sett fra siden, med nummer
 *   teine tatt opp  grå, stiplet teine (bare når «Opptatte teiner» er slått på)
 *   hummer          hvit sirkel med hummer og rød kant, antall som merke
 *   rødt «!»        teinen ligger i et fredningsområde
 *
 * Symbolene er vanlige HTML-elementer (L.divIcon). Det går fint for noen hundre
 * markeringer. Kartet oppdateres automatisk når markeringene endres.
 */

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
    this.visOpptatte = false;
    this.visFangst = true;
    this.flytter = null; // id til markeringen som flyttes nå
    this.iFredning = () => false; // settes når fredningsområdene er lastet
    markeringer.naarEndret(() => this.tegn());
  }

  settValg({ visOpptatte, visFangst }) {
    this.visOpptatte = visOpptatte;
    this.visFangst = visFangst;
    this.tegn();
  }

  _synlig(m) {
    if (m.id === this.flytter) return true;
    if (m.kategori === 'hummer') return this.visFangst;
    return m.status === 'i_sjoen' || this.visOpptatte;
  }

  // Lager eller oppdaterer symbolene, og fjerner de som ikke skal vises lenger.
  tegn() {
    const synlige = new Set();
    for (const m of this.markeringer.alle()) {
      if (!this._synlig(m)) continue;
      synlige.add(m.id);
      const { html, klasse, storrelse, z } = symbol(m, this.iFredning(m));
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

function symbol(m, iFredning) {
  if (m.kategori === 'teine') {
    const iSjoen = m.status === 'i_sjoen';
    const varsel = iSjoen && iFredning ? '<b class="varsel" title="I fredningsområde">!</b>' : '';
    return {
      html: `<span>${m.nummer ?? '?'}</span>${varsel}`,
      klasse: iSjoen ? 'teine' : 'teine opptatt',
      storrelse: [58, 40], // bredere enn høy, som tegningen av teinen
      z: iSjoen ? 500 : -200,
    };
  }
  const antall = m.beholdt + m.satt_ut;
  return {
    html: `<span class="emoji">🦞</span>${antall > 1 ? `<b class="antall">${antall}</b>` : ''}`,
    klasse: m.beholdt > 0 ? 'hummer' : 'hummer bare-satt-ut',
    storrelse: [36, 36],
    z: 0,
  };
}
