    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
    import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
    // TODO: Add SDKs for Firebase products that you want to use
    // https://firebase.google.com/docs/web/setup#available-libraries

    // Your web app's Firebase configuration
    // For Firebase JS SDK v7.20.0 and later, measurementId is optional
    const firebaseConfig = {
      apiKey: "AIzaSyAPakLfnuN-jZFFHwKkExakKJrzy6sDEfc",
      authDomain: "soen357-project.firebaseapp.com",
      projectId: "soen357-project",
      storageBucket: "soen357-project.firebasestorage.app",
      messagingSenderId: "971802650019",
      appId: "1:971802650019:web:fe634a09d085eeb0772616",
      measurementId: "G-QDKDZ21CLE"
    };

    // Initialize Firebase
    const app = initializeApp(firebaseConfig);
    export const db = getFirestore(app);