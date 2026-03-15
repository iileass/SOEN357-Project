import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAPakLfnuN-jZFFHwKkExakKJrzy6sDEfc",
  authDomain: "soen357-project.firebaseapp.com",
  projectId: "soen357-project",
  storageBucket: "soen357-project.firebasestorage.app",
  messagingSenderId: "971802650019",
  appId: "1:971802650019:web:fe634a09d085eeb0772616",
  measurementId: "G-QDKDZ21CLE"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
