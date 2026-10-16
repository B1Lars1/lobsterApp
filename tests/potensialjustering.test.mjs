/*
 * Hummerpotensialet justert etter fangsten (app/js/potensialjustering.js): en fangst øker
 * anslaget mer enn en tom teine senker det, modellen teller mest (minst der den sier lavt),
 * virkningen avtar med avstanden og følger terrenget (modellens klasse) og dybden der
 * fangsten ble tatt, og ruter i fredningsområdene tas ikke med. Oppdiktede data.
 *
 * Kjør fra roten av repoet:  node tests/potensialjustering.test.mjs
 * (Kjøres også av workflowen før publisering.)
 */

import assert from 'node:assert/strict';

// dybdelag.js lager et Leaflet-lag når den lastes. Node har ikke Leaflet.
globalThis.L = { GridLayer: { extend: (o) => o } };
const { Rutenett, lagObjekter, tilVerden } = await import('../app/js/dybdelag.js');
const {
  DOGN_UTEN_TEINE, FORVENTET, MODELL_DOGN, TERRENG, dybdelikhet, justeringTekst, lagJustering,
} = await import('../app/js/potensialjustering.js');

// Modellen: én flate rundt punktet (eller ingen, for lavt potensial)
const [LON, LAT] = [8.4, 58.22];
const flate = (klasse, d) => ({ type: 'Feature', properties: { klasse }, geometry: { type: 'Polygon',
  coordinates: [[[LON - d, LAT - d], [LON + d, LAT - d], [LON + d, LAT + d], [LON - d, LAT + d], [LON - d, LAT - d]]] } });
const modell = (klasse) => ({ potensial: new Rutenett(klasse
  ? lagObjekter({ features: [flate(klasse, 0.02)] }, (p) => ({ hoy: p.klasse === 'hoy' })) : []) });
const naer = (a, b, melding) => assert.ok(Math.abs(a - b) < 1e-9, `${melding}: ${a}, ventet ${b}`);
const ostover = (meter) => LON + meter / (111320 * Math.cos((LAT * Math.PI) / 180)); // lengdegrader
const her = (hummer, dogn, utenTeine = false, lon = LON) => ({ lat: LAT, lon, dybde: null, hummer, dogn, utenTeine });
const dogn = (antall, hummer = 0, utenTeine = false) =>
  Array.from({ length: antall }, (_, i) => her(i < hummer ? 1 : 0, 1, utenTeine));
// dybde: et tall (flatt) eller en funksjon av x (verdenskoordinater)
const juster = (settinger, klasse, dybde = 15) =>
  lagJustering(settinger, modell(klasse), { dybde: typeof dybde === 'function' ? dybde : () => dybde });
// Tegnes ruten i punktet (klassen er en annen enn modellens)?
const tegnes = (j, lon = LON) => {
  const [x, y] = tilVerden(lon, LAT);
  return j.celler.sok([x, y, x, y]).length > 0;
};

// Gamma-Poisson med terrengvekt: middels teller med vekt TERRENG.middels
const f = FORVENTET.middels;
const v = TERRENG.middels;
const md = MODELL_DOGN.middels;
const enFangst = juster([her(1, 1)], 'middels').cellFor(LAT, LON);
const ettTomt = juster([her(0, 1)], 'middels').cellFor(LAT, LON);
naer(enFangst.rate, (f * md + v) / (md + v), 'én hummer på ett døgn');
naer(ettTomt.rate, (f * md) / (md + v), 'ett tomt døgn');
assert.equal(enFangst.modell, 'middels');
assert.ok(enFangst.rate - f > 3 * (f - ettTomt.rate), 'en fangst øker mye mer enn en tom teine senker');

// Modellen teller mest: én hummer eller ett tomt døgn bytter ikke klasse, og tegnes ikke
assert.equal(enFangst.klasse, 'middels');
assert.equal(tegnes(juster([her(1, 1)], 'middels')), false, 'én hummer i middels tegnes ikke');
assert.equal(ettTomt.klasse, 'middels');
// To hummer på to døgn gir høyt, tolv tomme døgn lavt
assert.equal(juster(dogn(2, 2), 'middels').cellFor(LAT, LON).klasse, 'hoy');
assert.ok(tegnes(juster(dogn(2, 2), 'middels')));
assert.equal(juster(dogn(12), 'middels').cellFor(LAT, LON).klasse, 'lav');

