/*
 * Korte meldinger øverst på skjermen, eventuelt med en knapp (f.eks. «Angre»).
 */

let timer;

/**
 * @param {string} tekst
 * @param {{knapp?: string, handling?: () => void, ms?: number, fare?: boolean}} [valg]
 *   fare: vis meldingen rødt (advarsel)
 */
export function visMelding(tekst, { knapp, handling, ms, fare = false } = {}) {
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
  boks.classList.toggle('fare', fare);
  clearTimeout(timer);
  timer = setTimeout(skjulMelding, ms ?? (knapp ? 6000 : 2500));
}

export function skjulMelding() {
  document.getElementById('melding').classList.remove('vis');
}
