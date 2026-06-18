-- Supabase schema for ASSESSLINK

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  phone TEXT,
  profile_photo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_approved_for_login BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS trainee_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admission_no TEXT NOT NULL,
  course_code TEXT NOT NULL,
  course_name TEXT NOT NULL,
  cohort TEXT NOT NULL,
  attachment_duration_weeks INTEGER NOT NULL,
  eligibility_status TEXT NOT NULL,
  fee_paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS officer_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_no TEXT NOT NULL,
  department TEXT NOT NULL,
  specialization TEXT NOT NULL,
  assigned_regions TEXT[] NOT NULL,
  completed_assessments_count INTEGER NOT NULL,
  office_room TEXT NOT NULL,
  availability_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS supervisor_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  department TEXT NOT NULL,
  work_email TEXT NOT NULL,
  work_phone TEXT NOT NULL,
  office_location TEXT NOT NULL,
  max_trainees_capacity INTEGER NOT NULL,
  current_assigned_trainees_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_staff_code TEXT NOT NULL,
  portfolio TEXT NOT NULL,
  permissions_role TEXT NOT NULL,
  office_extension TEXT NOT NULL,
  desk_location TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS placements (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL REFERENCES trainee_profiles(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  company_address TEXT,
  supervisor_id TEXT REFERENCES users(id),
  supervisor_name TEXT,
  supervisor_phone TEXT,
  supervisor_email TEXT,
  location_lat NUMERIC,
  location_lng NUMERIC,
  county TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL,
  assigned_officer_id TEXT REFERENCES users(id),
  acceptance_letter_url TEXT,
  ilo_letter_url TEXT,
  is_locked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS logbook_entries (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  week_number INTEGER NOT NULL,
  activities_description TEXT NOT NULL,
  skills_acquired TEXT,
  tools_used TEXT,
  supervisor_name TEXT,
  file_urls TEXT[] NOT NULL,
  file_hashes TEXT[] NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_late BOOLEAN NOT NULL,
  parent_entry_id TEXT,
  officer_comments TEXT,
  rubric_scores JSONB,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  supervisor_acknowledged BOOLEAN NOT NULL,
  supervisor_comment TEXT,
  supervisor_acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES users(id),
  visit_date TEXT NOT NULL,
  physical_logbook_present BOOLEAN NOT NULL,
  entries_match_uploads BOOLEAN NOT NULL,
  supervisor_confirmed BOOLEAN NOT NULL,
  discrepancy_notes TEXT,
  practical_notes TEXT,
  overall_score INTEGER NOT NULL,
  site_evidence_urls TEXT[] NOT NULL,
  credibility_authorized BOOLEAN NOT NULL,
  authorized_at TIMESTAMPTZ,
  officer_signature_url TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS institutional_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  visibility TEXT NOT NULL,
  visibility_filter TEXT,
  effective_from TEXT,
  effective_to TEXT,
  download_policy TEXT NOT NULL,
  download_limit INTEGER,
  is_active BOOLEAN NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  validation_code TEXT
);

CREATE TABLE IF NOT EXISTS document_entitlements (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES institutional_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  downloads_used INTEGER NOT NULL,
  last_download_at TIMESTAMPTZ,
  reset_by TEXT,
  reset_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES institutional_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_version TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL,
  related_entity_type TEXT,
  related_entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  old_values TEXT,
  new_values TEXT,
  metadata TEXT,
  ip_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  message TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  trainee_id TEXT NOT NULL REFERENCES trainee_profiles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  day_of_week TEXT NOT NULL,
  status TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  institution_name TEXT NOT NULL,
  attachment_duration_weeks INTEGER NOT NULL,
  late_window_hours INTEGER NOT NULL,
  sms_api_key TEXT NOT NULL,
  sms_username TEXT NOT NULL,
  sms_sender_id TEXT NOT NULL,
  fee_collection_enabled BOOLEAN NOT NULL,
  fee_amount INTEGER NOT NULL,
  force_2fa BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
