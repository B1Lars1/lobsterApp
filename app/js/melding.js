/*
 * Korte meldinger øverst på skjermen, eventuelt med en knapp (f.eks. «Angre»).
 */

let timer;

/**
 * @param {string} tekst
 * @param {{knapp?: string, handling?: () => void, ms?: number}} [valg]
 */
export function visMelding(tekst, { knapp, handling, ms } = {}) {
  const boks = document.getElementById('melding');
  const tekstEl = document.createElement('span');
  tekstEl.textContent = tekst;
  boks.replaceChildren(tekstEl);

  if (knapp && handling) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = knapp;
    b.addEventListener('click', () => {
      skjulMelding();
      handling();
    });
    boks.append(b);
  }
  boks.classList.add('vis');
  boks.classList.toggle('med-knapp', Boolean(knapp));
  clearTimeout(timer);
  timer = setTimeout(skjulMelding, ms ?? (knapp ? 6000 : 2500));
}

export function skjulMelding() {
  document.getElementById('melding').classList.remove('vis');
}