// Høyt: fire tomme døgn er fortsatt høyt, seks gir middels. Fire hummer på tre døgn: svært høyt.
assert.equal(juster(dogn(4), 'hoy').cellFor(LAT, LON).klasse, 'hoy');
assert.equal(juster(dogn(6), 'hoy').cellFor(LAT, LON).klasse, 'middels');
assert.equal(juster([her(4, 3)], 'hoy').cellFor(LAT, LON).klasse, 'svaert');

// Virkningen avtar med avstanden: mindre 60 m unna, ingenting etter 100 m
const j = juster(dogn(2, 2), 'middels');
const ved60 = j.cellFor(LAT, ostover(60));
assert.ok(ved60.rate > f && ved60.rate < j.cellFor(LAT, LON).rate, `60 m unna: ${ved60.rate}`);
assert.equal(j.cellFor(LAT, ostover(150)), null, '150 m unna er ikke justert');

// Der modellen sier lavt, teller den mindre (MODELL_DOGN.lav), og fangsten med TERRENG.lav.
// Fangst uten teine teller som én teine i ett døgn: tre hummer gir middels rett der, men ikke
// 80 m unna. Én hummer er fortsatt lavt, fire hummer gir høyt.
const utenTeine = juster(dogn(3, 3, true), null);
const c = utenTeine.cellFor(LAT, LON);
assert.equal(c.modell, 'lav');
const lav = TERRENG.lav;
naer(c.rate, (FORVENTET.lav * MODELL_DOGN.lav + 3 * lav) / (MODELL_DOGN.lav + 3 * DOGN_UTEN_TEINE * lav), 'tre hummer uten teine');
assert.equal(c.klasse, 'middels');
assert.ok(tegnes(utenTeine), 'fangst uten teine tegnes');
assert.equal(tegnes(utenTeine, ostover(80)), false, '80 m unna tegnes ikke');
assert.match(justeringTekst(c), /3 fangster uten teine, 3 hummer/);
assert.equal(juster([her(1, 1)], null).cellFor(LAT, LON).klasse, 'lav', 'én hummer i lavt');
assert.equal(juster([her(4, 3)], null).cellFor(LAT, LON).klasse, 'hoy', 'fire hummer i lavt');

// Tre hummer spredt over 100 m, der modellen sier lavt: middels langs hele strekningen
const spredt = juster([0, 50, 100].map((m) => her(1, 2, false, ostover(m))), null);
for (const m of [0, 50, 100]) assert.equal(spredt.cellFor(LAT, ostover(m)).klasse, 'middels', `${m} m langs`);
assert.equal(tegnes(spredt, ostover(160)), false, 'utenfor strekningen');

// Dybden: fangsten teller også grunt (der den ble tatt), men sprer seg bare til ruter med
// omtrent samme dybde. I en skråning (1 m dypere per 3 m østover) når den ikke ut i dypet.
assert.equal(juster(dogn(3, 3), null, 3).cellFor(LAT, LON).klasse, 'middels', 'grunt');
const [X0] = tilVerden(LON, LAT);
const meterPerEnhet = 111320 * 360 * Math.cos((LAT * Math.PI) / 180);
const skraning = juster(dogn(3, 3), null, (x) => 15 + ((x - X0) * meterPerEnhet) / 3);
assert.equal(skraning.cellFor(LAT, LON).klasse, 'middels');
assert.equal(tegnes(skraning, ostover(60)), false, '20 m dypere tegnes ikke');
assert.equal(dybdelikhet(10, 12), 1);
assert.equal(dybdelikhet(10, 30), 0);
assert.equal(dybdelikhet(null, 12), 0.5, 'ukjent dybde');

// Ingen ruter i fredningsområdene
const iFredning = lagJustering([her(3, 1)], modell('middels'), { iFredning: () => true });
assert.equal(iFredning.cellFor(LAT, LON), null, 'fredningsområde');

console.log('Justeringen av hummerpotensialet regner riktig');
