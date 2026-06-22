-- ============================================================================
-- ASSESSLINK / KNPSS Link — Supabase Postgres Schema
-- Replaces the flat-file data/db.json store with a real relational database.
-- Run this in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================================

-- Extensions ------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- Enum types --------------------------------------------------------------
create type user_role as enum ('TRAINEE','OFFICER','SUPERVISOR','ADMIN');
create type placement_status as enum ('UNPLACED','PLACED','ACTIVE','ASSESSED','COMPLETED');
create type entry_status as enum ('DRAFT','SUBMITTED','APPROVED','REJECTED','CORRECTION_REQUESTED');
create type doc_category as enum ('INSURANCE','NITA','LETTER','POLICY','FORM','MANUAL','OTHER');
create type download_policy as enum ('UNLIMITED','VIEW_ONLY','SINGLE','N_DOWNLOADS');
create type doc_visibility as enum ('ALL','COHORT','PROGRAM');
create type eligibility_status as enum ('PENDING','ELIGIBLE','INELIGIBLE');
create type officer_availability as enum ('AVAILABLE','ON_FIELD_VISIT','ON_LEAVE','BUSY');
create type permissions_role as enum ('PRIMARY_OFFICER','AUDITOR','SYSTEM_ADMIN');
create type sms_status as enum ('SENT','FAILED');
create type attendance_status as enum ('Present','Absent','Half-Day');
create type day_of_week as enum ('Monday','Tuesday','Wednesday','Thursday','Friday');

-- ============================================================================
-- USERS  (mirrors Supabase Auth via auth_user_id; keep app-level table for
-- profile/role data that Auth doesn't store)
-- ============================================================================
create table users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  role user_role not null,
  full_name text not null,
  email text not null unique,
  phone text,
  profile_photo_url text,
  is_active boolean not null default true,
  is_approved_for_login boolean default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_users_role on users(role);
create index idx_users_email on users(lower(email));

-- ============================================================================
-- ROLE PROFILES (1:1 with users)
-- ============================================================================
create table trainee_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  admission_no text not null unique,
  course_code text not null,
  course_name text not null,
  cohort text not null,
  attachment_duration_weeks int not null default 12,
  eligibility_status eligibility_status not null default 'PENDING',
  fee_paid boolean default false,
  created_at timestamptz not null default now()
);
create index idx_trainee_cohort on trainee_profiles(cohort);
create index idx_trainee_course on trainee_profiles(course_code);

create table officer_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  employee_no text not null unique,
  department text not null,
  specialization text,
  assigned_regions text[] default '{}',
  completed_assessments_count int not null default 0,
  office_room text,
  availability_status officer_availability not null default 'AVAILABLE',
  created_at timestamptz not null default now()
);
create index idx_officer_regions on officer_profiles using gin(assigned_regions);

create table supervisor_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  company_name text not null,
  job_title text,
  department text,
  work_email text,
  work_phone text,
  office_location text,
  max_trainees_capacity int not null default 5,
  current_assigned_trainees_count int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_supervisor_company on supervisor_profiles(company_name);

create table admin_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  admin_staff_code text not null unique,
  portfolio text,
  permissions_role permissions_role not null default 'AUDITOR',
  office_extension text,
  desk_location text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- PLACEMENTS
