// Show settings and task list.
// Edit this file to change the show date, the teams, or the tasks.

const SHOW = {
  name: "2027 Food Show",
  // Placeholder date: change to the real show date (YYYY-MM-DD).
  date: "2027-04-15",
};

const TEAMS = ["Marketing", "Sales", "Buyers", "Admin", "CService", "IT"];

// Sections tasks are grouped under, in display order. Empty sections are hidden.
const PHASES = ["Planning", "Logistics", "Show Day"];

// Placeholder tasks until the real list is ready.
// Each task: id (unique, never reuse), phase, title, due (YYYY-MM-DD or ""), team (default people in charge).
const TASKS = [
  { id: "t1", phase: "Planning", title: "Sample task: Confirm venue", due: "2026-12-01", team: ["Admin"] },
  { id: "t2", phase: "Logistics", title: "Sample task: Order tables and power", due: "2027-03-31", team: ["Admin", "Buyers"] },
  { id: "t3", phase: "Show Day", title: "Sample task: Run check-in desk", due: "2027-04-15", team: [] },
];
