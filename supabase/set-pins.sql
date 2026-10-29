-- Set or change PINs.
--
-- 1. In Supabase > SQL Editor, paste this file.
-- 2. Replace 0000 with a 4-digit PIN for each row you want to set (use a different PIN for each).
--    Rows left as 0000 are skipped, so to change one PIN later just fill in that one row.
-- 3. Click Run.
-- 4. Don't save this query in Supabase, and don't put real PINs in this file on GitHub.
--
-- "Site Admin" is your personal admin PIN: it can edit and reassign any task.

with new_pins(name, pin, is_admin) as (values
  ('Marketing',  '0000', false),
  ('Sales',      '0000', false),
  ('Buyers',     '0000', false),
  ('Admin',      '0000', false),
  ('CService',   '0000', false),
  ('IT',         '0000', false),
  ('Site Admin', '0000', true)
)
insert into public.pins (name, pin_hash, is_admin)
select name, extensions.crypt(pin, extensions.gen_salt('bf')), is_admin
from new_pins
where pin ~ '^[0-9]{4}$' and pin <> '0000'
on conflict (name) do update
  set pin_hash = excluded.pin_hash,
      is_admin = excluded.is_admin,
      failed_attempts = 0,
      locked_until = null;

-- Shows which PINs are set (not the PINs themselves).
select name, is_admin from public.pins order by is_admin, name;
