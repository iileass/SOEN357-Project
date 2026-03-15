import { db } from "./firebase-config.js";
import { requireAuth, getUserProfile, logout } from "./auth.js";
import {
  doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, orderBy, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── URL params ─────────────────────────────────────────────────────────────────
const params     = new URLSearchParams(window.location.search);
const PROJECT_ID = params.get("id");
const OWNER_UID  = params.get("owner");

// ── State ──────────────────────────────────────────────────────────────────────
let currentUser    = null;
let projectData    = null;
let foundMember    = null;   // user found during member lookup
let currentMsId    = null;   // milestone id for adding sub-tasks
let projectMembers = [];     // [{userId, name, surname, email}] — owner + added members

// ── Firestore path helpers ─────────────────────────────────────────────────────
const projRef      = ()     => doc(db, "users", OWNER_UID, "projects", PROJECT_ID);
const tasksCol     = ()     => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks");
const msCol        = ()     => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones");
const membersCol   = ()     => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "members");
const msTasksCol   = (msId) => collection(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks");
const msDocRef     = (msId) => doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId);

// ── Generic helpers ────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

function showToast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById("toastContainer").appendChild(t);
  setTimeout(() => t.remove(), 3000);
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

function deadlineClass(d) {
  if (!d) return "ok";
  const diff = (new Date(d) - new Date()) / 86400000;
  return diff < 0 ? "overdue" : diff < 7 ? "soon" : "ok";
}

function deadlineLabel(d) {
  if (!d) return "";
  const date = new Date(d);
  const diff = Math.ceil((date - new Date()) / 86400000);
  if (diff < 0)   return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due ${date.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;
}

function progressColor(p) {
  return p >= 100 ? "success" : p >= 50 ? "warning" : "";
}

function showErr(id, msg) { const e = document.getElementById(id); e.textContent = msg; e.style.display = "block"; }
function hideErr(id)      { const e = document.getElementById(id); if (e) e.style.display = "none"; }

// ── Progress recalculation ─────────────────────────────────────────────────────

// Recalculates a milestone's progress from its tasks and writes back to Firestore.
async function recalcMilestoneProgress(msId) {
  const snap  = await getDocs(msTasksCol(msId));
  const tasks = snap.docs.map(d => d.data());
  const pct   = tasks.length ? Math.round(tasks.filter(t => t.complete).length / tasks.length * 100) : 0;
  await updateDoc(msDocRef(msId), { progress: pct });
  return pct;
}

// Recalculates the project's overall progress from ALL tasks (project-level + milestone sub-tasks)
// and updates Firestore + the overview progress bar.
async function recalcProjectProgress() {
  // Project-level tasks
  const projTaskSnap = await getDocs(tasksCol());
  const projTasks    = projTaskSnap.docs.map(d => d.data());

  // Milestone sub-tasks (fetch each milestone's task collection)
  const msSnap = await getDocs(msCol());
  let msTasks  = [];
  for (const msDoc of msSnap.docs) {
    const msTaskSnap = await getDocs(msTasksCol(msDoc.id));
    msTasks = msTasks.concat(msTaskSnap.docs.map(d => d.data()));
  }

  const all = [...projTasks, ...msTasks];
  const pct = all.length ? Math.round(all.filter(t => t.complete).length / all.length * 100) : 0;

  await updateDoc(projRef(), { progress: pct });
  if (projectData) projectData.progress = pct;

  // Update overview bar inline (no full reload needed)
  document.getElementById("progressPct").textContent = `${pct}%`;
  const fill = document.getElementById("progressFill");
  fill.style.width = `${pct}%`;
  fill.className   = `progress-fill ${progressColor(pct)}`;
}

// ── Open-milestone state helpers ───────────────────────────────────────────────

// Returns a Set of milestone IDs whose task panels are currently expanded.
function getOpenMilestones() {
  const open = new Set();
  document.querySelectorAll(".milestone-subtasks.open").forEach(el => {
    open.add(el.id.replace("ms-tasks-", ""));
  });
  return open;
}

// Restores expanded state on the freshly-rendered milestone rows.
function restoreOpenMilestones(openSet) {
  openSet.forEach(msId => {
    const panel  = document.getElementById(`ms-tasks-${msId}`);
    const toggle = document.querySelector(`[data-ms-toggle="${msId}"]`);
    if (panel)  panel.classList.add("open");
    if (toggle) toggle.classList.add("open");
  });
}

// ── Member cache & assignee selects ───────────────────────────────────────────

// Rebuilds the assignee <select> options in both task modals from projectMembers.
function populateMemberSelects() {
  const unassigned = `<option value="">Unassigned</option>`;
  const options    = projectMembers.map(m =>
    `<option value="${m.userId}">${escHtml(`${m.name} ${m.surname}`)}</option>`
  ).join("");

  ["taskAssignee", "msTaskAssignee"].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = unassigned + options;
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  if (!PROJECT_ID || !OWNER_UID) { window.location.href = "/dashboard.html"; return; }

  currentUser = await requireAuth();

  const profile = await getUserProfile(currentUser.uid);
  if (profile) {
    const fullName = `${profile.name} ${profile.surname}`;
    document.getElementById("userName").textContent   = fullName;
    document.getElementById("userEmail").textContent  = profile.email;
    document.getElementById("userAvatar").textContent = initials(fullName);
  }

  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );
  document.querySelectorAll("[data-close]").forEach(btn =>
    btn.addEventListener("click", () => closeModal(btn.dataset.close))
  );
  document.querySelectorAll(".modal-overlay").forEach(overlay =>
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); })
  );

  document.getElementById("editProjectBtn").addEventListener("click",     openEditModal);
  document.getElementById("saveProjectBtn").addEventListener("click",     saveProject);
  document.getElementById("newTaskBtn").addEventListener("click",         openNewTaskModal);
  document.getElementById("createTaskBtn").onclick = createTask;
  document.getElementById("newMilestoneBtn").addEventListener("click",    openNewMilestoneModal);
  document.getElementById("createMilestoneBtn").addEventListener("click", createMilestone);
  document.getElementById("addMemberBtn").addEventListener("click",       openAddMemberModal);
  document.getElementById("lookupMemberBtn").addEventListener("click",    lookupMember);
  document.getElementById("confirmAddMemberBtn").addEventListener("click",addMember);
  document.getElementById("createMsTaskBtn").addEventListener("click",    createMilestoneTask);
  document.getElementById("memberEmail").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); lookupMember(); }
  });

  await loadProject();
  await loadMembers();   // must run before loadTasks so projectMembers cache is ready
  await loadTasks();
  await loadMilestones();
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b  => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `panel-${tab}`));
}

