import { db, auth } from "./firebase-config.js";
import { requireAuth, getUserProfile, logout } from "./auth.js";
import {
  collection, addDoc, getDocs, deleteDoc, doc,
  query, orderBy, serverTimestamp, where, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function deadlineClass(dateStr) {
  if (!dateStr) return "";
  const diff = (new Date(dateStr) - new Date()) / 86400000;
  if (diff < 0)  return "overdue";
  if (diff < 7)  return "soon";
  return "ok";
}

function deadlineLabel(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const diff = Math.ceil((date - new Date()) / 86400000);
  if (diff < 0)  return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due ${date.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;
}

function progressColor(pct) {
  if (pct >= 100) return "success";
  if (pct >= 50)  return "warning";
  return "";
}

function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// ── Main ─────────────────────────────────────────────────────────────────────

let currentUser = null;
let projectToDelete = null;

async function init() {
  currentUser = await requireAuth();

  // Populate sidebar user info
  const profile = await getUserProfile(currentUser.uid);
  if (profile) {
    const fullName = `${profile.name} ${profile.surname}`;
    document.getElementById("userName").textContent  = fullName;
    document.getElementById("userEmail").textContent = profile.email;
    document.getElementById("userAvatar").textContent = initials(fullName);
  }

  // Logout
  document.getElementById("logoutBtn").addEventListener("click", logout);

  // Open new-project modal
  document.getElementById("newProjectBtn").addEventListener("click", () => {
    document.getElementById("projTitle").value = "";
    document.getElementById("projDesc").value  = "";
    document.getElementById("projDue").value   = "";
    hideError("projError");
    openModal("newProjectModal");
  });

  // Create project
  document.getElementById("createProjectBtn").addEventListener("click", createProject);

  // Delete confirm
  document.getElementById("confirmDeleteBtn").addEventListener("click", confirmDelete);

  // Close buttons (data-close attribute)
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  // Close modal on overlay click
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
  });

  // Load projects
  await loadProjects();
}

// ── Load Projects ─────────────────────────────────────────────────────────────

