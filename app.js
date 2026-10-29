// Preview version: status and assignments are saved in this browser only.
// This storage layer will be swapped for Supabase in phase 2.

const STORAGE_KEY = "foodshow2027-state";
const STATUS_ORDER = ["not", "progress", "done"];
const STATUS_LABEL = { not: "Not started", progress: "In progress", done: "Done" };

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked (private window etc.): changes last until refresh.
  }
}

const state = loadState();

function taskState(task) {
  const saved = state[task.id] || {};
  return {
    status: saved.status || "not",
    people: saved.people || task.team || [],
  };
}

function updateTask(id, changes) {
  const task = TASKS.find(t => t.id === id);
  state[id] = { ...taskState(task), ...changes };
  saveState();
  render();
}

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(s) {
  return parseDate(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isOverdue(task, status) {
  return task.due && status !== "done" && parseDate(task.due) < today();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setBar(doneEl, progressEl, counts, total) {
  doneEl.style.width = total ? (counts.done / total) * 100 + "%" : "0";
  progressEl.style.width = total ? (counts.progress / total) * 100 + "%" : "0";
}

function countStatuses(tasks) {
  const counts = { not: 0, progress: 0, done: 0 };
  tasks.forEach(t => counts[taskState(t).status]++);
  return counts;
}

function renderHeader() {
  document.getElementById("show-name").textContent = SHOW.name;
  document.getElementById("show-date").textContent = SHOW.dateLabel || formatDate(SHOW.date);
  const days = Math.round((parseDate(SHOW.date) - today()) / 86400000);
  document.getElementById("days-left").textContent = Math.max(days, 0);
  document.getElementById("days-label").textContent = days === 1 ? "day to go" : "days to go";

  const counts = countStatuses(TASKS);
  setBar(document.getElementById("overall-done"), document.getElementById("overall-progress"), counts, TASKS.length);
  document.getElementById("overall-text").textContent =
    `${counts.done} done · ${counts.progress} in progress · ${counts.not} not started · ${TASKS.length} tasks`;
}

function matchesFilters(task) {
  const team = document.getElementById("filter-team").value;
  const status = document.getElementById("filter-status").value;
  const s = taskState(task);

  if (team === "__unassigned" && s.people.length) return false;
  if (team && team !== "__unassigned" && !s.people.includes(team)) return false;
  if (status === "overdue") return isOverdue(task, s.status);
  if (status && s.status !== status) return false;
  return true;
}

function renderTask(task) {
  const s = taskState(task);
  const overdue = isOverdue(task, s.status);
  const chips = s.people.length
    ? s.people.map(p => `<span class="chip">${escapeHtml(p)}</span>`).join("")
    : `<span class="chip empty">Unassigned</span>`;
  const due = task.due
    ? `<div class="task-due${overdue ? " overdue" : ""}">${overdue ? "Overdue · " : "Due "}${formatDate(task.due)}</div>`
    : "";

  return `
    <div class="task" data-status="${s.status}">
      <button class="status-btn" data-status="${s.status}" data-id="${task.id}" title="Tap to change status">
        ${STATUS_LABEL[s.status]}
      </button>
      <div>
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${due}
      </div>
      <button class="people" data-id="${task.id}" title="Change who's in charge">${chips}</button>
    </div>`;
}

function renderPhases() {
  const html = PHASES.map(phase => {
    const all = TASKS.filter(t => t.phase === phase);
    const shown = all.filter(matchesFilters);
    if (!shown.length) return "";
    const counts = countStatuses(all);
    return `
      <section class="phase">
        <div class="phase-head">
          <h2>${escapeHtml(phase)}</h2>
          <div class="bar"><span style="width:${(counts.done / all.length) * 100}%"></span><span style="width:${(counts.progress / all.length) * 100}%"></span></div>
          <span class="phase-count">${counts.done}/${all.length} done</span>
        </div>
        ${shown.map(renderTask).join("")}
      </section>`;
  }).join("");

  document.getElementById("phases").innerHTML = html || `<p class="empty-state">No tasks match these filters.</p>`;
}

function render() {
  renderHeader();
  renderPhases();
}

// Assign dialog
const dialog = document.getElementById("assign-dialog");
let assigningId = null;

function openAssign(id) {
  const task = TASKS.find(t => t.id === id);
  const s = taskState(task);
  assigningId = id;
  document.getElementById("assign-title").textContent = `In charge: ${task.title}`;
  document.getElementById("assign-options").innerHTML = TEAMS.map(team => `
    <label>
      <input type="checkbox" value="${escapeHtml(team)}" ${s.people.includes(team) ? "checked" : ""}>
      ${escapeHtml(team)}
    </label>`).join("");
  dialog.showModal();
}

dialog.addEventListener("close", () => {
  if (dialog.returnValue === "save" && assigningId) {
    const people = [...dialog.querySelectorAll("input:checked")].map(i => i.value);
    updateTask(assigningId, { people });
  }
  assigningId = null;
});

document.getElementById("phases").addEventListener("click", e => {
  const statusBtn = e.target.closest(".status-btn");
  if (statusBtn) {
    const current = statusBtn.dataset.status;
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(current) + 1) % STATUS_ORDER.length];
    updateTask(statusBtn.dataset.id, { status: next });
    return;
  }
  const peopleBtn = e.target.closest(".people");
  if (peopleBtn) openAssign(peopleBtn.dataset.id);
});

// Filters
const teamFilter = document.getElementById("filter-team");
TEAMS.forEach(team => teamFilter.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`));
teamFilter.addEventListener("change", renderPhases);
document.getElementById("filter-status").addEventListener("change", renderPhases);

render();
