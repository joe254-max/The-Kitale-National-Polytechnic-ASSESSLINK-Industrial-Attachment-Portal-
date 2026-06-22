-- ============================================================================
-- ASSESSLINK — Row Level Security
-- Run this AFTER 001_schema.sql
-- Assumes you switch login to Supabase Auth (auth.uid()), with `users.auth_user_id`
-- linking each app user row to their Supabase Auth identity.
-- ============================================================================

-- Helper: get the app-level users.id and role for the currently logged-in
-- Supabase Auth user. Used inside policies below.
create or replace function current_app_user_id()
returns uuid language sql stable as $$
  select id from users where auth_user_id = auth.uid()
$$;

create or replace function current_app_role()
returns user_role language sql stable as $$
  select role from users where auth_user_id = auth.uid()
$$;

-- Turn on RLS everywhere
alter table users enable row level security;
alter table trainee_profiles enable row level security;
alter table officer_profiles enable row level security;
alter table supervisor_profiles enable row level security;
alter table admin_profiles enable row level security;
alter table placements enable row level security;
alter table logbook_entries enable row level security;
alter table assessments enable row level security;
alter table attendance_records enable row level security;
alter table institutional_documents enable row level security;
alter table document_entitlements enable row level security;
alter table download_events enable row level security;
alter table app_notifications enable row level security;
alter table audit_logs enable row level security;
alter table sms_logs enable row level security;
alter table system_settings enable row level security;

-- ---------------------------------------------------------------------------
-- USERS: everyone can read their own row; admins read/write all.
-- ---------------------------------------------------------------------------
create policy users_select_self on users for select
  using (auth_user_id = auth.uid() or current_app_role() = 'ADMIN');
create policy users_admin_write on users for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');
create policy users_update_self on users for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- TRAINEE PROFILES: trainee sees/edits own; officers & admins see all;
-- supervisors see only trainees they're currently placed with (via join).
-- ---------------------------------------------------------------------------
create policy trainee_self on trainee_profiles for select
  using (user_id = current_app_user_id());
create policy trainee_staff_read on trainee_profiles for select
  using (current_app_role() in ('OFFICER','ADMIN'));
create policy trainee_supervisor_read on trainee_profiles for select
  using (
    current_app_role() = 'SUPERVISOR'
    and exists (
      select 1 from placements p
      join supervisor_profiles sp on sp.id = p.supervisor_id
      where p.trainee_id = trainee_profiles.id
        and sp.user_id = current_app_user_id()
    )
  );
create policy trainee_admin_write on trainee_profiles for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

-- ---------------------------------------------------------------------------
-- OFFICER / SUPERVISOR / ADMIN PROFILES: self + admin
-- ---------------------------------------------------------------------------
create policy officer_self on officer_profiles for select
  using (user_id = current_app_user_id() or current_app_role() = 'ADMIN');
create policy officer_admin_write on officer_profiles for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

create policy supervisor_self on supervisor_profiles for select
  using (user_id = current_app_user_id() or current_app_role() in ('OFFICER','ADMIN'));
create policy supervisor_admin_write on supervisor_profiles for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

create policy admin_profile_self on admin_profiles for select
  using (user_id = current_app_user_id() or current_app_role() = 'ADMIN');
create policy admin_profile_write on admin_profiles for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

-- ---------------------------------------------------------------------------
-- PLACEMENTS: trainee sees own; assigned officer sees theirs; assigned
-- supervisor sees theirs; admin sees all.
-- ---------------------------------------------------------------------------
create policy placement_trainee_read on placements for select
  using (
    exists (select 1 from trainee_profiles tp
            where tp.id = placements.trainee_id and tp.user_id = current_app_user_id())
  );
create policy placement_officer_read on placements for select
  using (
    current_app_role() = 'OFFICER'
    and exists (select 1 from officer_profiles op
                where op.id = placements.assigned_officer_id and op.user_id = current_app_user_id())
  );
create policy placement_supervisor_read on placements for select
  using (
    current_app_role() = 'SUPERVISOR'
    and exists (select 1 from supervisor_profiles sp
                where sp.id = placements.supervisor_id and sp.user_id = current_app_user_id())
  );
create policy placement_admin_all on placements for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');
create policy placement_officer_write on placements for update
  using (
    current_app_role() = 'OFFICER'
    and exists (select 1 from officer_profiles op
                where op.id = placements.assigned_officer_id and op.user_id = current_app_user_id())
  );