async function loadProjects() {
  const grid = document.getElementById("projectsGrid");
  grid.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  const q = query(
    collection(db, "users", currentUser.uid, "projects"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);

  const projects = [];
  for (const d of snap.docs) {
    const tasksSnap = await getDocs(collection(db, "users", currentUser.uid, "projects", d.id, "tasks"));
    const doneTasks = tasksSnap.docs.filter(t => t.data().complete).length;
    const totalTasks = tasksSnap.size;

    const milestonesSnap = await getDocs(collection(db, "users", currentUser.uid, "projects", d.id, "milestones"));
    const membersSnap    = await getDocs(collection(db, "users", currentUser.uid, "projects", d.id, "members"));
    const milestoneDone  = milestonesSnap.docs.filter(d => (d.data().progress ?? 0) >= 100).length;

    projects.push({
      id: d.id,
      ownerUid: currentUser.uid,
      ...d.data(),
      totalTasks,
      doneTasks,
      milestoneCount: milestonesSnap.size,
      milestoneDone,
      memberCount: membersSnap.size,
      isShared: false,
    });
  }

  // Load projects shared with this user via memberOf
  const memberOfSnap = await getDocs(collection(db, "users", currentUser.uid, "memberOf"));
  for (const mDoc of memberOfSnap.docs) {
    const { ownerUid, projectId } = mDoc.data();
    if (!ownerUid || !projectId) continue;
    try {
      const pSnap = await getDoc(doc(db, "users", ownerUid, "projects", projectId));
      if (!pSnap.exists()) continue;
      const tasksSnap = await getDocs(collection(db, "users", ownerUid, "projects", projectId, "tasks"));
      const doneTasks  = tasksSnap.docs.filter(t => t.data().complete).length;
      const milestonesSnap = await getDocs(collection(db, "users", ownerUid, "projects", projectId, "milestones"));
      const membersSnap    = await getDocs(collection(db, "users", ownerUid, "projects", projectId, "members"));
      const milestoneDone  = milestonesSnap.docs.filter(d => (d.data().progress ?? 0) >= 100).length;
      projects.push({
        id: projectId, ownerUid,
        ...pSnap.data(),
        totalTasks: tasksSnap.size, doneTasks,
        milestoneCount: milestonesSnap.size, milestoneDone,
        memberCount: membersSnap.size,
        isShared: true,
      });
    } catch(e) { console.warn("Could not load shared project:", e); }
  }

  renderProjects(grid, projects);
}

function renderProjects(grid, projects) {
  if (projects.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
            <rect x="9" y="3" width="6" height="4" rx="1"/>
            <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
          </svg>
        </div>
        <h3>No projects yet</h3>
        <p class="text-sm">Create your first project to get started.</p>
      </div>`;
    return;
  }

  grid.innerHTML = projects.map(p => {
    const progress = p.progress ?? 0;
    const dClass   = deadlineClass(p.dueDate);
    const dLabel   = deadlineLabel(p.dueDate);
    const pColor   = progressColor(progress);
    const ownerUid = p.ownerUid || currentUser.uid;

    return `
      <div class="project-card" onclick="openProject('${p.id}','${ownerUid}')">
        <div class="project-card-header">
          <div style="display:flex;align-items:center;gap:.4rem;flex:1;min-width:0;">
            ${p.isShared ? `<span class="badge badge-gray" style="font-size:.7rem;margin-right:.25rem;">Shared</span>` : ""}
            <h3 class="project-card-title">${escHtml(p.title)}</h3>
          </div>
          <div class="project-card-actions" onclick="event.stopPropagation()">
            ${!p.isShared ? `
            <button class="btn btn-ghost btn-sm" onclick="askDelete('${p.id}','${escHtml(p.title)}')" title="Delete project">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
              </svg>
            </button>` : ""}
          </div>
        </div>

        ${p.description ? `<p class="project-card-desc">${escHtml(p.description)}</p>` : ""}

        <div class="progress-wrap">
          <div class="progress-label">
            <span class="text-xs text-secondary">Progress</span>
            <span class="text-xs font-semibold">${progress}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${pColor}" style="width:${progress}%"></div>
          </div>
        </div>

        <div class="project-card-meta">
          ${dLabel ? `
            <span class="project-card-meta-item deadline ${dClass}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              ${dLabel}
            </span>` : ""}
          <span class="project-card-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            ${p.doneTasks}/${p.totalTasks} tasks
          </span>
          <span class="project-card-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
            </svg>
            ${p.milestoneDone}/${p.milestoneCount} milestones
          </span>
          <span class="project-card-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
            </svg>
            ${p.memberCount + 1} member${p.memberCount !== 0 ? "s" : ""}
          </span>
        </div>
      </div>`;
  }).join("");
}

// ── Create Project ─────────────────────────────────────────────────────────────

async function createProject() {
  const title = document.getElementById("projTitle").value.trim();
  const desc  = document.getElementById("projDesc").value.trim();
  const due   = document.getElementById("projDue").value;

  if (!title) { showError("projError", "Project title is required."); return; }

  const btn = document.getElementById("createProjectBtn");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    await addDoc(collection(db, "users", currentUser.uid, "projects"), {
      title,
      description: desc || "",
      dueDate: due || null,
      progress: 0,
      ownerId: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    closeModal("newProjectModal");
    showToast("Project created!");
    await loadProjects();
  } catch (err) {
    showError("projError", "Failed to create project. Please try again.");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Project";
  }
}

// ── Delete Project ─────────────────────────────────────────────────────────────

function askDelete(projectId, projectTitle) {
  projectToDelete = projectId;
  document.getElementById("deleteProjectName").textContent = projectTitle;
  openModal("deleteProjectModal");
}

async function confirmDelete() {
  if (!projectToDelete) return;
  const btn = document.getElementById("confirmDeleteBtn");
  btn.disabled = true;
  btn.textContent = "Deleting…";

  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "projects", projectToDelete));
    closeModal("deleteProjectModal");
    showToast("Project deleted.", "error");
    await loadProjects();
  } catch (err) {
    showToast("Failed to delete project.", "error");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Delete";
    projectToDelete = null;
  }
}

// ── Open Project ──────────────────────────────────────────────────────────────

function openProject(projectId, ownerUid) {
  window.location.href = `project.html?id=${projectId}&owner=${ownerUid || currentUser.uid}`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = "block";
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Expose globals for inline onclick
window.openProject = openProject;
window.askDelete   = askDelete;

init();
