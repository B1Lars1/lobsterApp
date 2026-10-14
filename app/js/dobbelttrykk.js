/*
 * Dobbelttrykk med fingeren zoomer kartet inn ett nivå rundt stedet du trykket.
 *
 * Leaflet gjør dette selv med mus (dobbeltklikk), men på iPhone kommer dobbelttrykket
 * aldri fram til Leaflet. Derfor oppdager vi to raske trykk på samme sted selv.
 * Det andre trykket stoppes (preventDefault), så Leaflet ikke zoomer en gang til på
 * telefoner der dobbelttrykket kommer fram (Android).
 */

const MAKS_MELLOM_MS = 300; // tid fra første til andre trykk
const MAKS_TRYKK_MS = 250;  // lengre enn dette er et langt trykk (marker sted), ikke et trykk
const MAKS_FLYTT_PX = 10;   // fingeren flyttet seg mer: det var et dra, ikke et trykk
const MAKS_AVSTAND_PX = 40; // så langt fra hverandre kan de to trykkene være

// Trykk på symboler og knapper i kartet skal ikke zoome
const erSymbolEllerKnapp = (el) => Boolean(el.closest('.leaflet-marker-icon, .leaflet-control'));

export function dobbelttrykkForZoom(kart) {
  const el = kart.getContainer();
  let start = null;   // fingeren som er nede nå: { x, y, tid }
  let forrige = null; // forrige trykk, som kan bli første halvdel av et dobbelttrykk

  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, tid: Date.now() } : null;
    if (!start) forrige = null; // to fingre: knipe-zoom, ikke trykk
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const naa = Date.now();
    const varTrykk = start && e.touches.length === 0 && !erSymbolEllerKnapp(e.target)
      && naa - start.tid <= MAKS_TRYKK_MS
      && Math.hypot(t.clientX - start.x, t.clientY - start.y) <= MAKS_FLYTT_PX;
    start = null;
    if (!varTrykk) {
      forrige = null;
      return;
    }
    const andreTrykk = forrige && naa - forrige.tid <= MAKS_MELLOM_MS
      && Math.hypot(t.clientX - forrige.x, t.clientY - forrige.y) <= MAKS_AVSTAND_PX;
    if (!andreTrykk) {
      forrige = { x: t.clientX, y: t.clientY, tid: naa };
      return;
    }
    e.preventDefault();
    forrige = null;
    kart.setZoomAround(kart.mouseEventToContainerPoint(t), kart.getZoom() + 1);
  }, { passive: false });
}
