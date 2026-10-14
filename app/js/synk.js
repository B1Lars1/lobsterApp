/*
 * Synkronisering med et privat GitHub-repo: automatisk sikkerhetskopi, og deling
 * med andre som har tilgang til repoet.
 *
 * Markeringene lagres som én GeoJSON-fil (markeringer.geojson) i repoet. Hver
 * synkronisering:
 *   1. henter filen fra GitHub,
 *   2. slår den sammen med markeringene på telefonen (nyeste versjon av hver
 *      markering vinner, og slettinger følger med),
 *   3. lagrer resultatet tilbake til GitHub hvis noe er endret. Hver lagring blir
 *      en commit, så repoet har også full historikk.
 *
 * Synkroniseringen skjer når appen åpnes, kort tid etter hver endring, når
 * telefonen får nett igjen, og når du trykker «Synkroniser nå».
 *
 * Oppsettet (repo og tilgangsnøkkel) lagres bare på denne telefonen (localStorage).
 * Nøkkelen bør bare ha tilgang til det ene repoet (se README).
 */

import { visMelding } from './melding.js';

const API = 'https://api.github.com';
const NOKKEL = 'hummerkart.synk';
const FIL = 'markeringer.geojson';
const VENT_ETTER_ENDRING_MS = 10000;

export function hentSynkOppsett() {
  try {
    return JSON.parse(localStorage.getItem(NOKKEL) || '{}');
  } catch {
    return {};
  }
}

function lagreSynkOppsett(oppsett) {
  try {
    localStorage.setItem(NOKKEL, JSON.stringify(oppsett));
  } catch {
    // Uten localStorage kan ikke oppsettet huskes
  }
}

// GitHub sender og tar imot filinnhold som base64. Denne varianten tåler æ, ø og å.
function tilBase64(tekst) {
  let binar = '';
  for (const b of new TextEncoder().encode(tekst)) binar += String.fromCharCode(b);
  return btoa(binar);
}
function fraBase64(base64) {
  const binar = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binar, (c) => c.charCodeAt(0)));
}

class SynkFeil extends Error {
  constructor(melding, kreverHandling = false) {
    super(melding);
    this.kreverHandling = kreverHandling; // feil du må gjøre noe med (nøkkel, repo)
  }
}

async function feilFraSvar(svar) {
  if (svar.status === 401) return new SynkFeil('Tilgangsnøkkelen er feil eller utløpt.', true);
  if (svar.status === 403) {
    return new SynkFeil('Nøkkelen mangler skrivetilgang. Den trenger «Contents: Read and write».', true);
  }
  if (svar.status === 404) return new SynkFeil('Fant ikke repoet, eller nøkkelen har ikke tilgang til det.', true);
  return new SynkFeil(`GitHub svarte med feil ${svar.status}.`);
}

export class Synk {
  /**
   * @param {import('./markeringer.js').Markeringer} markeringer
   * @param {(status: {tilstand: string, tekst: string}) => void} naarStatus
   */
  constructor(markeringer, naarStatus) {
    this.markeringer = markeringer;
    this.naarStatus = naarStatus;
    this.pagar = false;
    this._timer = null;

    // Synkroniser kort tid etter at noe er endret (ikke for hver lille endring)
    markeringer.naarEndret(() => {
      if (!this.pagar && this.erSattOpp()) this.planlegg();
    });
    window.addEventListener('online', () => {
      if (this.erSattOpp()) this.planlegg(1000);
    });
  }

  erSattOpp() {
    const { repo, token } = hentSynkOppsett();
    return Boolean(repo && token);
  }

  /** Lagre repo og nøkkel. Tomme verdier kobler fra. */
  settOppsett({ repo, token }) {
    const gammelt = hentSynkOppsett();
    lagreSynkOppsett({ ...gammelt, repo: repo.trim(), token: token.trim(), feil: null });
  }

  kobleFra() {
    lagreSynkOppsett({});
    this.naarStatus({ tilstand: 'av', tekst: 'Ikke satt opp.' });
  }

