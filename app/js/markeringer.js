/*
 * Markeringer: teiner og hummerfangst.
 *
 * Holder alle markeringer i minnet, lagrer hver endring i IndexedDB (lager.js) og
 * lager/leser GeoJSON for eksport og import. Andre deler av appen kan lytte på
 * endringer med naarEndret().
 *
 * Feltene (de samme som i GeoJSON-eksporten, så du kjenner dem igjen i GeoPandas):
 *   id           unik id
 *   kategori     'teine' | 'hummer'
 *   tid          når teinen ble satt / fangsten registrert (ISO 8601, UTC)
 *   endret       sist endret (ISO 8601, UTC)
 *   notat        fritekst
 *   dybde        anslått dybde i meter fra dybdedataene (se dybdeoppslag.js)
 *   noyaktighet  GPS-nøyaktighet i meter, null hvis plassert i kartet
 *   kilde        'gps' | 'kart'
 *   nummer       teinenummer                                   (teine)
 *   status       'i_sjoen' | 'tatt_opp'                         (teine)
 *   tatt_opp     når teinen ble tatt opp (ISO 8601) eller null  (teine)
 *   beholdt      antall hummer beholdt                          (hummer)
 *   satt_ut      antall hummer satt ut igjen                    (hummer)
 *   teine_id     id til teinen fangsten kom fra, eller null     (hummer)
 * Posisjonen lagres som lat/lon og blir geometrien i GeoJSON.
 */

import * as lager from './lager.js';

const FELT = [
  'id', 'kategori', 'tid', 'endret', 'notat', 'dybde', 'noyaktighet', 'kilde',
  'nummer', 'status', 'tatt_opp', 'beholdt', 'satt_ut', 'teine_id',
];

const naa = () => new Date().toISOString();
const nyId = () => crypto.randomUUID();
const tallEllerNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Sørg for at en markering har alle felt og riktige typer (brukes også ved import).
function normaliser(m) {
  const teine = m.kategori === 'teine';
  return {
    id: String(m.id || nyId()),
    kategori: m.kategori,
    lat: Number(m.lat),
    lon: Number(m.lon),
    tid: m.tid || naa(),
    endret: m.endret || m.tid || naa(),
    notat: m.notat ? String(m.notat) : '',
    dybde: tallEllerNull(m.dybde),
    noyaktighet: tallEllerNull(m.noyaktighet),
    kilde: m.kilde === 'gps' ? 'gps' : 'kart',
    nummer: teine ? tallEllerNull(m.nummer) : null,
    status: teine ? (m.status === 'tatt_opp' ? 'tatt_opp' : 'i_sjoen') : null,
    tatt_opp: teine ? m.tatt_opp || null : null,
    beholdt: teine ? null : Math.max(0, Math.round(tallEllerNull(m.beholdt) ?? 0)),
    satt_ut: teine ? null : Math.max(0, Math.round(tallEllerNull(m.satt_ut) ?? 0)),
    teine_id: teine ? null : m.teine_id || null,
  };
}

export class Markeringer {
  constructor() {
    this._alle = new Map(); // id -> markering
    this._lyttere = new Set();
    this._dybdeI = null; // (lat, lon) => dybde, settes når dybdedataene er lastet
    this.lagringVirker = true;
  }

  /** Ta i bruk dybdeoppslag, og fyll inn dybde på markeringer som mangler det. */
  settDybdeoppslag(dybdeI) {
    this._dybdeI = dybdeI;
    this._fyllInnDybde();
  }

  _dybde(lat, lon) {
    return this._dybdeI ? this._dybdeI(lat, lon) : null;
  }

  // Dybde er avledet fra kartdataene, så «endret» røres ikke.
  async _fyllInnDybde() {
    if (!this._dybdeI) return;
    const mangler = this.alle().filter((m) => m.dybde == null);
    const oppdatert = [];
    for (const m of mangler) {
      const dybde = this._dybde(m.lat, m.lon);
      if (dybde == null) continue;
      m.dybde = dybde;
      oppdatert.push(m);
    }
    if (!oppdatert.length) return;
    this._varsle();
    try {
      await lager.lagreMange(oppdatert);
    } catch (feil) {
      console.error(feil);
    }
  }

  /** Les inn alle markeringer fra databasen. */
  async last() {
    try {
      for (const m of await lager.hentAlle()) this._alle.set(m.id, m);
    } catch (feil) {
      console.error(feil);
      this.lagringVirker = false;
    }
    this._varsle();
    this._fyllInnDybde();
  }

  naarEndret(funksjon) {
    this._lyttere.add(funksjon);
  }

