-- 2027 Food Show task tracker: database setup.
--
-- Run once: paste this whole file into Supabase > SQL Editor and click Run.
-- Safe to run again: it never deletes tasks or progress, and only adds tasks that are missing.
-- After this, set the PINs with set-pins.sql.

create extension if not exists pgcrypto with schema extensions;

-- Tables ----------------------------------------------------------------

create table if not exists public.tasks (
  id          text primary key,
  phase       text not null,
  position    integer not null,
  title       text not null,
  status      text not null default 'not' check (status in ('not', 'progress', 'done')),
  due         date,
  people      text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- One row per team plus the site admin. PINs are stored hashed, never as plain text.
create table if not exists public.pins (
  name             text primary key,
  is_admin         boolean not null default false,
  pin_hash         text not null,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz
);

-- Everyone can read tasks; nobody can write directly. All changes go through the functions below.
alter table public.tasks enable row level security;
alter table public.pins enable row level security;

drop policy if exists "Anyone can read tasks" on public.tasks;
create policy "Anyone can read tasks" on public.tasks for select to anon, authenticated using (true);

revoke all on public.pins from anon, authenticated;
revoke insert, update, delete on public.tasks from anon, authenticated;

-- PIN check ---------------------------------------------------------------
-- Returns null when the PIN is right, otherwise a message for the user.
-- 5 wrong PINs in a row locks that team out for 15 minutes.
-- Never raises an error, so the failed-attempt count is always saved.

create or replace function public._check_pin(p_name text, p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r public.pins;
begin
  select * into r from public.pins where name = p_name for update;
  if not found then
    return 'No PIN has been set up for this team yet.';
  end if;

  if r.locked_until is not null and r.locked_until > now() then
    return format('Too many wrong PINs. Try again in %s min.', ceil(extract(epoch from r.locked_until - now()) / 60));
  end if;

  if r.pin_hash = crypt(coalesce(p_pin, ''), r.pin_hash) then
    update public.pins set failed_attempts = 0, locked_until = null where name = p_name;
    return null;
  end if;

  if r.failed_attempts + 1 >= 5 then
    update public.pins set failed_attempts = 0, locked_until = now() + interval '15 minutes' where name = p_name;
    return 'Wrong PIN. Too many tries: locked for 15 min.';
  end if;

  update public.pins set failed_attempts = failed_attempts + 1 where name = p_name;
  return 'Wrong PIN.';
end;
$$;

-- Shared check for status and deadline changes: PIN must be right, and the team must be in charge (or admin).
create or replace function public._check_can_edit(p_name text, p_pin text, p_task_id text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  me public.pins;
  t public.tasks;
begin
  err := public._check_pin(p_name, p_pin);
  if err is not null then
    return err;
  end if;

  select * into me from public.pins where name = p_name;
  select * into t from public.tasks where id = p_task_id;
  if not found then
    return 'Task not found.';
  end if;

  if not me.is_admin and not (p_name = any(t.people)) then
    return 'Only the teams in charge of this task can change it.';
  end if;

  return null;
end;
$$;

revoke all on function public._check_pin(text, text) from public, anon, authenticated;
revoke all on function public._check_can_edit(text, text, text) from public, anon, authenticated;

-- Functions the website calls -----------------------------------------------
-- Each returns {"ok": true, ...} or {"ok": false, "error": "..."}.

create or replace function public.sign_in(p_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
begin
  err := public._check_pin(p_name, p_pin);
  if err is not null then
    return jsonb_build_object('ok', false, 'error', err);
  end if;
  return jsonb_build_object('ok', true, 'is_admin', (select is_admin from public.pins where name = p_name));
end;
$$;

create or replace function public.set_status(p_name text, p_pin text, p_task_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  t public.tasks;
begin
  if p_status is null or p_status not in ('not', 'progress', 'done') then
    return jsonb_build_object('ok', false, 'error', 'Unknown status.');
  end if;

  err := public._check_can_edit(p_name, p_pin, p_task_id);
  if err is not null then
    return jsonb_build_object('ok', false, 'error', err);
  end if;

  update public.tasks set status = p_status, updated_at = now(), updated_by = p_name
    where id = p_task_id returning * into t;
  return jsonb_build_object('ok', true, 'task', to_jsonb(t));
end;
$$;

create or replace function public.set_due(p_name text, p_pin text, p_task_id text, p_due date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  t public.tasks;
begin
  err := public._check_can_edit(p_name, p_pin, p_task_id);
  if err is not null then
    return jsonb_build_object('ok', false, 'error', err);
  end if;

  update public.tasks set due = p_due, updated_at = now(), updated_by = p_name
    where id = p_task_id returning * into t;
  return jsonb_build_object('ok', true, 'task', to_jsonb(t));
end;
$$;

-- Option B: any team can claim an unassigned task for itself; only the admin can reassign a taken task.
create or replace function public.set_people(p_name text, p_pin text, p_task_id text, p_people text[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  me public.pins;
  t public.tasks;
  new_people text[];
begin
  err := public._check_pin(p_name, p_pin);
  if err is not null then
    return jsonb_build_object('ok', false, 'error', err);
  end if;

  select * into me from public.pins where name = p_name;
  select * into t from public.tasks where id = p_task_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Task not found.');
  end if;

  new_people := array(select distinct unnest(coalesce(p_people, '{}')) order by 1);

  if exists (select unnest(new_people) except select name from public.pins where not is_admin) then
    return jsonb_build_object('ok', false, 'error', 'Unknown team in the list.');
  end if;

  if not me.is_admin then
    if cardinality(t.people) > 0 then
      return jsonb_build_object('ok', false, 'error', 'This task is already taken. Only the admin can reassign it.');
    end if;
    if new_people <> array[p_name] then
      return jsonb_build_object('ok', false, 'error', 'You can only claim an unassigned task for your own team.');
    end if;
  end if;

  update public.tasks set people = new_people, updated_at = now(), updated_by = p_name
    where id = p_task_id returning * into t;
  return jsonb_build_object('ok', true, 'task', to_jsonb(t));
end;
$$;

revoke all on function public.sign_in(text, text) from public;
revoke all on function public.set_status(text, text, text, text) from public;
revoke all on function public.set_due(text, text, text, date) from public;
revoke all on function public.set_people(text, text, text, text[]) from public;
grant execute on function public.sign_in(text, text) to anon, authenticated;
grant execute on function public.set_status(text, text, text, text) to anon, authenticated;
grant execute on function public.set_due(text, text, text, date) to anon, authenticated;
grant execute on function public.set_people(text, text, text, text[]) to anon, authenticated;

-- Tasks from "Victory Foodservice 2027 Food Show & Marketing Plan" ------------
-- Existing tasks are left untouched.

insert into public.tasks (id, phase, position, title) values
  ('1-1', 'Ownership & Planning', 1, 'Get GM to confirm Marketing owns the 2027 food show and vendor program'),
  ('1-2', 'Ownership & Planning', 2, 'Route all show ideas and designs through Marketing (single plan, single approver)'),
  ('1-3', 'Ownership & Planning', 3, 'Hire a freelance event producer'),
  ('1-4', 'Ownership & Planning', 4, 'Set a 12-month timeline with firm deadlines'),
  ('1-5', 'Ownership & Planning', 5, 'Hold one review meeting per milestone (no on-the-spot design changes)'),
  ('1-6', 'Ownership & Planning', 6, 'Run post-mortem survey of 2026 vendors and customers'),
  ('2-1', 'Data to Collect from Management', 7, '2026 show total cost'),
  ('2-2', 'Data to Collect from Management', 8, '2026 vendor revenue by package and booth'),
  ('2-3', 'Data to Collect from Management', 9, 'Orders placed at or because of the 2026 show'),
  ('2-4', 'Data to Collect from Management', 10, 'Vendors who didn''t return from 2025 and why'),
  ('2-5', 'Data to Collect from Management', 11, 'Active accounts and accounts that ordered in the last 90 days'),
  ('2-6', 'Data to Collect from Management', 12, 'Customer mix by type and borough/state'),
  ('2-7', 'Data to Collect from Management', 13, 'Promotions and whether show-only pricing is allowed'),
  ('2-8', 'Data to Collect from Management', 14, 'Unused vendor co-op or allowance funds'),
  ('3-1', 'Venue & Date', 15, 'Request quotes: New York Expo Center (Hunts Point), Yankee Stadium, Meadowlands, Victory facility tent'),
  ('3-2', 'Venue & Date', 16, 'Confirm Expo Center capacity, booth count, parking, power and cooking rules'),
  ('3-3', 'Venue & Date', 17, 'Plan outdoor tent cooking area (FDNY permits, power, fire safety)'),
  ('3-4', 'Venue & Date', 18, 'Choose date: mid-September 2027, Monday or Tuesday, 11am–5pm'),
  ('3-5', 'Venue & Date', 19, 'Avoid conflicts (IRFSNY March, Fancy Food June, Restaurant Week, Driscoll late Sept)'),
  ('3-6', 'Venue & Date', 20, 'Sign venue contract by December 2026'),
  ('3-7', 'Venue & Date', 21, 'Parking signage and wayfinding from highway and subway'),
  ('4-1', 'Vendor Packages', 22, 'Get GM approval on 2027 packages (Bronze digital, Silver, Gold, Platinum, Presenting)'),
  ('4-2', 'Vendor Packages', 23, 'Confirm booth-only price ($3,500) and booth sizes against venue floor plan'),
  ('4-3', 'Vendor Packages', 24, 'Send save-the-date and packages to vendors'),
  ('4-4', 'Vendor Packages', 25, 'Offer early commit discount (sign by Jan 31, 2027)'),
  ('4-5', 'Vendor Packages', 26, 'Lock Presenting Sponsor and Platinum vendors first'),
  ('4-6', 'Vendor Packages', 27, 'Require at least one new item per exhibiting vendor'),
  ('4-7', 'Vendor Packages', 28, 'Require one show only deal per vendor for the deal book'),
  ('4-8', 'Vendor Packages', 29, 'Ask vendors for menu/recipe ideas with food cost and profit'),
  ('4-9', 'Vendor Packages', 30, 'Encourage product giveaways instead of promo items'),
  ('4-10', 'Vendor Packages', 31, 'Sell show sponsorships (lanyards, totes, lounge, shuttle, photo wall, awards)'),
  ('4-11', 'Vendor Packages', 32, 'Sell tech zone kiosks to POS, payments, insurance companies'),
  ('4-12', 'Vendor Packages', 33, 'Deliver post-show ROI reports to vendors within 30 days'),
  ('4-13', 'Vendor Packages', 34, 'Track every promoted item with a code in Target'),
  ('5-1', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 35, 'Have CRM ready to make tasks easier and trackable'),
  ('5-2', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 36, 'Build bilingual registration page with QR code'),
  ('5-3', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 37, 'Set sales rep registration quotas, leaderboard and incentives'),
  ('5-4', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 38, 'Have someone visit customers in person to invite them'),
  ('5-5', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 39, 'Customer service phone outreach to lapsed and small accounts'),
  ('5-6', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 40, 'Drivers hand out bilingual invites with deliveries (6 weeks before)'),
  ('5-7', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 41, 'Build prospect list of local restaurants, delis, bodegas, caterers, food trucks'),
  ('5-8', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 42, 'Give each vendor VIP invite codes for their own customers'),
  ('5-9', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 43, 'Partner outreach: NYS Restaurant Assoc., NYC Hospitality Alliance, NJRHA, Bronx Chamber, culinary schools etc'),
  ('5-10', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 44, 'Spanish first creative and WhatsApp broadcast'),
  ('5-11', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 45, 'Text/email reminders at 60, 30, 7 and 1 days before'),
  ('5-12', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 46, 'Post-show discount only for checked-in attendees'),
  ('5-13', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 47, 'Referral credit for bringing a non-customer business'),
  ('5-14', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 48, 'Early-bird only registration prizes'),
  ('5-15', 'Attendance (Goal: 1,000+ buyers, ~1,800 registrations)', 49, 'Shuttle from key subway hubs if needed'),
  ('6-1', 'Social Media & Promotion', 50, 'Promote the show year-round using past show photos and videos'),
  ('6-2', 'Social Media & Promotion', 51, 'Ask vendors and brokers to share show posts'),
  ('6-3', 'Social Media & Promotion', 52, 'Invite Bronx/NYC food creators (English and Spanish)'),
  ('6-4', 'Social Media & Promotion', 53, 'Pitch Bronx Times and Spanish-language media'),
  ('6-5', 'Social Media & Promotion', 54, 'Branded hashtag and photo wall'),
  ('7-1', 'Show Experience', 55, 'Pick theme (Sophia suggested "The Next Big Bite") but that is the baldor name'),
  ('7-2', 'Show Experience', 56, 'Zone the floor by category, plus Emerging Brands and Tech zones'),
  ('7-3', 'Show Experience', 57, 'Book bilingual host/emcee'),
  ('7-4', 'Show Experience', 58, 'Book headliner chef for a fixed-time talk'),
  ('7-5', 'Show Experience', 59, 'Chef demos using Victory private label products'),
  ('7-6', 'Show Experience', 60, 'Vendor stage demos and seminars (food cost, social media, delivery apps, tech)'),
  ('7-7', 'Show Experience', 61, 'New-product passport with stickers and prize draws'),
  ('7-8', 'Show Experience', 62, 'Interactive booths: demos, taste challenges, recipe cards and games at booths'),
  ('7-9', 'Show Experience', 63, 'Show deal book (print and digital), Deal of the Hour, truckload sale'),
  ('7-10', 'Show Experience', 64, 'Live market-price board'),
  ('7-11', 'Show Experience', 65, 'Pepper ordering station with first order discount'),
  ('7-12', 'Show Experience', 66, 'Food truck area and beverage lounge'),
  ('7-13', 'Show Experience', 67, 'Awards: Vendor, New Product, Customer, Rep of the Year'),
  ('7-14', 'Show Experience', 68, 'Charity tie-in (donate surplus to a Bronx food bank or some greek senior center etc)'),
  ('7-15', 'Show Experience', 69, 'Preprinted Badge scanning at entry and booths'),
  ('7-16', 'Show Experience', 70, 'Same day entry of show orders into Target staff dedicated to entering orders onsite.'),
  ('8-1', 'Year-Round Marketing', 71, 'Set up CRM import customers, tag by type, borough and language, setup sales'),
  ('8-2', 'Year-Round Marketing', 72, 'Collect and record email/SMS consent for every customer'),
  ('8-3', 'Year-Round Marketing', 73, 'Launch weekly market-price email/SMS (sponsored) in January'),
  ('8-4', 'Year-Round Marketing', 74, '"Stock market" style price view on website or ordering store'),
  ('8-5', 'Year-Round Marketing', 75, 'Monthly customer newsletter (English and Spanish)'),
  ('8-6', 'Year-Round Marketing', 76, 'New-customer welcome email/SMS sequence'),
  ('8-7', 'Year-Round Marketing', 77, 'Win back campaign for lapsed accounts'),
  ('8-8', 'Year-Round Marketing', 78, 'Customer referral program (credit for referring a business)'),
  ('8-9', 'Year-Round Marketing', 79, 'Customer loyalty program'),
  ('8-10', 'Year-Round Marketing', 80, 'Social media content calendar (weekly posts, reels, vendor features)'),
  ('8-11', 'Year-Round Marketing', 81, 'Photo and video shoot of private label products'),
  ('8-12', 'Year-Round Marketing', 82, 'Announce new products monthly (email, social, rep flyers)'),
  ('8-13', 'Year-Round Marketing', 83, 'Seasonal campaigns (holidays, summer, Lent seafood, Ramadan, Hispanic Heritage)'),
  ('8-14', 'Year-Round Marketing', 84, 'Customer success stories (real restaurants using Victory products)'),
  ('8-15', 'Year-Round Marketing', 85, 'Sales rep toolkit: sell sheets, digital catalog, monthly promo flyer'),
  ('8-16', 'Year-Round Marketing', 86, 'Optimize Google Business Profile and request customer reviews'),
  ('8-17', 'Year-Round Marketing', 87, 'Website SEO pages by borough and business type'),
  ('8-18', 'Year-Round Marketing', 88, 'Truck wraps / branding on the 30-truck fleet'),
  ('8-19', 'Year-Round Marketing', 89, 'Partner with a recipe/plate-cost tool (meez or MarginEdge)'),
  ('8-20', 'Year-Round Marketing', 90, 'Plan replacement ordering platform pepper (launch sample)'),
  ('8-21', 'Year-Round Marketing', 91, 'Customer satisfaction survey twice a year'),
  ('8-22', 'Year-Round Marketing', 92, 'Monthly marketing report to GM (campaign results, new accounts, vendor revenue)'),
  ('9-1', 'Food Fest Depot', 93, 'Get owner approval to market Victory to depot members'),
  ('9-2', 'Food Fest Depot', 94, 'Check membership terms for sharing data between companies'),
  ('9-3', 'Food Fest Depot', 95, 'Opt-in signs and QR code at depot registers'),
  ('9-4', 'Food Fest Depot', 96, 'Add "send me Victory deals" checkbox to membership form'),
  ('9-5', 'Food Fest Depot', 97, 'Email existing members (with unsubscribe link)'),
  ('9-6', 'Food Fest Depot', 98, 'QR code on receipts and in bags'),
  ('9-7', 'Food Fest Depot', 99, 'Invite depot members to the food show'),
  ('9-8', 'Food Fest Depot', 100, 'Get POS data (member count, spend, visit frequency, business members) for revenue estimate'),
  ('10-1', 'Measurement', 101, 'Track: unique buyers, accounts represented, prospects attending'),
  ('10-2', 'Measurement', 102, 'Track: buyers per exhibitor (target 10+)'),
  ('10-3', 'Measurement', 103, 'Track: show orders, new accounts within 60 days, new Pepper users'),
  ('10-4', 'Measurement', 104, 'Track: vendor revenue, vendor renewal for 2028'),
  ('10-5', 'Measurement', 105, 'Post-show surveys for attendees and vendors')
on conflict (id) do nothing;
