/*
 * Innstillinger som huskes mellom gangene (tema, dybdetall, hva som vises på kartet).
 * Lagres i nettleserens localStorage. Hvis det ikke er tilgjengelig (f.eks. privat
 * nettlesing), brukes standardverdiene.
 */

const NOKKEL = 'hummerkart.innstillinger';

// Øk når en standardverdi endres for dem som har brukt appen før (se hentInnstillinger)
const VERSJON = 2;

const STANDARD = {
  versjon: VERSJON,
  tema: 'auto',       // 'auto' | 'lys' | 'mork'
  dybdetall: true,
  visFangst: true,      // vis hummerfangst på kartet
  visOpptatte: false,   // vis teiner som er tatt opp
  visTidligere: true,   // vis fangst fra tidligere sesonger (tidligere.js)
  visFredning: true,    // vis fredningsområder for hummer
  visBunnhint: false,   // tareskog, ålegras og skjellsand
  visPotensial: true,   // hummerpotensial og tarekant (anslag)
};

export function hentInnstillinger() {
  try {
    const raa = JSON.parse(localStorage.getItem(NOKKEL) || '{}');
    const lagret = { ...STANDARD, ...raa };
    // Fjernet: Kartverkets topokart (bakgrunn) og GeoJSON-eksporten (sistEksportert)
    delete lagret.bakgrunn;
    delete lagret.sistEksportert;
    if (Object.keys(raa).length && (raa.versjon ?? 1) < 2) {
      // Versjon 2: bunnhint er av som standard, også for dem som har brukt appen før
      lagret.visBunnhint = false;
      lagret.versjon = VERSJON;
      lagreInnstillinger(lagret);
    }
    return lagret;
  } catch {
    return { ...STANDARD };
  }
}

export function lagreInnstillinger(innstillinger) {
  try {
    localStorage.setItem(NOKKEL, JSON.stringify(innstillinger));
  } catch {
    // Ikke kritisk: innstillingene gjelder da bare til appen lukkes.
  }
}

/** Gjør 'auto' om til 'lys' eller 'mork' ut fra telefonens innstilling. */
export function faktiskTema(tema) {
  if (tema !== 'auto') return tema;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mork' : 'lys';
}
