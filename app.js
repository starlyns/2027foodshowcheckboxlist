// Tasks are stored in Supabase. Anyone can view; changes need a team PIN and are
// checked by the database functions in supabase/setup.sql.

const STATUS_ORDER = ["not", "progress", "done"];
const STATUS_LABEL = { not: "Not started", progress: "In progress", done: "Done" };
const SESSION_KEY = "foodshow2027-session";

const API = `${SUPABASE.url}/rest/v1`;
const HEADERS = { apikey: SUPABASE.key, "Content-Type": "application/json" };

let tasks = [];
let loadError = null;
let session = loadSession();
const pending = new Set();

// Data ----------------------------------------------------------------------

async function fetchTasks() {
  const res = await fetch(`${API}/tasks?select=*&order=position`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Could not load tasks (${res.status}).`);
  return res.json();
}

async function rpc(fn, args) {
  const res = await fetch(`${API}/rpc/${fn}`, { method: "POST", headers: HEADERS, body: JSON.stringify(args) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || `Request failed (${res.status}).`);
  return data;
}

async function reload() {
  try {
    tasks = await fetchTasks();
    loadError = null;
  } catch (err) {
    loadError = err.message;
  }
  render();
}

// Sends one change for a task, then swaps in the saved row from the database.
async function changeTask(id, fn, args) {
  if (pending.has(id)) return;
  pending.add(id);
  try {
    const result = await rpc(fn, { p_name: session.name, p_pin: session.pin, p_task_id: id, ...args });
    if (!result.ok) {
      toast(result.error);
      if (/PIN/.test(result.error)) signOut();
      return;
    }
    tasks = tasks.map(t => (t.id === id ? result.task : t));
  } catch (err) {
    toast(err.message);
  } finally {
    pending.delete(id);
    render();
  }
}

// Session -------------------------------------------------------------------
// Kept for this browser tab only; closing the tab signs out.

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession() {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: stays signed in until refresh.
  }
}

function signOut() {
  session = null;
  saveSession();
  render();
}

function canEdit(task) {
  return Boolean(session) && (session.isAdmin || task.people.includes(session.name));
}

// Helpers ---------------------------------------------------------------------

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

function isOverdue(task) {
  return Boolean(task.due) && task.status !== "done" && parseDate(task.due) < today();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setBar(doneEl, progressEl, counts, total) {
  doneEl.style.width = total ? (counts.done / total) * 100 + "%" : "0";
  progressEl.style.width = total ? (counts.progress / total) * 100 + "%" : "0";
}

function countStatuses(list) {
  const counts = { not: 0, progress: 0, done: 0 };
  list.forEach(t => counts[t.status]++);
  return counts;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function lockedMessage(task) {
  if (!task.people.length) return "Nobody is in charge yet. Tap \"Unassigned\" to claim it for your team first.";
  return `Only the teams in charge (${task.people.join(", ")}) can change this task.`;
}

// Rendering -------------------------------------------------------------------

function renderHeader() {
  document.getElementById("show-name").textContent = SHOW.name;
  document.getElementById("show-date").textContent = SHOW.dateLabel || formatDate(SHOW.date);
  const days = Math.round((parseDate(SHOW.date) - today()) / 86400000);
  document.getElementById("days-left").textContent = Math.max(days, 0);
  document.getElementById("days-label").textContent = days === 1 ? "day to go" : "days to go";

  const counts = countStatuses(tasks);
  setBar(document.getElementById("overall-done"), document.getElementById("overall-progress"), counts, tasks.length);
  document.getElementById("overall-text").textContent =
    `${counts.done} done · ${counts.progress} in progress · ${counts.not} not started · ${tasks.length} tasks`;
}

function renderSessionBar() {
  document.getElementById("session-text").innerHTML = session
    ? `Signed in as <strong>${escapeHtml(session.name)}</strong>${session.isAdmin ? " (can edit everything)" : ""}`
    : "Viewing only. Sign in with your team PIN to make changes.";
  document.getElementById("sign-in-btn").hidden = Boolean(session);
  document.getElementById("sign-out-btn").hidden = !session;
}

function matchesFilters(task) {
  const team = document.getElementById("filter-team").value;
  const status = document.getElementById("filter-status").value;

  if (team === "__unassigned" && task.people.length) return false;
  if (team && team !== "__unassigned" && !task.people.includes(team)) return false;
  if (status === "overdue") return isOverdue(task);
  if (status && task.status !== status) return false;
  return true;
}

function renderTask(task) {
  const overdue = isOverdue(task);
  const editable = canEdit(task);
  const chips = task.people.length
    ? task.people.map(p => `<span class="chip">${escapeHtml(p)}</span>`).join("")
    : `<span class="chip empty">Unassigned</span>`;
  const deadlineLabel = task.due
    ? `${overdue ? `<span class="overdue-word">Overdue · </span>` : ""}${formatDate(task.due)}`
    : "Deadline";
  const dateInput = editable
    ? `<input type="date" class="deadline-input" data-id="${task.id}" value="${task.due || ""}" aria-label="Deadline for ${escapeHtml(task.title)}">`
    : "";
  const lastChange = task.updated_by ? ` title="Last changed by ${escapeHtml(task.updated_by)}"` : "";

  return `
    <div class="task${editable ? "" : " locked"}${pending.has(task.id) ? " saving" : ""}" data-status="${task.status}" data-id="${task.id}">
      <button class="status-btn" data-status="${task.status}"${lastChange}>
        ${STATUS_LABEL[task.status]}
      </button>
      <div class="task-title">${escapeHtml(task.title)}</div>
      <label class="deadline${task.due ? " set" : ""}${overdue ? " overdue" : ""}">
        <span>${deadlineLabel}</span>
        ${dateInput}
      </label>
      <button class="people" title="Who's in charge">${chips}</button>
    </div>`;
}

function renderPhases() {
  const container = document.getElementById("phases");
  if (loadError) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(loadError)} Check your connection and refresh the page.</p>`;
    return;
  }
  if (!tasks.length) {
    container.innerHTML = `<p class="empty-state">Loading tasks…</p>`;
    return;
  }

  // Sections from config first, then any section only the database knows about.
  const phases = [...PHASES, ...new Set(tasks.map(t => t.phase).filter(p => !PHASES.includes(p)))];
  const html = phases.map(phase => {
    const all = tasks.filter(t => t.phase === phase);
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

  container.innerHTML = html || `<p class="empty-state">No tasks match these filters.</p>`;
}

function render() {
  renderHeader();
  renderSessionBar();
  renderPhases();
}

// Sign-in dialog ------------------------------------------------------------------

const signInDialog = document.getElementById("sign-in-dialog");
const signInForm = document.getElementById("sign-in-form");
const signInError = document.getElementById("sign-in-error");

document.getElementById("sign-in-team").innerHTML = [...TEAMS, ADMIN_NAME]
  .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

function openSignIn() {
  signInForm.reset();
  signInError.textContent = "";
  signInDialog.showModal();
}

signInForm.addEventListener("submit", async e => {
  e.preventDefault();
  const name = document.getElementById("sign-in-team").value;
  const pin = document.getElementById("sign-in-pin").value;
  const submit = signInForm.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const result = await rpc("sign_in", { p_name: name, p_pin: pin });
    if (!result.ok) {
      signInError.textContent = result.error;
      return;
    }
    session = { name, pin, isAdmin: result.is_admin };
    saveSession();
    signInDialog.close();
    render();
  } catch (err) {
    signInError.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("sign-in-cancel").addEventListener("click", () => signInDialog.close());
document.getElementById("sign-in-btn").addEventListener("click", openSignIn);
document.getElementById("sign-out-btn").addEventListener("click", signOut);

// Assign dialog (admin only) ---------------------------------------------------------

const assignDialog = document.getElementById("assign-dialog");
let assigningId = null;

function openAssign(task) {
  assigningId = task.id;
  document.getElementById("assign-title").textContent = `In charge: ${task.title}`;
  document.getElementById("assign-options").innerHTML = TEAMS.map(team => `
    <label>
      <input type="checkbox" value="${escapeHtml(team)}" ${task.people.includes(team) ? "checked" : ""}>
      ${escapeHtml(team)}
    </label>`).join("");
  assignDialog.showModal();
}

assignDialog.addEventListener("close", () => {
  if (assignDialog.returnValue === "save" && assigningId) {
    const people = [...assignDialog.querySelectorAll("input:checked")].map(i => i.value);
    changeTask(assigningId, "set_people", { p_people: people });
  }
  assigningId = null;
});

// Claim dialog (teams) ------------------------------------------------------------------

const claimDialog = document.getElementById("claim-dialog");
let claimingId = null;

function openClaim(task) {
  claimingId = task.id;
  document.getElementById("claim-text").innerHTML =
    `Put <strong>${escapeHtml(session.name)}</strong> in charge of "${escapeHtml(task.title)}"?`;
  claimDialog.showModal();
}

claimDialog.addEventListener("close", () => {
  if (claimDialog.returnValue === "claim" && claimingId) {
    changeTask(claimingId, "set_people", { p_people: [session.name] });
  }
  claimingId = null;
});

// Task clicks -------------------------------------------------------------------------

function handlePeopleClick(task) {
  if (session.isAdmin) {
    openAssign(task);
  } else if (!task.people.length) {
    openClaim(task);
  } else {
    toast("This task is already taken. Only the admin can reassign it.");
  }
}

document.getElementById("phases").addEventListener("click", e => {
  const row = e.target.closest(".task");
  if (!row) return;
  const task = tasks.find(t => t.id === row.dataset.id);
  const statusBtn = e.target.closest(".status-btn");
  const peopleBtn = e.target.closest(".people");
  const deadline = e.target.closest(".deadline");
  if (!statusBtn && !peopleBtn && !deadline) return;

  if (!session) {
    e.preventDefault();
    openSignIn();
    return;
  }
  if (peopleBtn) {
    handlePeopleClick(task);
    return;
  }
  if (!canEdit(task)) {
    e.preventDefault();
    toast(lockedMessage(task));
    return;
  }
  if (statusBtn) {
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length];
    changeTask(task.id, "set_status", { p_status: next });
    return;
  }
  const dateInput = e.target.closest(".deadline-input");
  if (dateInput && dateInput.showPicker) {
    try { dateInput.showPicker(); } catch { /* browser opens its own picker */ }
  }
});

document.getElementById("phases").addEventListener("change", e => {
  if (e.target.matches(".deadline-input")) {
    changeTask(e.target.dataset.id, "set_due", { p_due: e.target.value || null });
  }
});

// Filters -------------------------------------------------------------------------------

const teamFilter = document.getElementById("filter-team");
TEAMS.forEach(team => teamFilter.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`));
teamFilter.addEventListener("change", renderPhases);
document.getElementById("filter-status").addEventListener("change", renderPhases);

// Pick up other people's changes when coming back to the tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !document.querySelector("dialog[open]")) reload();
});

render();
reload();
