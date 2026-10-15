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
  EmailAuthProvider, browserLocalPersistence, createUserWithEmailAndPassword, deleteUser,
  indexedDBLocalPersistence, initializeAuth, onAuthStateChanged, reauthenticateWithCredential,
  sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from '../vendor/firebase-12.19.0/firebase-auth.js';
import {
  Timestamp, collection, doc, getDocs, getFirestore, orderBy, query, serverTimestamp, where, writeBatch,
} from '../vendor/firebase-12.19.0/firebase-firestore-lite.js';

const KONFIGURASJON = {
  apiKey: 'AIzaSyDDk5gNwDk1HxfdD1cIqJHOlB61m1jvCLc',
  authDomain: 'lobsterapp-aee59.firebaseapp.com',
  projectId: 'lobsterapp-aee59',
  storageBucket: 'lobsterapp-aee59.firebasestorage.app',
  messagingSenderId: '801357882517',
  appId: '1:801357882517:web:c8fc1e55f13257b666a79c',
};

const BATCH = 400; // Firestore tillater maks 500 skrivinger per batch

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

  async opprett(epost, passord) {
    koble();
    await createUserWithEmailAndPassword(auth, epost, passord);
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

/**
 * Markeringene i skyen: brukere/{uid}/markeringer/{id}, ett dokument per markering.
 * Serveren setter «oppdatert» ved hver skriving, så vi kan hente bare det som er endret.
 */
export class FirestoreTjeneste {
  _samling(uid) {
    koble();
    return collection(db, 'brukere', uid, 'markeringer');
  }

  /** Dokumenter endret etter etterMs (millisekunder), eller alle. → [{ id, data, oppdatertMs }] */
  async hentEndringer(uid, etterMs = null) {
    const samling = this._samling(uid);
    const sporring = etterMs == null
      ? query(samling, orderBy('oppdatert'))
      : query(samling, where('oppdatert', '>', Timestamp.fromMillis(etterMs)), orderBy('oppdatert'));
    const svar = await getDocs(sporring);
    return svar.docs.map((d) => {
      const { oppdatert, ...data } = d.data();
      return { id: d.id, data, oppdatertMs: oppdatert?.toMillis?.() ?? null };
    });
  }

  /** Skriv dokumentene ({ id, data }), med «oppdatert» satt av serveren. */
  async lagre(uid, dokumenter) {
    const samling = this._samling(uid);
    for (let i = 0; i < dokumenter.length; i += BATCH) {
      const batch = writeBatch(db);
      for (const { id, data } of dokumenter.slice(i, i + BATCH)) {
        batch.set(doc(samling, id), { ...data, oppdatert: serverTimestamp() });
      }
      await batch.commit();
    }
  }

  /** Slett alle markeringene til brukeren (når kontoen slettes). */
  async slettAlle(uid) {
    const samling = this._samling(uid);
    const alle = (await getDocs(samling)).docs;
    for (let i = 0; i < alle.length; i += BATCH) {
      const batch = writeBatch(db);
      for (const d of alle.slice(i, i + BATCH)) batch.delete(d.ref);
      await batch.commit();
    }
  }
}
