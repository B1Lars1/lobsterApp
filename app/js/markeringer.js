/*
 * Markeringer: teiner og hummerfangst.
 *
 * Holder alle markeringer i minnet, lagrer hver endring i IndexedDB (lager.js) og
 * leser GeoJSON fra skyen (sky.js) og fra en fil i sikkerhetskopien («Gjenopprett fra
 * fil»). Andre deler av appen kan lytte på endringer med naarEndret().
 *
 * Feltene (de samme som i skyen og sikkerhetskopien, så du kjenner dem igjen i GeoPandas):
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
 *   mistet       true hvis teinen er mistet (da er status 'tatt_opp', og tatt_opp er
 *                når den ble meldt mistet). Fangsten er ukjent, så settingen holdes
 *                utenfor fangstberegningene.                    (teine)
 *   beholdt      antall hummer beholdt                          (hummer)
 *   satt_ut      antall hummer satt ut igjen                    (hummer)
 *   teine_id     id til teinen fangsten kom fra, eller null     (hummer)
 *   registrert_av  bruker-id (Firebase), eller null (uten konto). Teine: eieren, den som
 *                satte den (kan endres i teinearket, og følger teinen når den settes ut
 *                igjen). Fangst: den som registrerte den. Fangsten hører likevel til
 *                eieren av teinen den kom fra (eierAv). Brukes i lag (personer.js).
 * Posisjonen lagres som lat/lon og blir geometrien i GeoJSON.
 *
 * Slettede markeringer huskes (id og tidspunkt), så en sletting også gjelder for
 * kopien i skyen og andre telefoner som synkroniserer (se sky.js). En kopi av
 * markeringen tas også vare på, så den kan gjenopprettes senere (se slettede()).
 */

import * as lager from './lager.js';
import { personer } from './personer.js';

// Feltene i skyen og i sikkerhetskopien (sikkerhetskopi.py har en kopi). En kontrakt med
// analyser_fangst.py og brukerens analyser i GeoPandas: ikke gi dem nye navn.
export const FELT = [
  'id', 'kategori', 'tid', 'endret', 'notat', 'dybde', 'noyaktighet', 'kilde',
  'nummer', 'status', 'tatt_opp', 'beholdt', 'satt_ut', 'teine_id', 'registrert_av', 'mistet',
];

// Id-er er UUID-er fra appen. Alt annet avvises ved import: data fra skyen kan komme fra
// andre (et lag), og id-en havner i HTML-attributter og dokumentstier i Firestore.
const GYLDIG_ID = /^[A-Za-z0-9_-]{1,100}$/;

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
    registrert_av: m.registrert_av ? String(m.registrert_av) : null,
    mistet: teine ? m.mistet === true && m.status === 'tatt_opp' : null,
  };
}