  _varsle() {
    for (const f of this._lyttere) f();
  }

  async _lagre(m) {
    this._alle.set(m.id, m);
    this._varsle();
    try {
      await lager.lagre(m);
    } catch (feil) {
      console.error(feil);
      this.lagringVirker = false;
    }
    return m;
  }

  hent(id) {
    return this._alle.get(id);
  }

  alle() {
    return [...this._alle.values()];
  }

  teinerISjoen() {
    return this.alle()
      .filter((m) => m.kategori === 'teine' && m.status === 'i_sjoen')
      .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  }

  /** Laveste ledige nummer blant teinene i sjøen (en teine som er tatt opp, kan få nummeret igjen). */
  nesteTeinenummer() {
    const brukt = new Set(this.teinerISjoen().map((t) => t.nummer));
    let n = 1;
    while (brukt.has(n)) n++;
    return n;
  }

  /** Nærmeste teine i sjøen innen maksMeter fra latlng, ellers null. */
  naermesteTeine(latlng, maksMeter = 50) {
    let beste = null;
    let besteAvstand = maksMeter;
    for (const t of this.teinerISjoen()) {
      const avstand = latlng.distanceTo([t.lat, t.lon]);
      if (avstand <= besteAvstand) {
        beste = t;
        besteAvstand = avstand;
      }
    }
    return beste;
  }

  nyTeine({ lat, lon, noyaktighet = null, kilde = 'gps', nummer = this.nesteTeinenummer() }) {
    return this._lagre(normaliser({
      kategori: 'teine', lat, lon, noyaktighet, kilde, nummer, dybde: this._dybde(lat, lon),
    }));
  }

  nyFangst({ lat, lon, noyaktighet = null, kilde = 'gps', teine_id = null, beholdt = 1, satt_ut = 0 }) {
    return this._lagre(normaliser({
      kategori: 'hummer', lat, lon, noyaktighet, kilde, teine_id, beholdt, satt_ut,
      dybde: this._dybde(lat, lon),
    }));
  }

  oppdater(id, endringer) {
    const m = { ...this.hent(id), ...endringer, endret: naa() };
    if ('lat' in endringer || 'lon' in endringer) m.dybde = this._dybde(m.lat, m.lon); // flyttet
    return this._lagre(m);
  }

  taOpp(id) {
    return this.oppdater(id, { status: 'tatt_opp', tatt_opp: naa() });
  }

  /** Slett for godt. Returnerer markeringen, så den kan gjenopprettes med gjenopprett(). */
  async slett(id) {
    const m = this.hent(id);
    this._alle.delete(id);
    this._varsle();
    try {
      await lager.slett(id);
    } catch (feil) {
      console.error(feil);
    }
    return m;
  }

  gjenopprett(m) {
    return this._lagre(m);
  }

  // ---------- GeoJSON ----------

  tilGeoJSON() {
    const runde = (v) => Math.round(v * 1e6) / 1e6; // ca. 0,1 m
    return {
      type: 'FeatureCollection',
      features: this.alle()
        .sort((a, b) => a.tid.localeCompare(b.tid))
        .map((m) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [runde(m.lon), runde(m.lat)] },
          properties: Object.fromEntries(FELT.map((f) => [f, m[f] ?? null])),
        })),
    };
  }

  /**
   * Les markeringer fra en GeoJSON-fil. Markeringer som finnes fra før (samme id),
   * oppdateres bare hvis filen har en nyere versjon.
   */
  async importer(geojson) {
    if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      throw new Error('Filen er ikke en GeoJSON FeatureCollection');
    }
    const resultat = { nye: 0, oppdaterte: 0, uendret: 0, ugyldige: 0 };
    const tilLagring = [];
    for (const f of geojson.features) {
      const p = f?.properties || {};
      const [lon, lat] = f?.geometry?.type === 'Point' ? f.geometry.coordinates : [];
      const kategori = p.kategori ?? p.type;
      const gyldig = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180 && (kategori === 'teine' || kategori === 'hummer');
      if (!gyldig) {
        resultat.ugyldige++;
        continue;
      }
      const m = normaliser({ ...p, kategori, lat, lon });
      const finnes = this.hent(m.id);
      if (finnes && finnes.endret >= m.endret) {
        resultat.uendret++;
        continue;
      }
      resultat[finnes ? 'oppdaterte' : 'nye']++;
      tilLagring.push(m);
    }
    for (const m of tilLagring) this._alle.set(m.id, m);
    await lager.lagreMange(tilLagring);
    this._varsle();
    this._fyllInnDybde();
    return resultat;
  }
}

export const markeringer = new Markeringer();
