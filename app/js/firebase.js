/*
 * Firebase: innlogging (Authentication) og lagring i skyen (Firestore).
 *
 * Konfigurasjonen under er ikke hemmelig. Den sier bare hvilket Firebase-prosjekt appen
 * hører til. Hvem som kan lese og skrive hva, bestemmes av tilgangsreglene i
 * firestore.rules i roten av repoet (lagt inn i Firebase-konsollen).
 *
 * SDK-et ligger i vendor/ (se README der), så appen virker uten nett. Vi bruker
 * «lite»-utgaven av Firestore: appen har sin egen lagring på telefonen (lager.js).
 *
 * Resten av appen bruker bare de to klassene under (FirebaseInnlogging og
 * FirestoreTjeneste), så de kan byttes med enkle erstatninger når noe skal testes.
 */

import { initializeApp } from '../vendor/firebase-12.19.0/firebase-app.js';
import {
  EmailAuthProvider, browserLocalPersistence, deleteUser,
  indexedDBLocalPersistence, initializeAuth, onAuthStateChanged, reauthenticateWithCredential,
  sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from '../vendor/firebase-12.19.0/firebase-auth.js';
import {
  Timestamp, arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, getFirestore,
  limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from '../vendor/firebase-12.19.0/firebase-firestore-lite.js';

const KONFIGURASJON = {
  apiKey: 'AIzaSyDDk5gNwDk1HxfdD1cIqJHOlB61m1jvCLc',
  authDomain: 'lobsterapp-aee59.firebaseapp.com',
  projectId: 'lobsterapp-aee59',
  storageBucket: 'lobsterapp-aee59.firebasestorage.app',
  messagingSenderId: '801357882517',
  appId: '1:801357882517:web:c8fc1e55f13257b666a79c',
};

// Skrivinger per batch. Firestore tillater 500, men i et lag slår tilgangsreglene opp
// i lagdokumentet for hver skriving, og det er maks 20 slike oppslag per batch.
const BATCH = 400;
const BATCH_LAG = 15;

// Lagkoder: 8 tegn uten de som er lette å forveksle (0/O, 1/I/L)
const KODETEGN = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let app = null;
let auth = null;
let db = null;

// Koble til først når det trengs, så kartet ikke venter på Firebase.
function koble() {
  if (!app) {
    app = initializeApp(KONFIGURASJON);
    auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
    auth.languageCode = 'no'; // e-post om nytt passord kommer på norsk
    db = getFirestore(app);
  }
}

/** Innlogging med e-post og passord. Brukeren huskes på telefonen (IndexedDB). */
export class FirebaseInnlogging {
  /** Kall naar(bruker) nå og hver gang brukeren logger inn eller ut (bruker er null ute). */
  lytt(naar) {
    koble();
    return onAuthStateChanged(auth, (b) => naar(b ? { uid: b.uid, epost: b.email } : null));
  }

  async loggInn(epost, passord) {
    koble();
    await signInWithEmailAndPassword(auth, epost, passord);
  }

  async glemtPassord(epost) {
    koble();
    await sendPasswordResetEmail(auth, epost);
  }

  async loggUt() {
    koble();
    await signOut(auth);
  }

  /** Bekreft passordet på nytt. Firebase krever det før kontoen kan slettes. */
  async bekreftPassord(passord) {
    koble();
    const b = auth.currentUser;
    await reauthenticateWithCredential(b, EmailAuthProvider.credential(b.email, passord));
  }

  async slettBruker() {
    koble();
    await deleteUser(auth.currentUser);
  }
}

function nyKode() {
  const tall = crypto.getRandomValues(new Uint32Array(8));
  return [...tall].map((t) => KODETEGN[t % KODETEGN.length]).join('');
}

const lagFra = (d) => ({
  id: d.id, navn: d.data().navn, medlemmer: d.data().medlemmer, eposter: d.data().eposter ?? {},
  initialer: d.data().initialer ?? {},
});

/**
 * Markeringene i skyen, ett dokument per markering, i et «rom»:
 *   'bruker:{uid}'  brukerens egne: brukere/{uid}/markeringer/{id}
 *   'lag:{kode}'    et lag (felles logg): lag/{kode}/markeringer/{id}
 * Serveren setter «oppdatert» ved hver skriving, så vi kan hente bare det som er endret.
 *
 * Lagdokumentet lag/{kode} har { navn, medlemmer: [uid], eposter: { uid: e-post }, opprettet },
 * og initialer: { uid: «BL» } når noen har satt initialene sine. Koden er dokument-id-en og
 * fungerer som invitasjon (se firestore.rules).
 *
 * Kontoens valg ligger i brukere/{uid}: { sky: true/false, frakoblet, oppdatert }. sky er
 * om kontoen er koblet til skyen (ellers lagres alt bare på telefonen), og frakoblet er
 * «endret» på slettingene fra da den sist ble koblet fra (se sky.js).
 */
export class FirestoreTjeneste {
  _samling(rom) {
    koble();
    const [type, id] = rom.split(':');
    return type === 'lag' ? collection(db, 'lag', id, 'markeringer') : collection(db, 'brukere', id, 'markeringer');
  }

  /**
   * Dokumenter endret etter «etter», eller alle. Tidspunktene er [sekunder, nanosekunder],
   * nøyaktig slik serveren har dem (mikrosekunder). Millisekunder ville blitt rundet av, og
   * da ble det siste dokumentet hentet på nytt annenhver gang.
   * → [{ id, data, oppdatert: [sekunder, nanosekunder] | null }]
   */
  async hentEndringer(rom, etter = null) {
    const samling = this._samling(rom);
    const sporring = etter == null
      ? query(samling, orderBy('oppdatert'))
      : query(samling, where('oppdatert', '>', new Timestamp(etter[0], etter[1])), orderBy('oppdatert'));
    const svar = await getDocs(sporring);
    return svar.docs.map((d) => {
      const { oppdatert, ...data } = d.data();
      return { id: d.id, data, oppdatert: oppdatert ? [oppdatert.seconds, oppdatert.nanoseconds] : null };
    });
  }

  /** Skriv dokumentene ({ id, data }), med «oppdatert» satt av serveren. */
  async lagre(rom, dokumenter) {
    const samling = this._samling(rom);
    const storrelse = rom.startsWith('lag:') ? BATCH_LAG : BATCH;
    for (let i = 0; i < dokumenter.length; i += storrelse) {
      const batch = writeBatch(db);
      for (const { id, data } of dokumenter.slice(i, i + storrelse)) {
        batch.set(doc(samling, id), { ...data, oppdatert: serverTimestamp() });
      }
      await batch.commit();
    }
  }

  /** Har rommet minst én markering som ikke er slettet? */
  async harMarkeringer(rom) {
    const svar = await getDocs(query(this._samling(rom), where('slettet', '==', false), limit(1)));
    return !svar.empty;
  }

  /** Slett alle markeringene i rommet (når kontoen slettes, eller det siste medlemmet går). */
  async slettAlle(rom) {
    const samling = this._samling(rom);
    const storrelse = rom.startsWith('lag:') ? BATCH_LAG : BATCH;
    const alle = (await getDocs(samling)).docs;
    for (let i = 0; i < alle.length; i += storrelse) {
      const batch = writeBatch(db);
      for (const d of alle.slice(i, i + storrelse)) batch.delete(d.ref);
      await batch.commit();
    }
  }

  // ---------- Kontoens valg: koblet til skyen eller bare på telefonen ----------

  /** { sky, frakoblet } fra brukere/{uid}, eller null for kontoer fra før valget fantes. */
  async hentKonto(uid) {
    koble();
    const d = await getDoc(doc(db, 'brukere', uid));
    return d.exists() ? { sky: d.data().sky === true, frakoblet: d.data().frakoblet ?? null } : null;
  }

  /** Lagre { sky } og eventuelt { frakoblet }. Felt som ikke er med, beholdes. */
  async lagreKonto(uid, felt) {
    koble();
    await setDoc(doc(db, 'brukere', uid), { ...felt, oppdatert: serverTimestamp() }, { merge: true });
  }

  /** Slett valget (når kontoen slettes). */
  async slettKonto(uid) {
    koble();
    await deleteDoc(doc(db, 'brukere', uid));
  }

  // ---------- Lag ----------

  /** Laget brukeren er med i, eller null. */
  async finnLag(uid) {
    koble();
    const svar = await getDocs(query(collection(db, 'lag'), where('medlemmer', 'array-contains', uid), limit(1)));
    return svar.empty ? null : lagFra(svar.docs[0]);
  }

  /** Lag et nytt lag med brukeren som eneste medlem. Prøver ny kode hvis den er tatt. */
  async opprettLag(uid, epost, navn) {
    koble();
    for (let forsok = 0; forsok < 5; forsok++) {
      const kode = nyKode();
      try {
        await setDoc(doc(db, 'lag', kode), {
          navn, medlemmer: [uid], eposter: { [uid]: epost }, opprettet: serverTimestamp(),
        });
        return { id: kode, navn, medlemmer: [uid], eposter: { [uid]: epost } };
      } catch (feil) {
        if (feil?.code !== 'permission-denied') throw feil; // koden finnes fra før: prøv en ny
      }
    }
    throw new Error('Fant ingen ledig lagkode');
  }

  /** Bli med i laget med koden. Feil kode gir feilen 'not-found' eller 'permission-denied'. */
  async blimed(kode, uid, epost) {
    koble();
    const ref = doc(db, 'lag', kode);
    await updateDoc(ref, { medlemmer: arrayUnion(uid), [`eposter.${uid}`]: epost });
    return lagFra(await getDoc(ref));
  }

  async hentLag(kode) {
    koble();
    const d = await getDoc(doc(db, 'lag', kode));
    return d.exists() ? lagFra(d) : null;
  }

  /** Sett initialene dine i laget (null fjerner dem). Reglene tillater bare dine egne. */
  async settInitialer(kode, uid, initialer) {
    koble();
    await updateDoc(doc(db, 'lag', kode), { [`initialer.${uid}`]: initialer ?? deleteField() });
  }

  /** Fjern et medlem (også deg selv). Er det siste medlemmet, slettes laget og alt i det. */
  async fjernMedlem(kode, uid) {
    koble();
    const lag = await this.hentLag(kode);
    if (!lag) return;
    if (lag.medlemmer.length === 1 && lag.medlemmer[0] === uid) {
      await this.slettAlle(`lag:${kode}`);
      await deleteDoc(doc(db, 'lag', kode));
    } else {
      const endring = { medlemmer: arrayRemove(uid), [`eposter.${uid}`]: deleteField() };
      if (lag.initialer[uid]) endring[`initialer.${uid}`] = deleteField(); // ikke la initialene bli liggende
      await updateDoc(doc(db, 'lag', kode), endring);
    }
  }
}