// ── Load Project ───────────────────────────────────────────────────────────────

async function loadProject() {
  const snap = await getDoc(projRef());
  if (!snap.exists()) { window.location.href = "/dashboard.html"; return; }
  projectData = { id: snap.id, ...snap.data() };

  document.getElementById("breadcrumbTitle").textContent    = projectData.title;
  document.getElementById("projectTitle").textContent       = projectData.title;
  document.getElementById("projectDesc").textContent        = projectData.description || "";
  document.getElementById("projectOverview").style.display  = "";

  const pct  = projectData.progress ?? 0;
  const fill = document.getElementById("progressFill");
  document.getElementById("progressPct").textContent = `${pct}%`;
  fill.style.width = `${pct}%`;
  fill.className   = `progress-fill ${progressColor(pct)}`;

  const dEl = document.getElementById("projectDueLabel");
  dEl.textContent = deadlineLabel(projectData.dueDate);
  dEl.className   = `deadline ${deadlineClass(projectData.dueDate)}`;
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

async function loadTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap  = await getDocs(query(tasksCol(), orderBy("createdAt")));
  const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("taskCount").textContent = tasks.length;
  const done = tasks.filter(t => t.complete).length;
  document.getElementById("statTasks").textContent = `${done}/${tasks.length}`;

  list.innerHTML = tasks.length
    ? tasks.map(t => taskRow(t)).join("")
    : emptyState("No tasks yet", "Add your first task to get started.", "task");

  attachTaskListeners();
}