-- ============================================================================
create table placements (
  id uuid primary key default gen_random_uuid(),
  trainee_id uuid not null references trainee_profiles(id) on delete cascade,
  company_name text not null,
  company_address text,
  supervisor_id uuid references supervisor_profiles(id),
  supervisor_name text,
  supervisor_phone text,
  supervisor_email text,
  location_lat double precision,
  location_lng double precision,
  county text,
  start_date date,
  end_date date,
  status placement_status not null default 'UNPLACED',
  assigned_officer_id uuid references officer_profiles(id),
  acceptance_letter_url text,
  ilo_letter_url text,
  is_locked boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_placements_trainee on placements(trainee_id);
create index idx_placements_officer on placements(assigned_officer_id);
create index idx_placements_supervisor on placements(supervisor_id);
create index idx_placements_status on placements(status);
create index idx_placements_county on placements(county);
-- geo lookups for the PlacementMap component (nearest-officer / region queries)
create index idx_placements_geo on placements(location_lat, location_lng);

-- ============================================================================
-- LOGBOOK ENTRIES
-- ============================================================================
create table logbook_entries (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references placements(id) on delete cascade,
  entry_date date not null,
  week_number int not null,
  activities_description text not null,
  skills_acquired text,
  tools_used text,
  supervisor_name text,
  file_urls text[] default '{}',
  file_hashes text[] default '{}',
  status entry_status not null default 'DRAFT',
  version int not null default 1,
  is_late boolean not null default false,
  parent_entry_id uuid references logbook_entries(id),
  officer_comments text,
  rubric_scores jsonb default '{}'::jsonb,
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  supervisor_acknowledged boolean not null default false,
  supervisor_comment text,
  supervisor_acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_logbook_placement on logbook_entries(placement_id);
create index idx_logbook_status on logbook_entries(status);
create index idx_logbook_week on logbook_entries(placement_id, week_number);

-- ============================================================================
-- ASSESSMENTS (officer site visits)
-- ============================================================================
create table assessments (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references placements(id) on delete cascade,
  officer_id uuid not null references officer_profiles(id),
  visit_date date not null,
  physical_logbook_present boolean default false,
  entries_match_uploads boolean default false,
  supervisor_confirmed boolean default false,
  discrepancy_notes text,
  practical_notes text,
  overall_score numeric(3,1) check (overall_score >= 0 and overall_score <= 10),
  site_evidence_urls text[] default '{}',
  credibility_authorized boolean default false,
  authorized_at timestamptz,
  officer_signature_url text,
  created_at timestamptz not null default now()
);
create index idx_assessments_placement on assessments(placement_id);
create index idx_assessments_officer on assessments(officer_id);

-- ============================================================================
-- ATTENDANCE
-- ============================================================================
create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references placements(id) on delete cascade,
  trainee_id uuid not null references trainee_profiles(id) on delete cascade,
  date date not null,
  day_of_week day_of_week not null,
  status attendance_status not null,
  marked_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (placement_id, date)
);
create index idx_attendance_trainee on attendance_records(trainee_id, date);

-- ============================================================================
-- INSTITUTIONAL DOCUMENTS, ENTITLEMENTS, DOWNLOAD EVENTS
-- ============================================================================
create table institutional_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category doc_category not null,
  version text not null,
  file_url text not null,
  file_hash text,
  visibility doc_visibility not null default 'ALL',
  visibility_filter text,
  effective_from date,
  effective_to date,
  download_policy download_policy not null default 'UNLIMITED',
  download_limit int,
  is_active boolean not null default true,
  uploaded_by uuid references users(id),
  validation_code text,
  created_at timestamptz not null default now()
);
create index idx_documents_category on institutional_documents(category);
create index idx_documents_active on institutional_documents(is_active);

create table document_entitlements (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references institutional_documents(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  downloads_used int not null default 0,
  last_download_at timestamptz,
  reset_by uuid references users(id),
  reset_at timestamptz,
  unique (document_id, user_id)
);

create table download_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references institutional_documents(id) on delete cascade,
  user_id uuid not null references users(id),
  document_version text,
  ip_address text,
  user_agent text,
  success boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_downloads_document on download_events(document_id);
create index idx_downloads_user on download_events(user_id);

-- ============================================================================
-- NOTIFICATIONS, AUDIT, SMS, USSD
-- ============================================================================
create table app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  is_read boolean not null default false,
  related_entity_type text,
  related_entity_id uuid,
  created_at timestamptz not null default now()
);
create index idx_notifications_user on app_notifications(user_id, is_read);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  metadata jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);
create index idx_audit_user on audit_logs(user_id);
create index idx_audit_entity on audit_logs(entity_type, entity_id);
create index idx_audit_created on audit_logs(created_at desc);

create table sms_logs (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  message text not null,
  sender_id text,
  status sms_status not null,
  created_at timestamptz not null default now()
);

create table ussd_sessions (
  session_id text primary key,
  phone_number text not null,
  network_code text,
  service_code text,
  text text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- SYSTEM SETTINGS (single-row config table instead of a loose object)
-- ============================================================================
create table system_settings (
  id boolean primary key default true check (id), -- enforces exactly one row
  institution_name text not null default 'Kenya National Polytechnic & Vocational Sciences',
  attachment_duration_weeks int not null default 12,
  late_window_hours int not null default 48,
  sms_username text,
  sms_sender_id text,
  fee_collection_enabled boolean not null default true,
  fee_amount numeric(10,2) not null default 1500,
  force_2fa boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into system_settings (id) values (true);

-- ============================================================================
-- updated_at auto-touch trigger (saves you from forgetting it in every route)
-- ============================================================================
create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_users_updated before update on users
  for each row execute function touch_updated_at();
create trigger trg_placements_updated before update on placements
  for each row execute function touch_updated_at();
create trigger trg_logbook_updated before update on logbook_entries
  for each row execute function touch_updated_at();
create trigger trg_attendance_updated before update on attendance_records
  for each row execute function touch_updated_at();
