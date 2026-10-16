/*
 * Spørsmål før noe som er vanskelig å angre (koble til eller fra skyen, forlate laget,
 * fjerne et medlem, ta opp alle teinene, bytte konto), i appens eget ark i stedet for
 * nettleserens confirm(). Knappen sier hva som skjer («Koble fra skyen»), ikke bare «OK»,
 * og teksten kan ha en punktliste.
 *
 * All tekst settes med textContent: e-post og lagnavn kan komme fra andre i laget.
 * Arket åpnes oppå det som er åpent (showModal), og bare ett spørsmål vises om gangen:
 * kommer et nytt mens et er åpent, får det første svaret nei.
 */

let aktivt = null; // { svar, ja } for spørsmålet som vises
let koblet = false;

const ark = () => document.getElementById('ark-bekreft');

function kobleOpp() {
  if (koblet) return;
  koblet = true;
  const a = ark();
  a.addEventListener('click', (e) => {
    const handling = e.target.closest('[data-handling]')?.dataset.handling;
    if (handling === 'ja' && aktivt) aktivt.ja = true;
    if (handling || e.target === a) a.close(); // også trykk på bakgrunnen
  });
  // Lukket på hvilken som helst måte (knappene, trykk utenfor, dratt ned, Esc)
  a.addEventListener('close', () => {
    const svar = aktivt;
    aktivt = null;
    svar?.svar(svar.ja);
  });
}

function avsnitt(tag, tekst) {
  const el = document.createElement(tag);
  el.textContent = tekst;
  return el;
}

/**
 * Spør brukeren. Svarer true når hovedknappen trykkes, ellers false (Avbryt, trykk
 * utenfor eller arket dratt ned).
 * @param {object} sporsmal
 * @param {string} sporsmal.tittel  spørsmålet, f.eks. «Forlate laget «Båten vår»?»
 * @param {string[]} [sporsmal.tekst]    avsnitt før punktene
 * @param {string[]} [sporsmal.punkter]  punktliste
 * @param {string[]} [sporsmal.etter]    avsnitt etter punktene
 * @param {string} sporsmal.knapp  hovedknappen, f.eks. «Koble fra skyen»
 * @param {boolean} [sporsmal.fare]  rød hovedknapp (sletter eller fjerner noe)
 * @returns {Promise<boolean>}
 */
export function bekreft({ tittel, tekst = [], punkter = [], etter = [], knapp, fare = false }) {
  kobleOpp();
  const a = ark();
  if (aktivt) {
    aktivt.svar(false);
    aktivt = null;
  }
  a.querySelector('[data-tekst="tittel"]').textContent = tittel;
  const innhold = [...tekst.map((t) => avsnitt('p', t))];
  if (punkter.length) {
    const ul = document.createElement('ul');
    ul.append(...punkter.map((t) => avsnitt('li', t)));
    innhold.push(ul);
  }
  innhold.push(...etter.map((t) => avsnitt('p', t)));
  a.querySelector('[data-tekst="tekst"]').replaceChildren(...innhold);
  const ja = a.querySelector('[data-handling="ja"]');
  ja.textContent = knapp;
  ja.classList.toggle('fare-fylt', fare);
  return new Promise((svar) => {
    aktivt = { svar, ja: false };
    if (!a.open) a.showModal();
    a.scrollTop = 0;
  });
}