function taskRow(t) {
  // Find assignee name from cache
  const assignee = t.assigneeId ? projectMembers.find(m => m.userId === t.assigneeId) : null;
  const assigneeHtml = assignee
    ? `<div class="avatar avatar-sm" style="flex-shrink:0;" title="Assigned to ${escHtml(`${assignee.name} ${assignee.surname}`)}">${initials(`${assignee.name} ${assignee.surname}`)}</div>`
    : `<button class="btn btn-ghost btn-sm" data-assign-task="${t.id}" title="Assign member" style="color:var(--text-secondary);padding:.2rem .4rem;">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
           <circle cx="12" cy="7" r="4"/>
           <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
         </svg>
       </button>`;

  return `
    <div class="item-row" data-task-id="${t.id}">
      <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-task="${t.id}"></div>
      <div class="item-body">
        <div class="item-title ${t.complete ? "done" : ""}">${escHtml(t.title)}</div>
        ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
      </div>
      ${assigneeHtml}
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
  document.querySelectorAll("[data-toggle-task]").forEach(el =>
    el.addEventListener("click", () => toggleTask(el.dataset.toggleTask))
  );
  document.querySelectorAll("[data-delete-task]").forEach(el =>
    el.addEventListener("click", () => deleteTask(el.dataset.deleteTask))
  );
  document.querySelectorAll("[data-assign-task]").forEach(el =>
    el.addEventListener("click", () => openAssignModal(el.dataset.assignTask))
  );
}

function openNewTaskModal() {
  document.getElementById("taskTitle").value = "";
  document.getElementById("taskDesc").value  = "";
  populateMemberSelects();
  document.getElementById("taskAssignee").value = "";
  hideErr("taskError");
  openModal("newTaskModal");
}

async function createTask() {
  const title      = document.getElementById("taskTitle").value.trim();
  const desc       = document.getElementById("taskDesc").value.trim();
  const assigneeId = document.getElementById("taskAssignee").value;
  if (!title) { showErr("taskError", "Task title is required."); return; }

  const assignee   = assigneeId ? projectMembers.find(m => m.userId === assigneeId) : null;
  const btn        = document.getElementById("createTaskBtn");
  btn.disabled = true;
  try {
    await addDoc(tasksCol(), {
      title,
      description:  desc || "",
      complete:     false,
      assigneeId:   assigneeId || null,
      assigneeName: assignee ? `${assignee.name} ${assignee.surname}` : null,
      createdAt:    serverTimestamp(),
    });
    closeModal("newTaskModal");
    showToast("Task added!");
    await recalcProjectProgress();
    await loadTasks();
  } catch(err) { showErr("taskError", "Failed to add task."); console.error(err); }
  finally { btn.disabled = false; }
}

async function toggleTask(taskId) {
  const ref  = doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, { complete: !snap.data().complete });
  await recalcProjectProgress();
  await loadTasks();
}

async function deleteTask(taskId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId));
  showToast("Task deleted.", "error");
  await recalcProjectProgress();
  await loadTasks();
}

// ── Inline assign (project tasks) ─────────────────────────────────────────────

// Opens the new-task modal pre-populated with assignee options, pointed at an existing task.
// Simpler UX than a separate modal: use a small floating dropdown.
let assignTargetId = null;

function openAssignModal(taskId) {
  if (!projectMembers.length) { showToast("No members to assign.", "error"); return; }
  assignTargetId = taskId;
  populateMemberSelects();
  document.getElementById("taskAssignee").value = "";
  hideErr("taskError");
  // Re-use the task modal but tweak title and hide other fields
  document.getElementById("taskModalTitle").textContent = "Assign Member";
  document.getElementById("taskTitle").closest(".form-group").style.display = "none";
  document.getElementById("taskDesc").closest(".form-group").style.display  = "none";
  document.getElementById("createTaskBtn").textContent = "Assign";
  document.getElementById("createTaskBtn").onclick = doAssignTask;
  openModal("newTaskModal");
}

async function doAssignTask() {
  const assigneeId = document.getElementById("taskAssignee").value;
  const assignee   = assigneeId ? projectMembers.find(m => m.userId === assigneeId) : null;
  const btn        = document.getElementById("createTaskBtn");
  btn.disabled = true;
  try {
    await updateDoc(
      doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", assignTargetId),
      {
        assigneeId:   assigneeId || null,
        assigneeName: assignee ? `${assignee.name} ${assignee.surname}` : null,
      }
    );
    closeModal("newTaskModal");
    showToast("Task assigned!");
    await loadTasks();
  } catch(err) { showToast("Failed to assign.", "error"); console.error(err); }
  finally {
    btn.disabled = false;
    // Reset modal state
    resetTaskModal();
    assignTargetId = null;
  }
}

function resetTaskModal() {
  document.getElementById("taskModalTitle").textContent = "New Task";
  document.getElementById("taskTitle").closest(".form-group").style.display = "";
  document.getElementById("taskDesc").closest(".form-group").style.display  = "";
  document.getElementById("createTaskBtn").textContent = "Add Task";
  document.getElementById("createTaskBtn").onclick = createTask; // single assignment — no stacking
}

// ── Milestones ─────────────────────────────────────────────────────────────────

// Pass forceOpen to guarantee certain milestones are open after a re-render
// (e.g. the one a task was just added to).
async function loadMilestones(forceOpen = null) {
  const openBefore = forceOpen ?? getOpenMilestones(); // capture BEFORE clearing DOM

  const list = document.getElementById("milestoneList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap       = await getDocs(query(msCol(), orderBy("createdAt")));
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

  restoreOpenMilestones(openBefore); // restore AFTER re-render
  attachMilestoneListeners();
}

function milestoneRow(ms, tasks) {
  const progress = ms.progress ?? 0;
  const dClass   = deadlineClass(ms.expectedEndDate);
  const dLabel   = deadlineLabel(ms.expectedEndDate);

  const taskRows = tasks.map(t => {
    const assignee = t.assigneeId ? projectMembers.find(m => m.userId === t.assigneeId) : null;
    const assigneeHtml = assignee
      ? `<div class="avatar avatar-sm" style="flex-shrink:0;" title="${escHtml(`${assignee.name} ${assignee.surname}`)}">${initials(`${assignee.name} ${assignee.surname}`)}</div>`
      : "";
    return `
      <div class="item-row" data-ms-task-id="${t.id}" data-ms-id="${ms.id}" style="background:var(--bg);">
        <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-ms-task="${t.id}" data-ms-id="${ms.id}"></div>
        <div class="item-body">
          <div class="item-title ${t.complete ? "done" : ""}">${escHtml(t.title)}</div>
          ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
        </div>
        ${assigneeHtml}
        <div class="item-actions">
          <button class="btn btn-ghost btn-sm" data-delete-ms-task="${t.id}" data-ms-id="${ms.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join("");

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
          ${tasks.filter(t => t.complete).length}/${tasks.length} tasks
        </span>
      </div>

      <div class="progress-wrap">
        <div class="progress-label">
          <span class="text-xs text-secondary">Progress</span>
          <span class="text-xs font-semibold">${progress}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${progressColor(progress)}" style="width:${progress}%"></div>
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
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add task
        </button>
      </div>

      <div class="milestone-subtasks" id="ms-tasks-${ms.id}">
        ${taskRows || `<p class="text-sm text-secondary" style="padding:.25rem 0;">No tasks yet.</p>`}
      </div>
    </div>`;
}

function attachMilestoneListeners() {
  document.querySelectorAll("[data-ms-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel  = document.getElementById(`ms-tasks-${btn.dataset.msToggle}`);
      const isOpen = panel.classList.toggle("open");
      btn.classList.toggle("open", isOpen);
    });
  });
  document.querySelectorAll("[data-delete-ms]").forEach(btn =>
    btn.addEventListener("click", () => deleteMilestone(btn.dataset.deleteMs))
  );
  document.querySelectorAll("[data-add-ms-task]").forEach(btn =>
    btn.addEventListener("click", () => openMsTaskModal(btn.dataset.addMsTask))
  );
  document.querySelectorAll("[data-toggle-ms-task]").forEach(el =>
    el.addEventListener("click", () => toggleMilestoneTask(el.dataset.msId, el.dataset.toggleMsTask))
  );
  document.querySelectorAll("[data-delete-ms-task]").forEach(btn =>
    btn.addEventListener("click", () => deleteMilestoneTask(btn.dataset.msId, btn.dataset.deleteMsTask))
  );
}

function openNewMilestoneModal() {
  ["msTitle", "msDesc", "msEndDate"].forEach(id => document.getElementById(id).value = "");
  hideErr("msError");
  openModal("newMilestoneModal");
}

async function createMilestone() {
  const title   = document.getElementById("msTitle").value.trim();
  const desc    = document.getElementById("msDesc").value.trim();
  const endDate = document.getElementById("msEndDate").value;
  if (!title) { showErr("msError", "Milestone title is required."); return; }

  const btn = document.getElementById("createMilestoneBtn");
  btn.disabled = true;
  try {
    await addDoc(msCol(), {
      title, description: desc || "",
      expectedEndDate: endDate || null,
      progress: 0,
      createdAt: serverTimestamp(),
    });
    closeModal("newMilestoneModal");
    showToast("Milestone added!");
    await loadMilestones();
  } catch(err) { showErr("msError", "Failed to add milestone."); console.error(err); }
  finally { btn.disabled = false; }
}

async function deleteMilestone(msId) {
  await deleteDoc(msDocRef(msId));
  showToast("Milestone deleted.", "error");
  await loadMilestones();
}

// ── Milestone tasks ────────────────────────────────────────────────────────────

function openMsTaskModal(msId) {
  currentMsId = msId;
  document.getElementById("msTaskTitle").value = "";
  document.getElementById("msTaskDesc").value  = "";
  populateMemberSelects();
  document.getElementById("msTaskAssignee").value = "";
  hideErr("msTaskError");
  openModal("msTaskModal");
}

async function createMilestoneTask() {
  const title      = document.getElementById("msTaskTitle").value.trim();
  const desc       = document.getElementById("msTaskDesc").value.trim();
  const assigneeId = document.getElementById("msTaskAssignee").value;
  if (!title)      { showErr("msTaskError", "Task title is required."); return; }
  if (!currentMsId) return;

  const assignee = assigneeId ? projectMembers.find(m => m.userId === assigneeId) : null;
  const btn      = document.getElementById("createMsTaskBtn");
  btn.disabled   = true;
  const msId     = currentMsId;

  try {
    await addDoc(msTasksCol(msId), {
      title, description: desc || "", complete: false,
      assigneeId:   assigneeId || null,
      assigneeName: assignee ? `${assignee.name} ${assignee.surname}` : null,
      createdAt:    serverTimestamp(),
    });
    closeModal("msTaskModal");
    showToast("Task added!");

    // Recalculate progress (milestone + overall) and reload, keeping this milestone open.
    await recalcMilestoneProgress(msId);
    await recalcProjectProgress();
    const openSet = getOpenMilestones();
    openSet.add(msId);          // keep the target milestone open
    await loadMilestones(openSet);
  } catch(err) { showErr("msTaskError", "Failed to add task."); console.error(err); }
  finally { btn.disabled = false; currentMsId = null; }
}

async function toggleMilestoneTask(msId, taskId) {
  const ref  = doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks", taskId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, { complete: !snap.data().complete });
  // Recalculate milestone + overall progress, then reload preserving open state.
  await recalcMilestoneProgress(msId);
  await recalcProjectProgress();
  await loadMilestones(); // getOpenMilestones() called inside will capture current DOM state
}

async function deleteMilestoneTask(msId, taskId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks", taskId));
  showToast("Task deleted.", "error");
  await recalcMilestoneProgress(msId);
  await recalcProjectProgress();
  await loadMilestones();
}

// ── Members ────────────────────────────────────────────────────────────────────

async function loadMembers() {
  const list = document.getElementById("membersList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap    = await getDocs(membersCol());
  const members = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const ownerProfile = await getUserProfile(OWNER_UID);
  const totalCount   = members.length + 1;

  document.getElementById("memberCount").textContent = totalCount;
  document.getElementById("statMembers").textContent = totalCount;

  // Rebuild projectMembers cache (owner first, then added members)
  projectMembers = [];
  if (ownerProfile) {
    projectMembers.push({
      userId:  OWNER_UID,
      name:    ownerProfile.name,
      surname: ownerProfile.surname,
      email:   ownerProfile.email,
    });
  }
  for (const m of members) {
    projectMembers.push({ userId: m.userId, name: m.name, surname: m.surname, email: m.email });
  }

  let html = ownerProfile
    ? memberRowHtml({ id: OWNER_UID, name: ownerProfile.name, surname: ownerProfile.surname, email: ownerProfile.email, isOwner: true })
    : "";
  for (const m of members) html += memberRowHtml(m);

  list.innerHTML = html || emptyState("No members yet", "Add team members by their email.", "member");
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
          <button class="btn btn-ghost btn-sm" data-remove-member="${m.id}" title="Remove" style="color:var(--danger)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>` : ""}
    </div>`;
}

function attachMemberListeners() {
  document.querySelectorAll("[data-remove-member]").forEach(btn =>
    btn.addEventListener("click", () => removeMember(btn.dataset.removeMember))
  );
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

  const lookupBtn = document.getElementById("lookupMemberBtn");
  lookupBtn.textContent = "Searching…";
  lookupBtn.disabled    = true;
  hideErr("memberError");
  document.getElementById("memberLookupResult").style.display    = "none";
  document.getElementById("confirmAddMemberBtn").style.display   = "none";

  try {
    const snap = await getDocs(query(collection(db, "users"), where("email", "==", email)));
    if (snap.empty) { showErr("memberError", "No Sync-Up account found with that email."); foundMember = null; return; }

    const userDoc = snap.docs[0];
    foundMember   = { uid: userDoc.id, ...userDoc.data() };

    if (foundMember.uid === currentUser.uid) {
      showErr("memberError", "You are already the project owner."); foundMember = null; return;
    }
    const existing = await getDocs(query(membersCol(), where("userId", "==", foundMember.uid)));
    if (!existing.empty) {
      showErr("memberError", "This person is already a member."); foundMember = null; return;
    }

    const fullName = `${foundMember.name} ${foundMember.surname}`;
    document.getElementById("memberPreviewName").textContent   = fullName;
    document.getElementById("memberPreviewEmail").textContent  = foundMember.email;
    document.getElementById("memberPreviewAvatar").textContent = initials(fullName);
    document.getElementById("memberLookupResult").style.display  = "";
    document.getElementById("confirmAddMemberBtn").style.display = "";
  } catch(err) { showErr("memberError", "Lookup failed. Please try again."); console.error(err); }
  finally { lookupBtn.textContent = "Look up"; lookupBtn.disabled = false; }
}

async function addMember() {
  if (!foundMember) return;
  const btn = document.getElementById("confirmAddMemberBtn");
  btn.disabled = true;
  try {
    await addDoc(membersCol(), {
      userId: foundMember.uid, email: foundMember.email,
      name: foundMember.name, surname: foundMember.surname, addedAt: serverTimestamp(),
    });
    await addDoc(
      collection(db, "users", foundMember.uid, "memberOf"),
      { ownerUid: OWNER_UID, projectId: PROJECT_ID, projectTitle: projectData?.title || "" }
    );
    closeModal("addMemberModal");
    showToast(`${foundMember.name} added to the project!`);
    foundMember = null;
    await loadMembers();
  } catch(err) { showErr("memberError", "Failed to add member."); console.error(err); }
  finally { btn.disabled = false; }
}

async function removeMember(docId) {
  await deleteDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "members", docId));
  showToast("Member removed.", "error");
  await loadMembers();
}

// ── Edit Project ───────────────────────────────────────────────────────────────

function openEditModal() {
  document.getElementById("editProjTitle").value = projectData.title || "";
  document.getElementById("editProjDesc").value  = projectData.description || "";
  document.getElementById("editProjDue").value   = projectData.dueDate || "";
  openModal("editProjectModal");
}

async function saveProject() {
  const title = document.getElementById("editProjTitle").value.trim();
  const desc  = document.getElementById("editProjDesc").value.trim();
  const due   = document.getElementById("editProjDue").value;
  if (!title) return;

  const btn = document.getElementById("saveProjectBtn");
  btn.disabled = true;
  try {
    await updateDoc(projRef(), { title, description: desc || "", dueDate: due || null });
    closeModal("editProjectModal");
    showToast("Project updated!");
    await loadProject();
  } catch(err) { showToast("Failed to save changes.", "error"); console.error(err); }
  finally { btn.disabled = false; }
}

// ── Empty state ────────────────────────────────────────────────────────────────

function emptyState(title, subtitle, type) {
  const icons = {
    task:      `<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>`,
    milestone: `<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>`,
    member:    `<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>`,
  };
  return `
    <div class="empty-state" style="grid-column:unset;">
      <div class="empty-state-icon">
        <svg viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[type] || ""}</svg>
      </div>
      <h3>${title}</h3>
      <p class="text-sm">${subtitle}</p>
    </div>`;
}

init();
