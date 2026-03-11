// ─── Firebase Configuration ──────────────────────────────────
// Replace the values below with your Firebase project config.
// Find these at: Firebase Console → Project Settings → Your apps → Web app
//
// INSTRUCTIONS:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use an existing one)
// 3. Add a Web app (click </> icon)
// 4. Copy the firebaseConfig object and paste the values below
// 5. Enable Authentication → Sign-in method → Email/Password (and optionally Google)
// 6. Create Firestore Database → Start in production mode
// 7. Set Firestore security rules (see below)
//
// FIRESTORE SECURITY RULES (paste in Firebase Console → Firestore → Rules):
// ───────────────────────────────────────────────────────────────
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /users/{userId} {
//       allow read, write: if request.auth != null && request.auth.uid == userId;
//     }
//   }
// }
// ───────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut }
  from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc }
  from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyCuUvL-bT4nB1J4B7qcpgIhXamzT85JPCY",
  authDomain: "kidcash-52084.firebaseapp.com",
  projectId: "kidcash-52084",
  storageBucket: "kidcash-52084.firebasestorage.app",
  messagingSenderId: "505786658885",
  appId: "1:505786658885:web:e5b514ffb8d410f37eb32c"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

// Export everything the app needs
window.firebaseAuth = auth;
window.firebaseDb = db;
window.firebaseGoogleProvider = googleProvider;
window.fbOnAuthStateChanged = onAuthStateChanged;
window.fbSignInWithEmail = signInWithEmailAndPassword;
window.fbCreateAccount = createUserWithEmailAndPassword;
window.fbSignInWithGoogle = signInWithPopup;
window.fbSignOut = signOut;
window.fbDoc = doc;
window.fbGetDoc = getDoc;
window.fbSetDoc = setDoc;

// Signal to app.js that Firebase is ready
window.dispatchEvent(new Event('firebase-ready'));
