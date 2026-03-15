import { db } from "./firebase-config.js";
import { requireAuth, getUserProfile, logout } from "./auth.js";
import {
  doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, orderBy, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── URL params ─────────────────────────────────────────────────────────────────
const params         = new URLSearchParams(window.location.search);
const PROJECT_ID     = params.get("id");
const OWNER_UID      = params.get("owner");
const PROJECT_COLOR  = decodeURIComponent(params.get("color") || "%235B6AF5");

// ── State ──────────────────────────────────────────────────────────────────────
let currentUser    = null;
let projectData    = null;
let foundMember    = null;   // user found during member lookup
let currentMsId    = null;   // milestone id for adding sub-tasks
let projectMembers = [];     // [{userId, name, surname, email}] — owner + added members
let assignTargetId = null;
let editTargetTaskId = null;
let editTargetMsId   = null;

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

function parseDate(d) {
  if (!d) return null;
  // Append time to force local-timezone parsing (avoid UTC midnight off-by-one)
  return new Date(d + "T00:00:00");
}

function deadlineClass(d) {
  if (!d) return "ok";
  const diff = (parseDate(d) - new Date()) / 86400000;
  return diff < 0 ? "overdue" : diff < 7 ? "soon" : "ok";
}

function deadlineLabel(d) {
  if (!d) return "";
  const date = parseDate(d);
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

async function recalcMilestoneProgress(msId) {
  const snap  = await getDocs(msTasksCol(msId));
  const tasks = snap.docs.map(d => d.data());
  const pct   = tasks.length ? Math.round(tasks.filter(t => t.complete).length / tasks.length * 100) : 0;
  await updateDoc(msDocRef(msId), { progress: pct });
  return pct;
}

async function recalcProjectProgress() {
  const projTaskSnap = await getDocs(tasksCol());
  const projTasks    = projTaskSnap.docs.map(d => d.data());

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

  document.getElementById("progressPct").textContent = `${pct}%`;
  const fill = document.getElementById("progressFill");
  fill.style.width = `${pct}%`;
  fill.className   = `progress-fill ${progressColor(pct)}`;
}

// ── Open-milestone state helpers ───────────────────────────────────────────────

function getOpenMilestones() {
  const open = new Set();
  document.querySelectorAll(".milestone-subtasks.open").forEach(el => {
    open.add(el.id.replace("ms-tasks-", ""));
  });
  return open;
}

function restoreOpenMilestones(openSet) {
  openSet.forEach(msId => {
    const panel  = document.getElementById(`ms-tasks-${msId}`);
    const toggle = document.querySelector(`[data-ms-toggle="${msId}"]`);
    if (panel)  panel.classList.add("open");
    if (toggle) toggle.classList.add("open");
  });
}

// ── Member cache & assignee checklists ────────────────────────────────────────

function populateMemberChecklists(selectedIds = []) {
  const html = projectMembers.length
    ? projectMembers.map(m => `
        <label class="assignee-check-row">
          <input type="checkbox" value="${m.userId}" ${selectedIds.includes(m.userId) ? "checked" : ""}>
          <div class="avatar avatar-sm">${initials(`${m.name} ${m.surname}`)}</div>
          <span>${escHtml(`${m.name} ${m.surname}`)}</span>
        </label>`).join("")
    : `<p class="assignee-checklist-empty">No members yet — add members first.</p>`;

  ["taskAssigneeList", "msTaskAssigneeList"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function getCheckedAssignees(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`))
    .map(cb => cb.value);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  if (!PROJECT_ID || !OWNER_UID) { window.location.href = "/dashboard.html"; return; }

  // Apply project accent color early
  document.documentElement.style.setProperty("--primary", PROJECT_COLOR);

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

  document.getElementById("saveTaskBtn").addEventListener("click", saveTask);
  document.getElementById("saveMilestoneBtn").addEventListener("click", saveMilestone);

  await loadProject();
  initTimelineControls();
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
  // Support both old single assigneeId and new array
  const assigneeIds = t.assigneeIds || (t.assigneeId ? [t.assigneeId] : []);
  const assignees   = assigneeIds.map(id => projectMembers.find(m => m.userId === id)).filter(Boolean);

  const maxShow = 3;
  const shown   = assignees.slice(0, maxShow);
  const extra   = assignees.length - maxShow;
  const avatarsHtml = shown.map(a =>
    `<div class="tooltip-wrap avatar avatar-sm" data-tooltip="${escHtml(`${a.name} ${a.surname}`)}">${initials(`${a.name} ${a.surname}`)}</div>`
  ).join("") + (extra > 0 ? `<div class="avatar avatar-sm" style="background:var(--border);color:var(--text-secondary);font-size:.65rem;">+${extra}</div>` : "");

  return `
    <div class="item-row" data-task-id="${t.id}">
      <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-task="${t.id}"></div>
      <div class="item-body" data-expand-task="${t.id}">
        <div style="display:flex;align-items:center;gap:.5rem;">
          <div class="item-title ${t.complete ? "done" : ""}" style="flex:1;min-width:0;">${escHtml(t.title)}</div>
          <div style="display:flex;gap:.2rem;align-items:center;">${avatarsHtml}</div>
          <svg class="item-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
        <div class="item-actions">
          <button class="btn btn-ghost btn-sm" data-assign-task="${t.id}" title="Assign members">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
            Assign
          </button>
          <button class="btn btn-ghost btn-sm" data-edit-task="${t.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="btn btn-ghost btn-sm" data-delete-task="${t.id}" style="color:var(--danger);">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
            Delete
          </button>
        </div>
      </div>
    </div>`;
}

function attachTaskListeners() {
  document.querySelectorAll("[data-expand-task]").forEach(el =>
    el.addEventListener("click", () => el.closest(".item-row").classList.toggle("expanded"))
  );
  document.querySelectorAll("[data-edit-task]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); openEditTaskModal(el.dataset.editTask); })
  );
  document.querySelectorAll("[data-toggle-task]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleTask(el.dataset.toggleTask); })
  );
  document.querySelectorAll("[data-delete-task]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); deleteTask(el.dataset.deleteTask); })
  );
  document.querySelectorAll("[data-assign-task]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); openAssignModal(el.dataset.assignTask); })
  );
}

function openNewTaskModal() {
  document.getElementById("taskTitle").value = "";
  document.getElementById("taskDesc").value  = "";
  populateMemberChecklists();
  hideErr("taskError");
  openModal("newTaskModal");
}

async function createTask() {
  const title = document.getElementById("taskTitle").value.trim();
  const desc  = document.getElementById("taskDesc").value.trim();
  if (!title) { showErr("taskError", "Task title is required."); return; }

  const assigneeIds = getCheckedAssignees("taskAssigneeList");
  const assignees   = assigneeIds.map(id => projectMembers.find(m => m.userId === id)).filter(Boolean);
  const btn        = document.getElementById("createTaskBtn");
  btn.disabled = true;
  try {
    await addDoc(tasksCol(), {
      title,
      description:  desc || "",
      complete:     false,
      assigneeIds,
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

async function openAssignModal(taskId) {
  if (!projectMembers.length) { showToast("No members to assign.", "error"); return; }
  assignTargetId = taskId;
  // Fetch current assignees to pre-check them
  let currentAssigneeIds = [];
  try {
    const taskSnap = await getDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId));
    if (taskSnap.exists()) {
      const d = taskSnap.data();
      currentAssigneeIds = d.assigneeIds || (d.assigneeId ? [d.assigneeId] : []);
    }
  } catch(e) {}
  populateMemberChecklists(currentAssigneeIds);
  document.getElementById("taskModalTitle").textContent = "Assign Members";
  document.getElementById("taskTitle").closest(".form-group").style.display = "none";
  document.getElementById("taskDesc").closest(".form-group").style.display  = "none";
  document.getElementById("createTaskBtn").textContent = "Assign";
  document.getElementById("createTaskBtn").onclick = doAssignTask;
  openModal("newTaskModal");
}

async function doAssignTask() {
  const assigneeIds = getCheckedAssignees("taskAssigneeList");
  const assignees   = assigneeIds.map(id => projectMembers.find(m => m.userId === id)).filter(Boolean);
  const btn = document.getElementById("createTaskBtn");
  btn.disabled = true;
  try {
    await updateDoc(
      doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", assignTargetId),
      { assigneeIds, assigneeId: null, assigneeName: null }
    );
    closeModal("newTaskModal");
    showToast("Task assigned!");
    await loadTasks();
  } catch(err) { showToast("Failed to assign.", "error"); console.error(err); }
  finally {
    btn.disabled = false;
    resetTaskModal();
    assignTargetId = null;
  }
}

function resetTaskModal() {
  document.getElementById("taskModalTitle").textContent = "New Task";
  document.getElementById("taskTitle").closest(".form-group").style.display = "";
  document.getElementById("taskDesc").closest(".form-group").style.display  = "";
  document.getElementById("createTaskBtn").textContent = "Add Task";
  document.getElementById("createTaskBtn").onclick = createTask;
  populateMemberChecklists();
}

// ── Edit Task ─────────────────────────────────────────────────────────────────

async function openEditTaskModal(taskId) {
  editTargetTaskId = taskId;
  const snap = await getDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", taskId));
  if (!snap.exists()) return;
  const t = snap.data();
  document.getElementById("editTaskTitle").value = t.title || "";
  document.getElementById("editTaskDesc").value  = t.description || "";
  hideErr("editTaskError");
  openModal("editTaskModal");
}

async function saveTask() {
  const title = document.getElementById("editTaskTitle").value.trim();
  const desc  = document.getElementById("editTaskDesc").value.trim();
  if (!title) { showErr("editTaskError", "Title is required."); return; }
  const btn = document.getElementById("saveTaskBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "tasks", editTargetTaskId), {
      title, description: desc || "",
    });
    closeModal("editTaskModal");
    showToast("Task updated!");
    await loadTasks();
  } catch(err) { showErr("editTaskError", "Failed to save."); console.error(err); }
  finally { btn.disabled = false; editTargetTaskId = null; }
}

// ── Milestones ─────────────────────────────────────────────────────────────────

async function loadMilestones(forceOpen = null) {
  const openBefore = forceOpen ?? getOpenMilestones();

  const list = document.getElementById("milestoneList");
  list.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const snap       = await getDocs(query(msCol(), orderBy("createdAt")));
  const milestones = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("milestoneCount").textContent = milestones.length;
  const doneMilestones = milestones.filter(ms => (ms.progress ?? 0) >= 100).length;
  document.getElementById("statMilestones").textContent = `${doneMilestones}/${milestones.length}`;

  // Render timeline with the latest milestones
  renderTimeline(milestones);

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

  restoreOpenMilestones(openBefore);
  attachMilestoneListeners();
}

function milestoneRow(ms, tasks) {
  const progress = ms.progress ?? 0;
  const dClass   = deadlineClass(ms.expectedEndDate);
  const dLabel   = deadlineLabel(ms.expectedEndDate);

  const taskRows = tasks.map(t => {
    const assigneeIds = t.assigneeIds || (t.assigneeId ? [t.assigneeId] : []);
    const assignees   = assigneeIds.map(id => projectMembers.find(m => m.userId === id)).filter(Boolean);
    const assigneeHtml = assignees.length ? assignees.map(a =>
      `<div class="tooltip-wrap avatar avatar-sm" data-tooltip="${escHtml(`${a.name} ${a.surname}`)}">${initials(`${a.name} ${a.surname}`)}</div>`
    ).join("") : "";
    const taskRow = `
      <div class="item-row" data-ms-task-id="${t.id}" data-ms-id="${ms.id}" style="background:var(--bg);">
        <div class="item-checkbox ${t.complete ? "checked" : ""}" data-toggle-ms-task="${t.id}" data-ms-id="${ms.id}"></div>
        <div class="item-body" data-expand-ms-task="${t.id}">
          <div style="display:flex;align-items:center;gap:.5rem;">
            <div class="item-title ${t.complete ? "done" : ""}" style="flex:1;min-width:0;">${escHtml(t.title)}</div>
            <div style="display:flex;gap:.2rem;align-items:center;">${assigneeHtml}</div>
            <svg class="item-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          ${t.description ? `<div class="item-desc">${escHtml(t.description)}</div>` : ""}
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm" data-delete-ms-task="${t.id}" data-ms-id="${ms.id}" style="color:var(--danger);">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
              Delete
            </button>
          </div>
        </div>
      </div>`;
    return taskRow;
  }).join("");

  return `
    <div class="milestone-row" data-ms-id="${ms.id}">
      <div class="milestone-row-header">
        <div class="milestone-row-title-area">
          <div class="milestone-row-title">${escHtml(ms.title)}</div>
          ${ms.description ? `<div class="milestone-row-desc">${escHtml(ms.description)}</div>` : ""}
        </div>
        <div class="milestone-actions">
          <button class="btn btn-ghost btn-sm" data-edit-ms="${ms.id}" title="Edit milestone">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" data-delete-ms="${ms.id}" title="Delete milestone">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="milestone-meta">
        ${dLabel && progress < 100 ? `<span class="milestone-meta-item deadline ${dClass}">
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
  document.querySelectorAll("[data-edit-ms]").forEach(btn =>
    btn.addEventListener("click", () => openEditMilestoneModal(btn.dataset.editMs))
  );
  document.querySelectorAll("[data-add-ms-task]").forEach(btn =>
    btn.addEventListener("click", () => openMsTaskModal(btn.dataset.addMsTask))
  );
  document.querySelectorAll("[data-expand-ms-task]").forEach(el =>
    el.addEventListener("click", () => el.closest(".item-row").classList.toggle("expanded"))
  );
  document.querySelectorAll("[data-toggle-ms-task]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleMilestoneTask(el.dataset.msId, el.dataset.toggleMsTask); })
  );
  document.querySelectorAll("[data-delete-ms-task]").forEach(btn =>
    btn.addEventListener("click", (e) => { e.stopPropagation(); deleteMilestoneTask(btn.dataset.msId, btn.dataset.deleteMsTask); })
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

// ── Edit Milestone ────────────────────────────────────────────────────────────

async function openEditMilestoneModal(msId) {
  editTargetMsId = msId;
  const snap = await getDoc(msDocRef(msId));
  if (!snap.exists()) return;
  const ms = snap.data();
  document.getElementById("editMsTitle").value   = ms.title || "";
  document.getElementById("editMsDesc").value    = ms.description || "";
  document.getElementById("editMsEndDate").value = ms.expectedEndDate || "";
  hideErr("editMsError");
  openModal("editMilestoneModal");
}

async function saveMilestone() {
  const title   = document.getElementById("editMsTitle").value.trim();
  const desc    = document.getElementById("editMsDesc").value.trim();
  const endDate = document.getElementById("editMsEndDate").value;
  if (!title) { showErr("editMsError", "Title is required."); return; }
  const btn = document.getElementById("saveMilestoneBtn");
  btn.disabled = true;
  const msId = editTargetMsId;
  try {
    await updateDoc(msDocRef(msId), { title, description: desc || "", expectedEndDate: endDate || null });
    closeModal("editMilestoneModal");
    showToast("Milestone updated!");
    const openSet = getOpenMilestones();
    openSet.add(msId);
    await loadMilestones(openSet);
  } catch(err) { showErr("editMsError", "Failed to save."); console.error(err); }
  finally { btn.disabled = false; editTargetMsId = null; }
}

// ── Milestone tasks ────────────────────────────────────────────────────────────

function openMsTaskModal(msId) {
  currentMsId = msId;
  document.getElementById("msTaskTitle").value = "";
  document.getElementById("msTaskDesc").value  = "";
  populateMemberChecklists();
  hideErr("msTaskError");
  openModal("msTaskModal");
}

async function createMilestoneTask() {
  const title = document.getElementById("msTaskTitle").value.trim();
  const desc  = document.getElementById("msTaskDesc").value.trim();
  if (!title)      { showErr("msTaskError", "Task title is required."); return; }
  if (!currentMsId) return;

  const assigneeIds = getCheckedAssignees("msTaskAssigneeList");
  const assignees   = assigneeIds.map(id => projectMembers.find(m => m.userId === id)).filter(Boolean);
  const btn      = document.getElementById("createMsTaskBtn");
  btn.disabled   = true;
  const msId     = currentMsId;

  try {
    await addDoc(msTasksCol(msId), {
      title, description: desc || "", complete: false,
      assigneeIds,
      createdAt: serverTimestamp(),
    });
    closeModal("msTaskModal");
    showToast("Task added!");

    await recalcMilestoneProgress(msId);
    await recalcProjectProgress();
    const openSet = getOpenMilestones();
    openSet.add(msId);
    await loadMilestones(openSet);
  } catch(err) { showErr("msTaskError", "Failed to add task."); console.error(err); }
  finally { btn.disabled = false; currentMsId = null; }
}

async function toggleMilestoneTask(msId, taskId) {
  const ref  = doc(db, "users", OWNER_UID, "projects", PROJECT_ID, "milestones", msId, "tasks", taskId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, { complete: !snap.data().complete });
  await recalcMilestoneProgress(msId);
  await recalcProjectProgress();
  await loadMilestones();
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
    // Best-effort back-reference
    try {
      await addDoc(
        collection(db, "users", foundMember.uid, "memberOf"),
        { ownerUid: OWNER_UID, projectId: PROJECT_ID, projectTitle: projectData?.title || "" }
      );
    } catch (e) { console.warn("memberOf write failed:", e); }
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
  const currentColor = projectData.color || "#5B6AF5";
  document.querySelectorAll("#editProjColorPicker .color-swatch").forEach(b => {
    b.classList.toggle("selected", b.dataset.color === currentColor);
  });
  document.querySelectorAll("#editProjColorPicker .color-swatch").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#editProjColorPicker .color-swatch").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
  });
  openModal("editProjectModal");
}

async function saveProject() {
  const title = document.getElementById("editProjTitle").value.trim();
  const desc  = document.getElementById("editProjDesc").value.trim();
  const due   = document.getElementById("editProjDue").value;
  const color = document.querySelector("#editProjColorPicker .color-swatch.selected")?.dataset.color || projectData.color || "#5B6AF5";
  if (!title) return;

  const btn = document.getElementById("saveProjectBtn");
  btn.disabled = true;
  try {
    await updateDoc(projRef(), { title, description: desc || "", dueDate: due || null, color });
    closeModal("editProjectModal");
    showToast("Project updated!");
    // Update the page accent color
    document.documentElement.style.setProperty("--primary", color);
    await loadProject();
  } catch(err) { showToast("Failed to save changes.", "error"); console.error(err); }
  finally { btn.disabled = false; }
}

// ── Timeline ───────────────────────────────────────────────────────────────────

let tlTransform = { x: 40, y: 40, scale: 1 };
let tlDragging  = false;
let tlDragStart = { x: 0, y: 0 };
let tlNodeDrags = {};  // { msId: { x, y } } — custom positions for dragged nodes
let tlMilestones = []; // latest milestones array for re-render

const NODE_W = 200, NODE_H = 110, COL_GAP = 100, ROW_GAP = 60, COLS = 3;

function tlDefaultPos(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  return { x: col * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) };
}

function tlGetPos(msId, i) {
  return tlNodeDrags[msId] || tlDefaultPos(i);
}

function renderTimeline(milestones) {
  tlMilestones = milestones;
  const canvas = document.getElementById("timelineCanvas");
  const emptyEl = document.getElementById("timelineEmpty");
  if (!canvas) return;

  if (!milestones.length) {
    canvas.innerHTML = "";
    if (emptyEl) { emptyEl.style.display = "flex"; }
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  // Sort by expectedEndDate then createdAt
  const sorted = [...milestones].sort((a, b) => {
    const da = a.expectedEndDate || "";
    const db = b.expectedEndDate || "";
    if (da && db) return da.localeCompare(db);
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  let html = "";

  // Draw arrows first (behind nodes)
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = tlGetPos(sorted[i].id, i);
    const to   = tlGetPos(sorted[i + 1].id, i + 1);
    const fx = from.x + NODE_W, fy = from.y + NODE_H / 2;
    const tx = to.x,            ty = to.y + NODE_H / 2;
    const cx1 = fx + Math.max((tx - fx) / 2, 40);
    const cx2 = tx - Math.max((tx - fx) / 2, 40);
    html += `<path d="M${fx},${fy} C${cx1},${fy} ${cx2},${ty} ${tx},${ty}"
      fill="none" stroke="#CBD5E1" stroke-width="2" marker-end="url(#arrowhead)"
      stroke-dasharray="${sorted[i + 1].expectedEndDate ? 'none' : '6,4'}"/>`;
  }

  // Draw nodes
  sorted.forEach((ms, i) => {
    const { x, y } = tlGetPos(ms.id, i);
    const progress  = ms.progress ?? 0;
    const fillColor = progress >= 100 ? "#22C55E" : progress >= 50 ? "#F59E0B" : "#5B6AF5";
    const dLabel    = ms.expectedEndDate ? deadlineLabel(ms.expectedEndDate) : "";
    const dClass    = ms.expectedEndDate ? deadlineClass(ms.expectedEndDate) : "ok";
    const dColor    = dClass === "overdue" && progress < 100 ? "#EF4444" : dClass === "soon" && progress < 100 ? "#F59E0B" : "#94A3B8";

    const titleTrunc = escHtml(ms.title.length > 22 ? ms.title.slice(0, 20) + "\u2026" : ms.title);
    const descTrunc  = ms.description ? escHtml(ms.description.length > 30 ? ms.description.slice(0, 28) + "\u2026" : ms.description) : "";

    html += `
      <g class="tl-node" data-ms-id="${ms.id}" transform="translate(${x},${y})" style="cursor:grab;">
        <rect x="2" y="3" width="${NODE_W}" height="${NODE_H}" rx="10" fill="rgba(0,0,0,.06)"/>
        <rect width="${NODE_W}" height="${NODE_H}" rx="10" fill="white" stroke="#E2E8F0" stroke-width="1.5"/>
        <rect width="${NODE_W}" height="4" rx="2" fill="${fillColor}" opacity=".9"/>
        <text x="12" y="26" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="600" fill="#0F172A">${titleTrunc}</text>
        ${descTrunc ? `<text x="12" y="42" font-family="Inter,system-ui,sans-serif" font-size="10.5" fill="#64748B">${descTrunc}</text>` : ""}
        <rect x="12" y="${NODE_H - 38}" width="${NODE_W - 24}" height="5" rx="3" fill="#E2E8F0"/>
        <rect x="12" y="${NODE_H - 38}" width="${Math.round((NODE_W - 24) * progress / 100)}" height="5" rx="3" fill="${fillColor}"/>
        <text x="12" y="${NODE_H - 46}" font-family="Inter,system-ui,sans-serif" font-size="10" fill="#64748B">Progress</text>
        <text x="${NODE_W - 12}" y="${NODE_H - 46}" font-family="Inter,system-ui,sans-serif" font-size="10" font-weight="600" fill="#0F172A" text-anchor="end">${progress}%</text>
        ${dLabel ? `<text x="12" y="${NODE_H - 14}" font-family="Inter,system-ui,sans-serif" font-size="10" fill="${dColor}">${escHtml(dLabel)}</text>` : ""}
      </g>`;
  });

  canvas.innerHTML = html;
  applyTlTransform();
  attachTlNodeDragListeners(sorted);
}

function applyTlTransform() {
  const canvas = document.getElementById("timelineCanvas");
  if (canvas) canvas.setAttribute("transform",
    `translate(${tlTransform.x}, ${tlTransform.y}) scale(${tlTransform.scale})`);
}

function attachTlNodeDragListeners(sorted) {
  document.querySelectorAll(".tl-node").forEach(node => {
    const msId = node.dataset.msId;
    const idx  = sorted.findIndex(ms => ms.id === msId);
    let dragging = false, startMx = 0, startMy = 0, startNx = 0, startNy = 0;

    node.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      dragging = true;
      node.style.cursor = "grabbing";
      startMx = e.clientX;
      startMy = e.clientY;
      const pos = tlGetPos(msId, idx);
      startNx = pos.x;
      startNy = pos.y;

      const onMove = (e2) => {
        if (!dragging) return;
        const dx = (e2.clientX - startMx) / tlTransform.scale;
        const dy = (e2.clientY - startMy) / tlTransform.scale;
        tlNodeDrags[msId] = { x: startNx + dx, y: startNy + dy };
        renderTimeline(tlMilestones);
      };
      const onUp = () => {
        dragging = false;
        node.style.cursor = "grab";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

function initTimelineControls() {
  const svg = document.getElementById("timelineSvg");
  const container = document.getElementById("timelineContainer");
  if (!svg || !container) return;

  // SVG pan (drag on background)
  svg.addEventListener("mousedown", (e) => {
    if (e.target.closest(".tl-node")) return;
    tlDragging = true;
    tlDragStart = { x: e.clientX - tlTransform.x, y: e.clientY - tlTransform.y };
    svg.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (e) => {
    if (!tlDragging) return;
    tlTransform.x = e.clientX - tlDragStart.x;
    tlTransform.y = e.clientY - tlDragStart.y;
    applyTlTransform();
  });
  window.addEventListener("mouseup", () => {
    if (tlDragging) {
      tlDragging = false;
      svg.style.cursor = "grab";
    }
  });

  // Zoom on scroll
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(tlTransform.scale * delta, 0.3), 3);
    tlTransform.x = mx - (mx - tlTransform.x) * (newScale / tlTransform.scale);
    tlTransform.y = my - (my - tlTransform.y) * (newScale / tlTransform.scale);
    tlTransform.scale = newScale;
    applyTlTransform();
  }, { passive: false });

  // Buttons
  document.getElementById("tlZoomIn").addEventListener("click", () => {
    tlTransform.scale = Math.min(tlTransform.scale * 1.2, 3);
    applyTlTransform();
  });
  document.getElementById("tlZoomOut").addEventListener("click", () => {
    tlTransform.scale = Math.max(tlTransform.scale * 0.8, 0.3);
    applyTlTransform();
  });
  document.getElementById("tlReset").addEventListener("click", () => {
    tlTransform = { x: 40, y: 40, scale: 1 };
    tlNodeDrags = {};
    renderTimeline(tlMilestones);
  });
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
