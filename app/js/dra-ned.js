/*
 * «Dra ned for å lukke» for arkene (dialog.ark) som kommer opp nedenfra.
 *
 * - På telefonen: dra nedover i håndtaket øverst, eller hvor som helst i arket når
 *   innholdet er scrollet helt opp. Scrolling inni arket virker som vanlig.
 * - På PC: dra i håndtaket med musa.
 * Drar du langt nok, eller sveiper raskt nedover, lukkes arket. Ellers spretter det tilbake.
 */

const LUKK_ETTER_PX = 90;   // så langt må arket dras for å lukkes
const LUKK_VED_FART = 0.6;  // eller så raskt (piksler per millisekund)
const START_ETTER_PX = 6;   // bevegelse før vi bestemmer om det er dra eller scroll

// Felt der fingeren skal kunne velge tekst osv., ikke dra arket
const erFelt = (el) => Boolean(el.closest('input, textarea, select'));

export function draNedForALukke(ark) {
  let startY = null;
  let sisteY = 0;
  let sisteTid = 0;
  let fart = 0;
  let drar = false;
  let fraHandtak = false; // håndtaket kan alltid dras, uansett hvor langt arket er scrollet

  function start(y, iHandtak) {
    fraHandtak = iHandtak;
    startY = y;
    sisteY = y;
    sisteTid = performance.now();
    fart = 0;
    drar = false;
  }

  // Returnerer true hvis bevegelsen drar arket (og skal ikke scrolle innholdet).
  function flytt(y) {
    if (startY === null) return false;
    const dy = y - startY;
    if (!drar) {
      const oeverst = fraHandtak || ark.scrollTop <= 0;
      if (dy > START_ETTER_PX && oeverst) {
        drar = true;
        ark.classList.add('drar');
      } else if (dy < -START_ETTER_PX || !oeverst) {
        startY = null; // vanlig scrolling i arket
        return false;
      } else {
        return false;
      }
    }
    const naa = performance.now();
    fart = (y - sisteY) / Math.max(naa - sisteTid, 1);
    sisteY = y;
    sisteTid = naa;
    ark.style.transform = `translateY(${Math.max(0, dy)}px)`;
    return true;
  }

  function slutt() {
    if (startY === null) return;
    const dy = sisteY - startY;
    startY = null;
    if (!drar) return;
    drar = false;
    ark.classList.remove('drar'); // slå på animasjonen igjen
    if (dy > LUKK_ETTER_PX || fart > LUKK_VED_FART) {
      ark.style.transform = 'translateY(100%)';
      setTimeout(() => {
        ark.close();
        ark.style.transform = '';
      }, 180);
    } else {
      ark.style.transform = ''; // sprett tilbake
    }
  }

  // Berøring (telefon)
  ark.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && !erFelt(e.target)) {
      start(e.touches[0].clientY, Boolean(e.target.closest('.handtak')));
    }
  }, { passive: true });
  ark.addEventListener('touchmove', (e) => {
    if (flytt(e.touches[0].clientY)) e.preventDefault(); // hindre at siden scroller/spretter
  }, { passive: false });
  ark.addEventListener('touchend', slutt);
  ark.addEventListener('touchcancel', slutt);

  // Mus (PC): bare i håndtaket
  const handtak = ark.querySelector('.handtak');
  handtak?.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    e.preventDefault();
    start(e.clientY, true);
    const ved = (m) => flytt(m.clientY);
    const opp = () => {
      window.removeEventListener('pointermove', ved);
      window.removeEventListener('pointerup', opp);
      slutt();
    };
    window.addEventListener('pointermove', ved);
    window.addEventListener('pointerup', opp);
  });
}
