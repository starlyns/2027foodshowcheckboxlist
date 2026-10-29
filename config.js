// Site settings. The tasks themselves live in Supabase (see supabase/setup.sql).

const SHOW = {
  name: "2027 Food Show",
  // Plan says mid-September 2027, Monday or Tuesday. Placeholder until the date is set (YYYY-MM-DD).
  date: "2027-09-14",
  dateLabel: "Mid-September 2027 (date TBD)",
};

// Must match the names in supabase/set-pins.sql.
const TEAMS = ["Marketing", "Sales", "Buyers", "Admin", "CService", "IT"];
const ADMIN_NAME = "Site Admin";

// Sections tasks are grouped under, in display order.
const PHASES = [
  "Ownership & Planning",
  "Data to Collect from Management",
  "Venue & Date",
  "Vendor Packages",
  "Attendance (Goal: 1,000+ buyers, ~1,800 registrations)",
  "Social Media & Promotion",
  "Show Experience",
  "Year-Round Marketing",
  "Food Fest Depot",
  "Measurement",
];

// Public connection details. The publishable key is meant to be in the page;
// never put the secret / service_role key here.
const SUPABASE = {
  url: "https://bdepvnnkfgmtywejtaam.supabase.co",
  key: "sb_publishable_BJYwJXEUBNx6qJ5Zytnp0Q_IV2YXWFK",
};