export class Markeringer {
  constructor() {
    this._alle = new Map(); // id -> markering
    // id -> { id, endret: når den ble slettet (ISO), markering: kopi, eller null hvis vi aldri hadde den }
    this._slettinger = new Map();
    this._lyttere = new Set();
    this._dybdeI = null; // (lat, lon) => dybde, settes når dybdedataene er lastet
    this.lagringVirker = true;
    this.registrertAv = null; // bruker-id når du er logget inn (settes av sky.js)
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
      for (const s of await lager.hentSlettinger()) this._slettinger.set(s.id, { markering: null, ...s });
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

  /** Hvem teinen eller fangsten hører til: teinens eier, også for fangst fra teinen. */
  eierAv(m) {
    const teine = m.kategori === 'hummer' ? this.hent(m.teine_id) : null;
    return (teine ?? m).registrert_av;
  }

  /** Er teinen eller fangsten din (se personer.js)? */
  erMin(m) {
    return personer.erMeg(this.eierAv(m));
  }

  /** Står det en teine med dette nummeret og denne eieren i sjøen (unntatt utenId)? */
  nummerBrukt(nummer, eier, utenId = null) {
    return this.teinerISjoen().some((t) => t.nummer === nummer && t.id !== utenId
      && (t.registrert_av ?? null) === (eier ?? null));
  }

  /**
   * Nummer og eier for en ny teine. Hver eier har sine egne numre. Har du tatt opp en teine
   * de siste 12 timene (din, eller en annens som du registrerte fangst fra) og nummeret er
   * ledig, får den nye teinen nummeret og eieren (sist tatt opp først): tas en teine opp og
   * settes ut igjen, er den den samme teinen. Ellers ditt laveste ledige nummer.
   */
  nesteTeine() {
    const meg = this.registrertAv;
    const siden = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const tokOpp = (t) => this.erMin(t) || (meg != null && this.alle().some((f) =>
      f.kategori === 'hummer' && f.teine_id === t.id && f.registrert_av === meg));
    const sistTattOpp = this.alle()
      .filter((t) => t.kategori === 'teine' && t.tatt_opp >= siden && t.nummer >= 1
        && !this.nummerBrukt(t.nummer, t.registrert_av) && tokOpp(t))
      .sort((a, b) => b.tatt_opp.localeCompare(a.tatt_opp))[0];
    if (sistTattOpp) return { nummer: sistTattOpp.nummer, registrert_av: sistTattOpp.registrert_av };
    const brukt = new Set(this.teinerISjoen().filter((t) => this.erMin(t)).map((t) => t.nummer));
    let n = 1;
    while (brukt.has(n)) n++;
    return { nummer: n, registrert_av: meg };
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

  /** Uten nummer får teinen nummer og eier fra nesteTeine(). Med nummer er eieren deg, hvis ikke oppgitt. */
  nyTeine({ lat, lon, noyaktighet = null, kilde = 'gps', ...valg }) {
    const { nummer, registrert_av } = valg.nummer != null
      ? { registrert_av: this.registrertAv, ...valg }
      : this.nesteTeine();
    return this._lagre(normaliser({
      kategori: 'teine', lat, lon, noyaktighet, kilde, nummer, dybde: this._dybde(lat, lon), registrert_av,
    }));
  }

  /** tid kan oppgis (når fangsten ble tatt), ellers nå. «endret» er alltid nå. */
  nyFangst({
    lat, lon, noyaktighet = null, kilde = 'gps', teine_id = null, beholdt = 1, satt_ut = 0, notat = '', tid,
  }) {
    return this._lagre(normaliser({
      kategori: 'hummer', lat, lon, noyaktighet, kilde, teine_id, beholdt, satt_ut, notat, tid,
      endret: naa(), dybde: this._dybde(lat, lon), registrert_av: this.registrertAv,
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

  /** Teinen er mistet: den regnes som tatt opp nå, men med ukjent fangst. */
  merkMistet(id) {
    return this.oppdater(id, { status: 'tatt_opp', tatt_opp: naa(), mistet: true });
  }

  /** En mistet teine er funnet igjen: den står i sjøen igjen, der den var. */
  funnetIgjen(id) {
    return this.oppdater(id, { status: 'i_sjoen', tatt_opp: null, mistet: false });
  }

  /**
   * Slett en markering. Returnerer den, så den kan gjenopprettes med gjenopprett().
   * En kopi tas vare på i listen over slettede, med mindre husk er false (brukes når
   * du angrer en markering du nettopp satte, så den ikke havner i listen).
   */
  async slett(id, { husk = true } = {}) {
    const m = this.hent(id);
    await this._slettLokalt(id, naa(), husk);
    this._varsle();
    return m;
  }

  // Fjern markeringen og husk når den ble slettet, sammen med en kopi av den.
  async _slettLokalt(id, tidspunkt, husk = true) {
    const markering = husk ? this.hent(id) ?? this._slettinger.get(id)?.markering ?? null : null;
    const sletting = { id, endret: tidspunkt, markering };
    this._alle.delete(id);
    this._slettinger.set(id, sletting);
    try {
      await lager.slett(id);
      await lager.lagreSletting(sletting);
    } catch (feil) {
      console.error(feil);
    }
  }

  /** Slettede markeringer som kan gjenopprettes ({ id, endret, markering }), sist slettet først. */
  slettede() {
    return [...this._slettinger.values()]
      .filter((s) => s.markering)
      .sort((a, b) => b.endret.localeCompare(a.endret));
  }

  /** Angre en sletting. Får nytt «endret», så den vinner over slettingen ved synkronisering. */
  async gjenopprett(m) {
    this._slettinger.delete(m.id);
    try {
      await lager.fjernSletting(m.id);
    } catch (feil) {
      console.error(feil);
    }
    return this._lagre({ ...m, endret: naa() });
  }

  // ---------- GeoJSON (skyen og sikkerhetskopien) ----------

  /** Alle slettinger ({ id, endret }) som skal med til skyen, også de uten kopi. */
  slettinger() {
    return [...this._slettinger.values()].map(({ id, endret }) => ({ id, endret }));
  }

  /** Fjern alle markeringer og slettinger fra telefonen (brukes når du logger ut). */
  async tomAlt() {
    this._alle.clear();
    this._slettinger.clear();
    try {
      await lager.tomAlt();
    } catch (feil) {
      console.error(feil);
    }
    this._varsle();
  }

  /**
   * Les markeringer fra en GeoJSON-fil eller fra skyen (sky.js). Markeringer som finnes
   * fra før (samme id), oppdateres bare hvis de nye har en nyere versjon. En liste
   * «slettet» (fra skyen) sletter markeringene her hvis slettingen er nyere.
   */
  async importer(geojson) {
    if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      throw new Error('Filen er ikke en GeoJSON FeatureCollection');
    }
    const resultat = { nye: 0, oppdaterte: 0, uendret: 0, ugyldige: 0, slettet: 0 };

    for (const { id, endret } of Array.isArray(geojson.slettet) ? geojson.slettet : []) {
      if (!GYLDIG_ID.test(id ?? '') || !endret || (this._slettinger.get(id)?.endret ?? '') >= endret) continue;
      const finnes = this.hent(id);
      if (finnes && finnes.endret > endret) continue; // endret her etter slettingen: behold
      if (finnes) resultat.slettet++;
      await this._slettLokalt(id, endret);
    }

    const tilLagring = [];
    for (const f of geojson.features) {
      const p = f?.properties || {};
      const [lon, lat] = f?.geometry?.type === 'Point' ? f.geometry.coordinates : [];
      const kategori = p.kategori ?? p.type;
      const gyldig = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180 && (kategori === 'teine' || kategori === 'hummer')
        && (p.id == null || GYLDIG_ID.test(String(p.id)));
      if (!gyldig) {
        resultat.ugyldige++;
        continue;
      }
      const m = normaliser({ ...p, kategori, lat, lon });
      const finnes = this.hent(m.id);
      const slettetHer = this._slettinger.get(m.id)?.endret;
      if ((finnes && finnes.endret >= m.endret) || (slettetHer && slettetHer >= m.endret)) {
        resultat.uendret++;
        continue;
      }
      resultat[finnes ? 'oppdaterte' : 'nye']++;
      tilLagring.push(m);
      if (slettetHer) {
        // Gjenopprettet et annet sted etter at den ble slettet her: glem slettingen
        this._slettinger.delete(m.id);
        await lager.fjernSletting(m.id);
      }
    }
    for (const m of tilLagring) this._alle.set(m.id, m);
    await lager.lagreMange(tilLagring);
    this._varsle();
    this._fyllInnDybde();
    return resultat;
  }
}

export const markeringer = new Markeringer();