-- ---------------------------------------------------------------------------
-- LOGBOOK ENTRIES: trainee writes/reads own (via placement); officer reads/
-- reviews assigned; supervisor reads & acknowledges assigned.
-- ---------------------------------------------------------------------------
create policy logbook_trainee on logbook_entries for all
  using (
    exists (
      select 1 from placements p join trainee_profiles tp on tp.id = p.trainee_id
      where p.id = logbook_entries.placement_id and tp.user_id = current_app_user_id()
    )
  )
  with check (
    exists (
      select 1 from placements p join trainee_profiles tp on tp.id = p.trainee_id
      where p.id = logbook_entries.placement_id and tp.user_id = current_app_user_id()
    )
  );
create policy logbook_officer_read on logbook_entries for select
  using (
    current_app_role() = 'OFFICER'
    and exists (
      select 1 from placements p join officer_profiles op on op.id = p.assigned_officer_id
      where p.id = logbook_entries.placement_id and op.user_id = current_app_user_id()
    )
  );
create policy logbook_officer_review on logbook_entries for update
  using (
    current_app_role() = 'OFFICER'
    and exists (
      select 1 from placements p join officer_profiles op on op.id = p.assigned_officer_id
      where p.id = logbook_entries.placement_id and op.user_id = current_app_user_id()
    )
  );
create policy logbook_supervisor_read on logbook_entries for select
  using (
    current_app_role() = 'SUPERVISOR'
    and exists (
      select 1 from placements p join supervisor_profiles sp on sp.id = p.supervisor_id
      where p.id = logbook_entries.placement_id and sp.user_id = current_app_user_id()
    )
  );
create policy logbook_admin on logbook_entries for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

-- ---------------------------------------------------------------------------
-- ASSESSMENTS: officer who created it + admin + the trainee being assessed
-- ---------------------------------------------------------------------------
create policy assessment_officer on assessments for all
  using (
    exists (select 1 from officer_profiles op
            where op.id = assessments.officer_id and op.user_id = current_app_user_id())
  )
  with check (
    exists (select 1 from officer_profiles op
            where op.id = assessments.officer_id and op.user_id = current_app_user_id())
  );
create policy assessment_trainee_read on assessments for select
  using (
    exists (
      select 1 from placements p join trainee_profiles tp on tp.id = p.trainee_id
      where p.id = assessments.placement_id and tp.user_id = current_app_user_id()
    )
  );
create policy assessment_admin on assessments for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

-- ---------------------------------------------------------------------------
-- ATTENDANCE: trainee reads own; officer/supervisor of that placement read+mark
-- ---------------------------------------------------------------------------
create policy attendance_trainee_read on attendance_records for select
  using (
    exists (select 1 from trainee_profiles tp
            where tp.id = attendance_records.trainee_id and tp.user_id = current_app_user_id())
  );
create policy attendance_staff_write on attendance_records for all
  using (current_app_role() in ('OFFICER','SUPERVISOR','ADMIN'))
  with check (current_app_role() in ('OFFICER','SUPERVISOR','ADMIN'));

-- ---------------------------------------------------------------------------
-- DOCUMENTS: readable by everyone if active+visible; writable by admin only
-- ---------------------------------------------------------------------------
create policy documents_read_active on institutional_documents for select
  using (is_active = true);
create policy documents_admin_write on institutional_documents for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

create policy entitlements_self on document_entitlements for select
  using (user_id = current_app_user_id() or current_app_role() = 'ADMIN');
create policy entitlements_admin_write on document_entitlements for all
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');

create policy downloads_self on download_events for select
  using (user_id = current_app_user_id() or current_app_role() = 'ADMIN');
create policy downloads_insert_self on download_events for insert
  with check (user_id = current_app_user_id());

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS: only your own
-- ---------------------------------------------------------------------------
create policy notifications_self on app_notifications for all
  using (user_id = current_app_user_id())
  with check (user_id = current_app_user_id());

-- ---------------------------------------------------------------------------
-- AUDIT / SMS LOGS: admin only (these are compliance/forensic records)
-- ---------------------------------------------------------------------------
create policy audit_admin_only on audit_logs for select
  using (current_app_role() = 'ADMIN');
create policy sms_admin_only on sms_logs for select
  using (current_app_role() = 'ADMIN');

-- ---------------------------------------------------------------------------
-- SYSTEM SETTINGS: everyone can read (frontend needs fee amount etc),
-- only admin can write
-- ---------------------------------------------------------------------------
create policy settings_read_all on system_settings for select using (true);
create policy settings_admin_write on system_settings for update
  using (current_app_role() = 'ADMIN')
  with check (current_app_role() = 'ADMIN');
