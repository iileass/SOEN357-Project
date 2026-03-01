import { db } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp }
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

document.getElementById("addTask").addEventListener("click", async () => {
  try {
    await addDoc(collection(db, "tasks"), {
      title: "Test Task",
      status: "todo",
      createdAt: serverTimestamp()
    });
    alert("Task added!");
  } catch (e) {
    console.error("Error adding task:", e);
  }
});