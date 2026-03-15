import { db, auth } from "./firebase-config.js";
import { requireAuth, getUserProfile, logout } from "./auth.js";
import {
  doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, orderBy, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── URL params ─────────────────────────────────────────────────────────────────
const params    = new URLSearchParams(window.location.search);
const PROJECT_ID = params.get("id");
const OWNER_UID  = params.get("owner");

// ── State ──────────────────────────────────────────────────────────────────────
let currentUser  = null;
let projectData  = null;
let foundMember  = null;         // user found during member lookup
let currentMsId  = null;         // milestone id for adding sub-tasks

// ── Helpers ───────────────────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

function showToast(msg, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function deadlineClass(dateStr) {
  if (!dateStr) return "ok";
  const diff = (new Date(dateStr) - new Date()) / 86400000;
  if (diff < 0)  return "overdue";
  if (diff < 7)  return "soon";
  return "ok";
}

function deadlineLabel(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const diff = Math.ceil((date - new Date()) / 86400000);
  if (diff < 0)   return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due ${date.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;
}

function progressColor(pct) {
  if (pct >= 100) return "success";
  if (pct >= 50)  return "warning";
  return "";
}

function showErr(id, msg) { const el=document.getElementById(id); el.textContent=msg; el.style.display="block"; }
function hideErr(id)      { const el=document.getElementById(id); if(el) el.style.display="none"; }

// Firestore path helpers
const projRef  = () => doc(db, "users", OWNER_UID, "projects", PROJECT_ID);
const tasksCol = () => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks");
const msCol    = () => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones");
const membersCol=() => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "members");
const msTasksCol=(msId) => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks");

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  if (!PROJECT_ID || !OWNER_UID) {
    window.location.href = "/dashboard.html"; return;
  }

  currentUser = await requireAuth();

  // Sidebar user info
  const profile = await getUserProfile(currentUser.uid);
  if (profile) {
    const fullName = `${profile.name} ${profile.surname}`;
    document.getElementById("userName").textContent   = fullName;
    document.getElementById("userEmail").textContent  = profile.email;
    document.getElementById("userAvatar").textContent = initials(fullName);
  }

  document.getElementById("logoutBtn").addEventListener("click", logout);

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Close modals
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });
  });

  // Button wiring
  document.getElementById("editProjectBtn").addEventListener("click", openEditModal);
  document.getElementById("saveProjectBtn").addEventListener("click", saveProject);
  document.getElementById("newTaskBtn").addEventListener("click",      openNewTaskModal);
  document.getElementById("createTaskBtn").addEventListener("click",   createTask);
  document.getElementById("newMilestoneBtn").addEventListener("click", openNewMilestoneModal);
  document.getElementById("createMilestoneBtn").addEventListener("click", createMilestone);
  document.getElementById("addMemberBtn").addEventListener("click",    openAddMemberModal);
  document.getElementById("lookupMemberBtn").addEventListener("click", lookupMember);
  document.getElementById("confirmAddMemberBtn").addEventListener("click", addMember);
  document.getElementById("createMsTaskBtn").addEventListener("click", createMilestoneTask);

  // Enter key on member email input triggers lookup
  document.getElementById("memberEmail").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); lookupMember(); }
  });

  await loadProject();
  await loadTasks();
  await loadMilestones();
  await loadMembers();
}

// ── Tab ────────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `panel-${tab}`));
}

// ── Load Project ───────────────────────────────────────────────────────────────

