/*
 * Fangstoversikten (app/js/oversikt.js) regner som fasiten i fangst_fasit.json.
 * Analysen (scripts/analyser_fangst.py) testes mot den samme fasiten i test_regnemaate.py,
 * så de to ikke kan gli fra hverandre uten at det merkes.
 *
 * Kjør fra roten av repoet:  node tests/regnemaate.test.mjs
 * (Kjøres også av workflowen før publisering.)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Markeringer } from '../app/js/markeringer.js';
import { lagSettinger, regnUt } from '../app/js/oversikt.js';
import { personer } from '../app/js/personer.js';

const les = (navn) => JSON.parse(readFileSync(new URL(navn, import.meta.url), 'utf8'));
const data = les('./fangst_testdata.geojson');
const fasit = les('./fangst_fasit.json');

// Markeringene rett inn i minnet (importer() ville lagret i IndexedDB, som Node ikke har)
const markeringer = new Markeringer();
for (const f of data.features) {
  const [lon, lat] = f.geometry.coordinates;
  markeringer._alle.set(f.properties.id, { ...f.properties, lat, lon });
}
personer.sett({ meg: fasit.meg, lag: fasit.lag });

const naa = Date.parse(fasit.naa);
const periode = { fra: 0, til: naa }; // alt, som analysen
const { settinger, fangst } = lagSettinger(markeringer.alle(), naa, (m) => markeringer.eierAv(m));

// Samme utvalg som Fangstoversikt._tegn: «Laget», eller én person (gruppe)
function tall(medtas) {
  const iPerioden = settinger.filter((s) => medtas(s) && s.til > periode.fra && s.fra < periode.til);
  const fangstIPerioden = fangst.filter((f) => medtas(f) && f.ms >= periode.fra && f.ms < periode.til);
  const r = regnUt(periode, naa, iPerioden, fangstIPerioden);
  return {
    settinger: r.settinger, mistet: r.mistet, med_hummer: r.med, teinedogn: r.teinedogn, hummer: r.hummer,
    beholdt: r.beholdt, satt_ut: r.sattUt, hummer_fra_teiner: r.fraTeiner,
    per_teinedogn: r.teinedogn > 0 ? r.fraTeiner / r.teinedogn : null,
  };
}

function sammenlign(navn, faktisk, forventet) {
  for (const [felt, verdi] of Object.entries(forventet)) {
    if (typeof verdi === 'number' && !Number.isInteger(verdi)) {
      assert.ok(Math.abs(faktisk[felt] - verdi) < 1e-9, `${navn}: ${felt} er ${faktisk[felt]}, ventet ${verdi}`);
    } else {
      assert.equal(faktisk[felt], verdi, `${navn}: ${felt}`);
    }
  }
}

sammenlign('Laget', tall(() => true), fasit.laget);
for (const [uid, forventet] of Object.entries(fasit.per_person)) {
  const gruppe = uid === personer.meg ? personer.meg : uid;
  sammenlign(personer.kortnavn(uid), tall((x) => x.gruppe === gruppe), forventet);
}
console.log('Fangstoversikten regner som fasiten');