  statusTekst() {
    if (!this.erSattOpp()) return { tilstand: 'av', tekst: 'Ikke satt opp.' };
    const { repo, sist, feil } = hentSynkOppsett();
    if (feil) return { tilstand: 'feil', tekst: `Feil: ${feil}` };
    if (!sist) return { tilstand: 'venter', tekst: `Koblet til ${repo}. Ikke synkronisert ennå.` };
    const tid = new Date(sist).toLocaleString('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return { tilstand: 'ok', tekst: `Synkronisert med ${repo} ${tid}.` };
  }

  planlegg(ms = VENT_ETTER_ENDRING_MS) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.synkroniser(), ms);
  }

  _foresporsel(sti, valg = {}, accept = 'application/vnd.github+json') {
    const { token } = hentSynkOppsett();
    return fetch(`${API}${sti}`, {
      ...valg,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  /**
   * Synkroniser nå. Med manuell: true vises resultatet som melding.
   * Returnerer resultatet fra sammenslåingen, eller null.
   */
  async synkroniser({ manuell = false } = {}) {
    if (this.pagar || !this.erSattOpp()) return null;
    if (!navigator.onLine) {
      this.naarStatus({ tilstand: 'venter', tekst: 'Uten nett. Synkroniserer når du får nett.' });
      return null;
    }
    clearTimeout(this._timer);
    this.pagar = true;
    this.naarStatus({ tilstand: 'pagar', tekst: 'Synkroniserer …' });
    const { repo } = hentSynkOppsett();
    const filSti = `/repos/${repo}/contents/${FIL}`;
    let resultat = null;
    try {
      for (let forsok = 1; ; forsok++) {
        // 1. Hent filen fra GitHub (finnes ikke første gang)
        const hentet = await this._foresporsel(filSti);
        let sha = null;
        let ekstern = null;
        if (hentet.ok) {
          const d = await hentet.json();
          sha = d.sha;
          if (d.content) {
            ekstern = fraBase64(d.content);
          } else {
            // Filer over 1 MB kommer ikke som base64. Hent selve filen i stedet.
            const raa = await this._foresporsel(filSti, {}, 'application/vnd.github.raw+json');
            if (!raa.ok) throw await feilFraSvar(raa);
            ekstern = await raa.text();
          }
        } else if (hentet.status === 404) {
          const repoSvar = await this._foresporsel(`/repos/${repo}`);
          if (!repoSvar.ok) throw await feilFraSvar(repoSvar);
        } else {
          throw await feilFraSvar(hentet);
        }

        // 2. Slå sammen med markeringene på telefonen
        if (ekstern) resultat = await this.markeringer.importer(JSON.parse(ekstern));
        const lokal = `${JSON.stringify(this.markeringer.tilSynkGeoJSON(), null, 1)}\n`;
        if (lokal === ekstern) break; // alt er likt

        // 3. Lagre til GitHub
        const sendt = await this._foresporsel(filSti, {
          method: 'PUT',
          body: JSON.stringify({
            message: `Synkronisering fra Hummerkart ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
            content: tilBase64(lokal),
            ...(sha ? { sha } : {}),
          }),
        });
        if (sendt.ok) break;
        // 409/422: noen andre lagret samtidig. Hent på nytt og prøv igjen.
        if ((sendt.status === 409 || sendt.status === 422) && forsok < 3) continue;
        throw await feilFraSvar(sendt);
      }
      lagreSynkOppsett({ ...hentSynkOppsett(), sist: new Date().toISOString(), feil: null });
      this.naarStatus(this.statusTekst());
      if (manuell) {
        const fraGitHub = resultat ? resultat.nye + resultat.oppdaterte + resultat.slettet : 0;
        visMelding(fraGitHub ? `Synkronisert: ${fraGitHub} endringer hentet fra GitHub` : 'Synkronisert');
      }
    } catch (feil) {
      const tekst = feil instanceof SynkFeil ? feil.message : 'Fikk ikke kontakt med GitHub.';
      if (feil instanceof SynkFeil && feil.kreverHandling) {
        lagreSynkOppsett({ ...hentSynkOppsett(), feil: tekst });
      }
      this.naarStatus({ tilstand: 'feil', tekst: `Feil: ${tekst}` });
      if (manuell || (feil instanceof SynkFeil && feil.kreverHandling)) {
        visMelding(`Synkronisering: ${tekst}`, { ms: 6000, fare: true });
      }
    } finally {
      this.pagar = false;
    }
    return resultat;
  }
}