async function loadProject() {
  const snap = await getDoc(projRef());
  if (!snap.exists()) { window.location.href = "/dashboard.html"; return; }
  projectData = { id: snap.id, ...snap.data() };

  document.getElementById("breadcrumbTitle").textContent = projectData.title;
  document.getElementById("projectTitle").textContent    = projectData.title;
  document.getElementById("projectDesc").textContent     = projectData.description || "";
  document.getElementById("projectOverview").style.display = "";

  const progress = projectData.progress ?? 0;
  document.getElementById("progressPct").textContent = `${progress}%`;
  const fill = document.getElementById("progressFill");
  fill.style.width = `${progress}%`;
  fill.className = `progress-fill ${progressColor(progress)}`;

  const dLabel = deadlineLabel(projectData.dueDate);
  const dEl    = document.getElementById("projectDueLabel");
  dEl.textContent  = dLabel;
  dEl.className    = `deadline ${deadlineClass(projectData.dueDate)}`;
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

async function loadTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap = await getDocs(query(tasksCol(), orderBy("createdAt")));
  const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("taskCount").textContent = tasks.length;
  const done = tasks.filter(t => t.complete).length;
  document.getElementById("statTasks").textContent = `${done}/${tasks.length}`;

  if (tasks.length === 0) {
    list.innerHTML = emptyState("No tasks yet", "Add your first task to get started.", "task");
    return;
  }

  list.innerHTML = tasks.map(t => taskRow(t)).join("");
  attachTaskListeners();
}

function taskRow(t) {
  return `
    <div class="item-row" data-task-id="${t.id}">
      <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-task="${t.id}"></div>
      <div class="item-body">
        <div class="item-title ${t.complete ? "done" : ""}">${escHtml(t.title)}</div>
        ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost btn-sm" data-delete-task="${t.id}" title="Delete task">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>`;
}

function attachTaskListeners() {
  document.querySelectorAll("[data-toggle-task]").forEach(el => {
    el.addEventListener("click", () => toggleTask(el.dataset.toggleTask));
  });
  document.querySelectorAll("[data-delete-task]").forEach(el => {
    el.addEventListener("click", () => deleteTask(el.dataset.deleteTask));
  });
}

function openNewTaskModal() {
  document.getElementById("taskTitle").value = "";
  document.getElementById("taskDesc").value  = "";
  document.getElementById("taskModalTitle").textContent = "New Task";
  hideErr("taskError");
  openModal("newTaskModal");
}

async function createTask() {
  const title = document.getElementById("taskTitle").value.trim();
  const desc  = document.getElementById("taskDesc").value.trim();
  if (!title) { showErr("taskError", "Task title is required."); return; }

  const btn = document.getElementById("createTaskBtn");
  btn.disabled = true;
  try {
    await addDoc(tasksCol(), { title, description: desc || "", complete: false, createdAt: serverTimestamp() });
    closeModal("newTaskModal");
    showToast("Task added!");
    await loadTasks();
  } catch(err) { showErr("taskError", "Failed to add task."); console.error(err); }
  finally { btn.disabled = false; }
}

async function toggleTask(taskId) {
  const taskDocRef = doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId);
  const snap = await getDoc(taskDocRef);
  if (!snap.exists()) return;
  await updateDoc(taskDocRef, { complete: !snap.data().complete });
  await loadTasks();
}

async function deleteTask(taskId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId));
  showToast("Task deleted.", "error");
  await loadTasks();
}

// ── Milestones ─────────────────────────────────────────────────────────────────

