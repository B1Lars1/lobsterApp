/*
 * GPS: viser posisjonen din som en blå prikk med nøyaktighetssirkel, en pil når
 * du er i fart, og kan følge deg på kartet.
 *
 * Batteri: posisjonen hentes bare mens appen er synlig. Når skjermen slås av eller
 * du bytter app, stoppes GPS-en, og den startes igjen når du kommer tilbake.
 * maximumAge gjør at telefonen kan gjenbruke en fersk posisjon i stedet for å spørre på nytt.
 *
 * Testing på PC uten GPS: legg til ?simuler=58.2405,8.3810 i adressen.
 */

const GPS_VALG = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
const FART_GRENSE = 0.5; // m/s – under dette er retningen fra GPS-en upålitelig

export class Gps {
  /**
   * @param {L.Map} kart
   * @param {(status: object) => void} naarStatus  kalles ved ny posisjon, feil eller endret «følg»
   * @param {(latlng: L.LatLng) => Promise<boolean>} naerSjoen  er posisjonen på eller nær sjøen?
   */
  constructor(kart, naarStatus, naerSjoen) {
    this.kart = kart;
    this.naarStatus = naarStatus;
    this._naerSjoen = naerSjoen;
    this.posisjon = null; // { latlng, noyaktighet, fart, retning, tid }
    this.folger = false;
    this._vaktId = null;
    this._simulert = null;
    this._brukerHarFlyttetKartet = false;

    this._sirkel = L.circle([0, 0], {
      radius: 1, interactive: false, className: 'gps-sirkel', weight: 1,
    });
    this._prikk = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'gps-markor',
        html: '<div class="gps-pil"></div><div class="gps-prikk"></div>',
        iconSize: [28, 28],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 400, // under teinene, så nummeret synes når du står ved en teine
    });

    // Drar du i kartet selv, slutter kartet å følge deg.
    kart.on('dragstart', () => {
      this._brukerHarFlyttetKartet = true;
      this.settFolg(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._stopp();
      else this._start();
    });
  }

  start() {
    const sim = new URLSearchParams(location.search).get('simuler');
    if (sim) {
      const [lat, lon] = sim.split(',').map(Number);
      this._simulert = { latitude: lat, longitude: lon, accuracy: 8, speed: null, heading: null };
      this._nyPosisjon(this._simulert);
      return;
    }
    if (!('geolocation' in navigator)) {
      this.naarStatus({ type: 'feil', tekst: 'Telefonen støtter ikke GPS i nettleseren' });
      return;
    }
    this._start();
  }

  get erSimulert() {
    return this._simulert !== null;
  }

  _start() {
    if (this._simulert || this._vaktId !== null || !('geolocation' in navigator)) return;
    this._vaktId = navigator.geolocation.watchPosition(
      (p) => this._nyPosisjon(p.coords),
      (f) => this._feil(f),
      GPS_VALG,
    );
  }

  _stopp() {
    if (this._vaktId === null) return;
    navigator.geolocation.clearWatch(this._vaktId);
    this._vaktId = null;
  }

  _nyPosisjon(c) {
    const latlng = L.latLng(c.latitude, c.longitude);
    const forste = !this.posisjon;
    this.posisjon = {
      latlng, noyaktighet: c.accuracy, fart: c.speed, retning: c.heading, tid: Date.now(),
    };

    this._sirkel.setLatLng(latlng).setRadius(c.accuracy);
    this._prikk.setLatLng(latlng);
    if (forste) {
      this._sirkel.addTo(this.kart);
      this._prikk.addTo(this.kart);
    }

    // Vis pil i fartsretningen når du er i bevegelse.
    const el = this._prikk.getElement();
    const iFart = c.speed != null && c.speed > FART_GRENSE && Number.isFinite(c.heading);
    el.classList.toggle('i-fart', iFart);
    if (iFart) el.style.setProperty('--retning', `${c.heading}deg`);

    if (this.folger) {
      this.kart.panTo(latlng);
    } else if (forste && !this._brukerHarFlyttetKartet) {
      this._visHvisNaerSjoen(latlng);
    }
    this.naarStatus({ type: 'posisjon', posisjon: this.posisjon });
  }

  // Når appen åpnes, flyttes kartet til deg bare hvis du er på eller nær sjøen. Ellers blir
  // det stående over Lillesand (START i app.js), så du ikke ser en prikk midt på land.
  // Svaret kommer når dybdedataene er lastet.
  async _visHvisNaerSjoen(latlng) {
    if (!(await this._naerSjoen(latlng))) return;
    if (this.folger || this._brukerHarFlyttetKartet) return; // du har flyttet kartet selv imens
    this.kart.setView(this.posisjon.latlng, Math.max(this.kart.getZoom(), 15));
  }

  _feil(f) {
    const tekster = {
      1: 'GPS er ikke tillatt. Gi nettstedet tilgang til posisjon.',
      2: 'Finner ikke posisjonen',
      3: 'Venter på GPS …',
    };
    this.naarStatus({ type: 'feil', kode: f.code, tekst: tekster[f.code] || f.message });
  }

  /** Slå «følg meg» av eller på. Returnerer false hvis det ikke finnes noen posisjon ennå. */
  settFolg(paa) {
    if (paa && !this.posisjon) return false;
    this.folger = paa;
    if (paa) this.kart.setView(this.posisjon.latlng, Math.max(this.kart.getZoom(), 15));
    this.naarStatus({ type: 'folg', folger: paa });
    return true;
  }
}
