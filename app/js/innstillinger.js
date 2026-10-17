/*
 * Innstillinger som huskes mellom gangene (tema, dybdetall, hva som vises på kartet).
 * Lagres i nettleserens localStorage. Hvis det ikke er tilgjengelig (f.eks. privat
 * nettlesing), brukes standardverdiene.
 */

const NOKKEL = 'hummerkart.innstillinger';

// Øk når en standardverdi endres for dem som har brukt appen før (se hentInnstillinger)
const VERSJON = 3;

const STANDARD = {
  versjon: VERSJON,
  tema: 'auto',       // 'auto' | 'lys' | 'mork'
  dybdetall: true,
  visFangst: true,      // vis hummerfangst på kartet
  visOpptatte: false,   // vis teiner som er tatt opp
  visTidligere: false,  // vis fangst fra tidligere sesonger (tidligere.js)
  bareMine: false,      // i et lag: vis bare dine teiner og fangst på kartet («Mine | Laget»)
  visFredning: true,    // vis fredningsområder for hummer
  visBunnhint: false,   // tareskog, ålegras og skjellsand
  visPotensial: true,   // hummerpotensial og tarekant (anslag)
  justerPotensial: true, // juster hummerpotensialet etter fangsten (potensialjustering.js)
  sistKopi: null,       // når «Lagre kopi til fil» sist ble brukt (ISO), for kontoer uten sky
};

export function hentInnstillinger() {
  try {
    const raa = JSON.parse(localStorage.getItem(NOKKEL) || '{}');
    const lagret = { ...STANDARD, ...raa };
    // Fjernet: Kartverkets topokart (bakgrunn) og GeoJSON-eksporten (sistEksportert)
    delete lagret.bakgrunn;
    delete lagret.sistEksportert;
    const versjon = raa.versjon ?? 1;
    if (Object.keys(raa).length && versjon < VERSJON) {
      // Versjon 2: bunnhint er av som standard, også for dem som har brukt appen før
      if (versjon < 2) lagret.visBunnhint = false;
      // Versjon 3: det samme for fangst fra tidligere sesonger
      if (versjon < 3) lagret.visTidligere = false;
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
