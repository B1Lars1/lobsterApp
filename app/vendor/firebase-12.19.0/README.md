# Firebase JS SDK 12.19.0

Hentet fra Googles CDN (`https://www.gstatic.com/firebasejs/12.19.0/`):

- `firebase-app.js`
- `firebase-auth.js` (innlogging)
- `firebase-firestore-lite.js` (databasen, «lite»-utgaven uten egen mellomlagring:
  appen har sin egen lagring i IndexedDB)

Eneste endring: i `firebase-auth.js` og `firebase-firestore-lite.js` er importen av
`https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js` byttet til
`./firebase-app.js`, så alt lastes fra appen og virker uten nett.

Lisens: Apache License 2.0, © Google LLC (se lisensmerknadene i filene).
