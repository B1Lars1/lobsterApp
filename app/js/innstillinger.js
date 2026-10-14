/*
 * Innstillinger som huskes mellom gangene (tema, bakgrunnskart, dybdetall).
 * Lagres i nettleserens localStorage. Hvis det ikke er tilgjengelig (f.eks. privat
 * nettlesing), brukes standardverdiene.
 */

const NOKKEL = 'hummerkart.innstillinger';

const STANDARD = {
  tema: 'auto',       // 'auto' | 'lys' | 'mork'
  bakgrunn: 'dybde',  // 'dybde' | 'topo'
  dybdetall: true,
  visFangst: true,      // vis hummerfangst på kartet
  visOpptatte: false,   // vis teiner som er tatt opp
  visFredning: true,    // vis fredningsområder for hummer
  visBunnhint: true,    // tareskog, ålegras og skjellsand
  sistEksportert: null, // tidspunkt (ISO) for siste GeoJSON-eksport
};

export function hentInnstillinger() {
  try {
    const lagret = { ...STANDARD, ...JSON.parse(localStorage.getItem(NOKKEL) || '{}') };
    if (!['dybde', 'topo'].includes(lagret.bakgrunn)) lagret.bakgrunn = 'dybde'; // sjøkart er fjernet
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
