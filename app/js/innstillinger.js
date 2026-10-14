/*
 * Innstillinger som huskes mellom gangene (tema, bakgrunnskart, dybdetall).
 * Lagres i nettleserens localStorage. Hvis det ikke er tilgjengelig (f.eks. privat
 * nettlesing), brukes standardverdiene.
 */

const NOKKEL = 'hummerkart.innstillinger';

const STANDARD = {
  tema: 'auto',       // 'auto' | 'lys' | 'mork'
  bakgrunn: 'dybde',  // 'dybde' | 'topo' | 'sjokart'
  dybdetall: true,
};

export function hentInnstillinger() {
  try {
    return { ...STANDARD, ...JSON.parse(localStorage.getItem(NOKKEL) || '{}') };
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
