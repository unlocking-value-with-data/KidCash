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
//     // Public wishlists — anyone can read, only signed-in users can write/delete
//     match /public_wishlists/{token} {
//       allow read: if true;
//       allow write, delete: if request.auth != null;
//       // Claims subcollection — anyone with the share link can claim/contribute.
//       // Field validation prevents malformed data and caps contribution amounts.
//       match /claims/{itemId} {
//         allow read, delete: if true;
//         allow create, update: if
//           // claimedBy must be a short string if present
//           (!request.resource.data.keys().hasAll(['claimedBy']) ||
//            (request.resource.data.claimedBy is string &&
//             request.resource.data.claimedBy.size() <= 50)) &&
//           // claimedAt must be a number if present
//           (!request.resource.data.keys().hasAll(['claimedAt']) ||
//            request.resource.data.claimedAt is number) &&
//           // contributions must be a list if present (individual amounts validated client-side)
//           (!request.resource.data.keys().hasAll(['contributions']) ||
//            request.resource.data.contributions is list);
//       }
//     }
//   }
// }
// ───────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut, sendEmailVerification, sendPasswordResetEmail }
  from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs, updateDoc, arrayUnion }
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
window.fbSendEmailVerification = sendEmailVerification;
window.fbSendPasswordResetEmail = sendPasswordResetEmail;
window.fbDoc = doc;
window.fbGetDoc = getDoc;
window.fbSetDoc = setDoc;
window.fbDeleteDoc = deleteDoc;
window.fbCollection = collection;
window.fbGetDocs = getDocs;
window.fbUpdateDoc = updateDoc;
window.fbArrayUnion = arrayUnion;

// Signal to app.js that Firebase is ready
window.dispatchEvent(new Event('firebase-ready'));