async function loadMilestones() {
  const list = document.getElementById("milestoneList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap = await getDocs(query(msCol(), orderBy("createdAt")));
  const milestones = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("milestoneCount").textContent = milestones.length;
  document.getElementById("statMilestones").textContent = milestones.length;

  if (milestones.length === 0) {
    list.innerHTML = emptyState("No milestones yet", "Break your project into milestones to track phases.", "milestone");
    return;
  }

  list.innerHTML = "";
  for (const ms of milestones) {
    const msTasks = await getDocs(query(msTasksCol(ms.id), orderBy("createdAt")));
    const tasks   = msTasks.docs.map(d => ({ id: d.id, ...d.data() }));
    list.insertAdjacentHTML("beforeend", milestoneRow(ms, tasks));
  }
  attachMilestoneListeners();
}

function milestoneRow(ms, tasks) {
  const progress = ms.progress ?? 0;
  const dClass   = deadlineClass(ms.expectedEndDate);
  const dLabel   = deadlineLabel(ms.expectedEndDate);
  const pColor   = progressColor(progress);

  const taskRows = tasks.map(t => `
    <div class="item-row" data-ms-task-id="${t.id}" data-ms-id="${ms.id}" style="background:var(--bg);">
      <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-ms-task="${t.id}" data-ms-id="${ms.id}"></div>
      <div class="item-body">
        <div class="item-title ${t.complete ? "done" : ""}">${escHtml(t.title)}</div>
        ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost btn-sm" data-delete-ms-task="${t.id}" data-ms-id="${ms.id}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          </svg>
        </button>
      </div>
    </div>`).join("");

  return `
    <div class="milestone-row" data-ms-id="${ms.id}">
      <div class="milestone-row-header">
        <div class="milestone-row-title-area">
          <div class="milestone-row-title">${escHtml(ms.title)}</div>
          ${ms.description ? `<div class="milestone-row-desc">${escHtml(ms.description)}</div>` : ""}
        </div>
        <div class="milestone-actions">
          <button class="btn btn-ghost btn-sm" data-delete-ms="${ms.id}" title="Delete milestone">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="milestone-meta">
        ${dLabel ? `<span class="milestone-meta-item deadline ${dClass}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          ${dLabel}</span>` : ""}
        <span class="milestone-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 11 12 14 22 4"/>
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          ${tasks.filter(t=>t.complete).length}/${tasks.length} tasks
        </span>
      </div>

      <div class="progress-wrap">
        <div class="progress-label">
          <span class="text-xs text-secondary">Progress</span>
          <span class="text-xs font-semibold">${progress}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${pColor}" style="width:${progress}%"></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;">
        <button class="milestone-tasks-toggle" data-ms-toggle="${ms.id}">
          Tasks (${tasks.length})
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <button class="btn btn-ghost btn-sm" data-add-ms-task="${ms.id}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add task
        </button>
      </div>

      <div class="milestone-subtasks" id="ms-tasks-${ms.id}">
        ${taskRows || `<p class="text-sm text-secondary" style="padding:.25rem 0;">No tasks yet.</p>`}
      </div>
    </div>`;
}

function attachMilestoneListeners() {
  // Toggle subtasks visibility
  document.querySelectorAll("[data-ms-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const container = document.getElementById(`ms-tasks-${btn.dataset.msToggle}`);
      const isOpen = container.classList.toggle("open");
      btn.classList.toggle("open", isOpen);
    });
  });

  // Delete milestone
  document.querySelectorAll("[data-delete-ms]").forEach(btn => {
    btn.addEventListener("click", () => deleteMilestone(btn.dataset.deleteMs));
  });

  // Add sub-task
  document.querySelectorAll("[data-add-ms-task]").forEach(btn => {
    btn.addEventListener("click", () => openMsTaskModal(btn.dataset.addMsTask));
  });

  // Toggle sub-task
  document.querySelectorAll("[data-toggle-ms-task]").forEach(el => {
    el.addEventListener("click", () => toggleMilestoneTask(el.dataset.msId, el.dataset.toggleMsTask));
  });

  // Delete sub-task
  document.querySelectorAll("[data-delete-ms-task]").forEach(btn => {
    btn.addEventListener("click", () => deleteMilestoneTask(btn.dataset.msId, btn.dataset.deleteMsTask));
  });
}

function openNewMilestoneModal() {
  ["msTitle","msDesc","msEndDate"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("msProgress").value = "0";
  hideErr("msError");
  openModal("newMilestoneModal");
}

async function createMilestone() {
  const title    = document.getElementById("msTitle").value.trim();
  const desc     = document.getElementById("msDesc").value.trim();
  const endDate  = document.getElementById("msEndDate").value;
  const progress = parseInt(document.getElementById("msProgress").value) || 0;

  if (!title) { showErr("msError", "Milestone title is required."); return; }

  const btn = document.getElementById("createMilestoneBtn");
  btn.disabled = true;
  try {
    await addDoc(msCol(), {
      title, description: desc || "",
      expectedEndDate: endDate || null,
      progress: Math.min(100, Math.max(0, progress)),
      createdAt: serverTimestamp(),
    });
    closeModal("newMilestoneModal");
    showToast("Milestone added!");
    await loadMilestones();
  } catch(err) { showErr("msError", "Failed to add milestone."); console.error(err); }
  finally { btn.disabled = false; }
}

async function deleteMilestone(msId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId));
  showToast("Milestone deleted.", "error");
  await loadMilestones();
}

// Milestone Tasks
function openMsTaskModal(msId) {
  currentMsId = msId;
  document.getElementById("msTaskTitle").value = "";
  document.getElementById("msTaskDesc").value  = "";
  hideErr("msTaskError");
  openModal("msTaskModal");
}

async function createMilestoneTask() {
  const title = document.getElementById("msTaskTitle").value.trim();
  const desc  = document.getElementById("msTaskDesc").value.trim();
  if (!title) { showErr("msTaskError", "Task title is required."); return; }
  if (!currentMsId) return;

  const btn = document.getElementById("createMsTaskBtn");
  btn.disabled = true;
  try {
    await addDoc(msTasksCol(currentMsId), {
      title, description: desc || "", complete: false, createdAt: serverTimestamp(),
    });
    closeModal("msTaskModal");
    showToast("Task added!");
    await loadMilestones();
  } catch(err) { showErr("msTaskError", "Failed to add task."); console.error(err); }
  finally { btn.disabled = false; currentMsId = null; }
}

async function toggleMilestoneTask(msId, taskId) {
  const taskRef = doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks", taskId);
  const snap = await getDoc(taskRef);
  if (!snap.exists()) return;
  await updateDoc(taskRef, { complete: !snap.data().complete });
  await loadMilestones();
}

async function deleteMilestoneTask(msId, taskId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks", taskId));
  showToast("Task deleted.", "error");
  await loadMilestones();
}

// ── Members ─────────────────────────────────────────────────────────────────────

async function loadMembers() {
  const list = document.getElementById("membersList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap = await getDocs(membersCol());
  const members = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Always show the owner first
  const ownerProfile = await getUserProfile(OWNER_UID);
  const totalCount   = members.length + 1; // +1 for owner

  document.getElementById("memberCount").textContent = totalCount;
  document.getElementById("statMembers").textContent = totalCount;

  let html = "";

  if (ownerProfile) {
    const fullName = `${ownerProfile.name} ${ownerProfile.surname}`;
    html += memberRowHtml({
      id: OWNER_UID,
      name: ownerProfile.name,
      surname: ownerProfile.surname,
      email: ownerProfile.email,
      isOwner: true,
    });
  }

  for (const m of members) {
    html += memberRowHtml(m);
  }

  if (!html) {
    list.innerHTML = emptyState("No members yet", "Add team members by their email.", "member");
    return;
  }

  list.innerHTML = html;
  attachMemberListeners();
}

function memberRowHtml(m) {
  const fullName = `${m.name || ""} ${m.surname || ""}`.trim() || m.email;
  const isOwner  = m.isOwner || m.userId === OWNER_UID;
  return `
    <div class="member-row">
      <div class="avatar">${initials(fullName)}</div>
      <div class="member-info">
        <div class="member-name">${escHtml(fullName)}</div>
        <div class="member-email">${escHtml(m.email || "")}</div>
      </div>
      <span class="badge ${isOwner ? "badge-primary" : "badge-gray"}">${isOwner ? "Owner" : "Member"}</span>
      ${!isOwner ? `
        <div class="member-actions">
          <button class="btn btn-ghost btn-sm" data-remove-member="${m.id}" title="Remove member" style="color:var(--danger)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>` : ""}
    </div>`;
}

function attachMemberListeners() {
  document.querySelectorAll("[data-remove-member]").forEach(btn => {
    btn.addEventListener("click", () => removeMember(btn.dataset.removeMember));
  });
}

function openAddMemberModal() {
  document.getElementById("memberEmail").value = "";
  document.getElementById("memberLookupResult").style.display = "none";
  document.getElementById("confirmAddMemberBtn").style.display = "none";
  document.getElementById("lookupMemberBtn").style.display = "";
  hideErr("memberError");
  foundMember = null;
  openModal("addMemberModal");
}

async function lookupMember() {
  const email = document.getElementById("memberEmail").value.trim().toLowerCase();
  if (!email) { showErr("memberError", "Please enter an email address."); return; }

  document.getElementById("lookupMemberBtn").textContent = "Searching…";
  document.getElementById("lookupMemberBtn").disabled = true;
  hideErr("memberError");
  document.getElementById("memberLookupResult").style.display = "none";
  document.getElementById("confirmAddMemberBtn").style.display = "none";

  try {
    // Query users collection by email
    const q    = query(collection(db, "users"), where("email", "==", email));
    const snap = await getDocs(q);

    if (snap.empty) {
      showErr("memberError", "No Sync-Up account found with that email.");
      foundMember = null;
      return;
    }

    const userDoc = snap.docs[0];
    foundMember = { uid: userDoc.id, ...userDoc.data() };

    if (foundMember.uid === currentUser.uid) {
      showErr("memberError", "You are already the project owner.");
      foundMember = null;
      return;
    }

    // Check if already a member
    const existingSnap = await getDocs(
      query(membersCol(), where("userId", "==", foundMember.uid))
    );
    if (!existingSnap.empty) {
      showErr("memberError", "This person is already a member of this project.");
      foundMember = null;
      return;
    }

    const fullName = `${foundMember.name} ${foundMember.surname}`;
    document.getElementById("memberPreviewName").textContent  = fullName;
    document.getElementById("memberPreviewEmail").textContent = foundMember.email;
    document.getElementById("memberPreviewAvatar").textContent = initials(fullName);
    document.getElementById("memberLookupResult").style.display = "";
    document.getElementById("confirmAddMemberBtn").style.display = "";

  } catch(err) {
    showErr("memberError", "Lookup failed. Please try again.");
    console.error(err);
  } finally {
    document.getElementById("lookupMemberBtn").textContent = "Look up";
    document.getElementById("lookupMemberBtn").disabled = false;
  }
}

async function addMember() {
  if (!foundMember) return;

  const btn = document.getElementById("confirmAddMemberBtn");
  btn.disabled = true;
  try {
    await addDoc(membersCol(), {
      userId:  foundMember.uid,
      email:   foundMember.email,
      name:    foundMember.name,
      surname: foundMember.surname,
      addedAt: serverTimestamp(),
    });

    // Also write a back-reference on the member's user doc so they can find this project
    await addDoc(
      collection(db, "users", foundMember.uid, "memberOf"),
      { ownerUid: OWNER_UID, projectId: PROJECT_ID, projectTitle: projectData?.title || "" }
    );

    closeModal("addMemberModal");
    showToast(`${foundMember.name} added to the project!`);
    foundMember = null;
    await loadMembers();
  } catch(err) {
    showErr("memberError", "Failed to add member.");
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function removeMember(docId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "members", docId));
  showToast("Member removed.", "error");
  await loadMembers();
}

// ── Edit Project ───────────────────────────────────────────────────────────────

function openEditModal() {
  document.getElementById("editProjTitle").value    = projectData.title || "";
  document.getElementById("editProjDesc").value     = projectData.description || "";
  document.getElementById("editProjDue").value      = projectData.dueDate || "";
  document.getElementById("editProjProgress").value = projectData.progress ?? 0;
  openModal("editProjectModal");
}

async function saveProject() {
  const title    = document.getElementById("editProjTitle").value.trim();
  const desc     = document.getElementById("editProjDesc").value.trim();
  const due      = document.getElementById("editProjDue").value;
  const progress = Math.min(100, Math.max(0, parseInt(document.getElementById("editProjProgress").value) || 0));

  if (!title) return;

  const btn = document.getElementById("saveProjectBtn");
  btn.disabled = true;
  try {
    await updateDoc(projRef(), { title, description: desc || "", dueDate: due || null, progress });
    closeModal("editProjectModal");
    showToast("Project updated!");
    await loadProject();
  } catch(err) { showToast("Failed to save changes.", "error"); console.error(err); }
  finally { btn.disabled = false; }
}

// ── Empty State Helper ─────────────────────────────────────────────────────────

function emptyState(title, subtitle, type) {
  const icons = {
    task: `<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>`,
    milestone: `<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>`,
    member: `<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>`,
  };
  return `
    <div class="empty-state" style="grid-column:unset;">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          ${icons[type] || ""}
        </svg>
      </div>
      <h3>${title}</h3>
      <p class="text-sm">${subtitle}</p>
    </div>`;
}

init();
