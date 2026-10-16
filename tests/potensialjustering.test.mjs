/*
 * Hummerpotensialet justert etter fangsten (app/js/potensialjustering.js): en fangst øker
 * anslaget mer enn en tom teine senker det, virkningen avtar med avstanden, og ruter i
 * fredningsområdene tas ikke med. Oppdiktede data.
 *
 * Kjør fra roten av repoet:  node tests/potensialjustering.test.mjs
 * (Kjøres også av workflowen før publisering.)
 */

import assert from 'node:assert/strict';

// dybdelag.js lager et Leaflet-lag når den lastes. Node har ikke Leaflet.
globalThis.L = { GridLayer: { extend: (o) => o } };
const { Rutenett, lagObjekter, tilVerden } = await import('../app/js/dybdelag.js');
const { DOGN_UTEN_TEINE, FORVENTET, MODELL_DOGN, klasseFor, justeringTekst, lagJustering } = await import('../app/js/potensialjustering.js');

// Modellen: én flate med middels potensial rundt punktet
const [LON, LAT] = [8.4, 58.22];
const flate = (klasse, d) => ({ type: 'Feature', properties: { klasse }, geometry: { type: 'Polygon',
  coordinates: [[[LON - d, LAT - d], [LON + d, LAT - d], [LON + d, LAT + d], [LON - d, LAT + d], [LON - d, LAT - d]]] } });
const modell = (klasse) => ({ potensial: new Rutenett(lagObjekter({ features: [flate(klasse, 0.02)] }, (p) => ({ hoy: p.klasse === 'hoy' }))) });
const data = modell('middels');
// Tegnes ruten i punktet (klassen er en annen enn modellens)?
const tegnes = (j, lat = LAT, lon = LON) => {
  const [x, y] = tilVerden(lon, lat);
  return j.celler.sok([x, y, x, y]).length > 0;
};
const naer = (a, b, melding) => assert.ok(Math.abs(a - b) < 1e-9, `${melding}: ${a}, ventet ${b}`);
const ostover = (meter) => LON + meter / (111320 * Math.cos((LAT * Math.PI) / 180)); // lengdegrader

const forventet = FORVENTET.middels;
const enFangst = lagJustering([{ lat: LAT, lon: LON, hummer: 1, dogn: 1 }], data).cellFor(LAT, LON);
const tom = lagJustering([{ lat: LAT, lon: LON, hummer: 0, dogn: 1 }], data).cellFor(LAT, LON);
naer(enFangst.rate, (forventet * MODELL_DOGN + 1) / (MODELL_DOGN + 1), 'én hummer på ett døgn');
naer(tom.rate, (forventet * MODELL_DOGN) / (MODELL_DOGN + 1), 'ett tomt døgn');
assert.equal(enFangst.modell, 'middels');
assert.ok(enFangst.rate - forventet > 3 * (forventet - tom.rate), 'en fangst øker mye mer enn en tom teine senker');

// Mange tomme teinedøgn trekker anslaget ned til lavt
const tiTomme = lagJustering([{ lat: LAT, lon: LON, hummer: 0, dogn: 10 }], data).cellFor(LAT, LON);
assert.equal(klasseFor(tiTomme.rate), 'lav', 'ti tomme teinedøgn');

// Virkningen avtar med avstanden: halvveis ved ca. 100 m, ingenting etter 150 m
const j = lagJustering([{ lat: LAT, lon: LON, hummer: 1, dogn: 1 }], data);
const ved100 = j.cellFor(LAT, ostover(100));
assert.ok(ved100.rate > forventet && ved100.rate < enFangst.rate, `100 m unna: ${ved100.rate}`);
assert.equal(j.cellFor(LAT, ostover(300)), null, '300 m unna er ikke justert');

// Ingen ruter i fredningsområdene
const iFredning = lagJustering([{ lat: LAT, lon: LON, hummer: 3, dogn: 1 }], data, () => true);
assert.equal(iFredning.cellFor(LAT, LON), null, 'fredningsområde');

// Kartet tegner bare ruter som bytter klasse. Én tom teine i middels: litt lavere, men fortsatt
// middels, så den tegnes ikke (teksten ved trykk viser endringen). Én fangst: høyt, tegnes.
const tomJ = lagJustering([{ lat: LAT, lon: LON, hummer: 0, dogn: 1 }], data);
assert.equal(tomJ.cellFor(LAT, LON).klasse, 'middels');
assert.equal(tegnes(tomJ), false, 'én tom teine i middels tegnes ikke');
const fangstJ = lagJustering([{ lat: LAT, lon: LON, hummer: 1, dogn: 1 }], data);
assert.equal(fangstJ.cellFor(LAT, LON).klasse, 'hoy');
assert.ok(tegnes(fangstJ), 'én fangst i middels gir høyt');

// I høyt potensial: ett tomt døgn er fortsatt høyt, tre tomme døgn gir middels
const hoy = modell('hoy');
const ettTomt = lagJustering([{ lat: LAT, lon: LON, hummer: 0, dogn: 1 }], hoy);
assert.equal(ettTomt.cellFor(LAT, LON).klasse, 'hoy');
assert.equal(tegnes(ettTomt), false);
const treTomme = lagJustering([{ lat: LAT, lon: LON, hummer: 0, dogn: 3 }], hoy);
assert.equal(treTomme.cellFor(LAT, LON).klasse, 'middels');
assert.ok(tegnes(treTomme), 'tre tomme døgn i høyt gir middels');

// God fangst gir «svært høyt», med strek rundt
const godJ = lagJustering([{ lat: LAT, lon: LON, hummer: 3, dogn: 1 }], data);
assert.equal(godJ.cellFor(LAT, LON).klasse, 'svaert');
assert.equal(klasseFor(FORVENTET.hoy), 'hoy');

// Fangst uten teine teller som en teine som har stått ett døgn: 3 hummer der modellen sier lavt
const utenTeine = lagJustering([{ lat: LAT, lon: LON, hummer: 3, dogn: DOGN_UTEN_TEINE, utenTeine: true }], { potensial: new Rutenett([]) });
const c = utenTeine.cellFor(LAT, LON);
assert.equal(c.modell, 'lav');
naer(c.rate, (FORVENTET.lav * MODELL_DOGN + 3) / (MODELL_DOGN + DOGN_UTEN_TEINE), '3 hummer uten teine');
assert.equal(c.klasse, 'hoy');
assert.ok(tegnes(utenTeine), 'fangst uten teine tegnes');
assert.match(justeringTekst(c), /1 fangst uten teine, 3 hummer/);

console.log('Justeringen av hummerpotensialet regner riktig');
