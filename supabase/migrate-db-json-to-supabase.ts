/**
 * migrate-db-json-to-supabase.ts
 *
 * One-off script: reads your existing data/db.json (the flat-file store
 * server.ts currently writes to) and inserts every record into the new
 * Supabase Postgres tables created by 001_schema.sql.
 *
 * USAGE:
 *   1. npm install @supabase/supabase-js
 *   2. Set env vars (use the SERVICE ROLE key — this bypasses RLS, which is
 *      what you want for a bulk server-side import):
 *        SUPABASE_URL=https://xxxx.supabase.co
 *        SUPABASE_SERVICE_ROLE_KEY=ey...
 *   3. npx tsx migrate-db-json-to-supabase.ts
 *
 * NOTE on auth_user_id: this script inserts into `users` WITHOUT creating
 * matching Supabase Auth accounts (that requires real passwords / invite
 * flow). Run create-auth-users.ts (below) afterwards, per user, to wire up
 * auth_user_id once you decide your login flow (email/password, magic link,
 * or OTP via Africa's Talking for trainees without reliable email).
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DB_FILE = path.join(process.cwd(), 'data', 'db.json');

// Map old camelCase JSON keys -> new snake_case Postgres columns per table.
// Keeping this explicit (rather than a generic camel->snake converter)
// because a couple of fields are renamed/reshaped, not just re-cased.
function toUserRow(u: any) {
  return {
    id: u.id,
    role: u.role,
    full_name: u.fullName,
    email: u.email,
    phone: u.phone ?? null,
    profile_photo_url: u.profilePhotoUrl ?? null,
    is_active: u.isActive ?? true,
    is_approved_for_login: u.isApprovedForLogin ?? false,
    last_login_at: u.lastLoginAt ?? null,
    created_at: u.createdAt,
    updated_at: u.updatedAt,
  };
}

function toTraineeRow(tp: any) {
  return {
    id: tp.id,
    user_id: tp.userId,
    admission_no: tp.admissionNo,
    course_code: tp.courseCode,
    course_name: tp.courseName,
    cohort: tp.cohort,
    attachment_duration_weeks: tp.attachmentDurationWeeks,
    eligibility_status: tp.eligibilityStatus,
    fee_paid: tp.feePaid ?? false,
    created_at: tp.createdAt,
  };
}

// Ensure profiles matching schema
function toOfficerRow(op: any) {
  return {
    id: op.id,
    user_id: op.userId,
    employee_no: op.employeeNo,
    department: op.department,
    specialization: op.specialization ?? null,
    assigned_regions: op.assignedRegions ?? [],
    completed_assessments_count: op.completedAssessmentsCount ?? 0,
    office_room: op.officeRoom ?? null,
    availability_status: op.availabilityStatus ?? 'AVAILABLE',
    created_at: op.createdAt,
  };
}

function toSupervisorRow(sp: any) {
  return {
    id: sp.id,
    user_id: sp.userId,
    company_name: sp.companyName,
    job_title: sp.jobTitle ?? null,
    department: sp.department ?? null,
    work_email: sp.workEmail ?? null,
    work_phone: sp.workPhone ?? null,
    office_location: sp.officeLocation ?? null,
    max_trainees_capacity: sp.maxTraineesCapacity ?? 5,
    current_assigned_trainees_count: sp.currentAssignedTraineesCount ?? 0,
    created_at: sp.createdAt,
  };
}

function toAdminRow(ap: any) {
  return {
    id: ap.id,
    user_id: ap.userId,
    admin_staff_code: ap.adminStaffCode,
    portfolio: ap.portfolio ?? null,
    permissions_role: ap.permissionsRole ?? 'AUDITOR',
    office_extension: ap.officeExtension ?? null,
    desk_location: ap.deskLocation ?? null,
    created_at: ap.createdAt,
  };
}

function toPlacementRow(p: any) {
  return {
    id: p.id,
    trainee_id: p.traineeId,
    company_name: p.companyName,
    company_address: p.companyAddress ?? null,
    supervisor_id: p.supervisorId ?? null,
    supervisor_name: p.supervisorName ?? null,
    supervisor_phone: p.supervisorPhone ?? null,
    supervisor_email: p.supervisorEmail ?? null,
    location_lat: p.locationLat ?? null,
    location_lng: p.locationLng ?? null,
    county: p.county ?? null,
    start_date: p.startDate ?? null,
    end_date: p.endDate ?? null,
    status: p.status,
    assigned_officer_id: p.assignedOfficerId ?? null,
    acceptance_letter_url: p.acceptanceLetterUrl ?? null,
    ilo_letter_url: p.iloLetterUrl ?? null,
    is_locked: p.isLocked ?? false,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function toLogbookRow(e: any) {
  return {
    id: e.id,
    placement_id: e.placementId,
    entry_date: e.entryDate,
    week_number: e.weekNumber,
    activities_description: e.activitiesDescription,
    skills_acquired: e.skillsAcquired ?? null,
    tools_used: e.toolsUsed ?? null,
    supervisor_name: e.supervisorName ?? null,
    file_urls: e.fileUrls ?? [],
    file_hashes: e.fileHashes ?? [],
    status: e.status,
    version: e.version ?? 1,
    is_late: e.isLate ?? false,
    parent_entry_id: e.parentEntryId ?? null,
    officer_comments: e.officerComments ?? null,
    rubric_scores: e.rubricScores ?? {},
    reviewed_at: e.reviewedAt ?? null,
    reviewed_by: e.reviewedBy ?? null,
    supervisor_acknowledged: e.supervisorAcknowledged ?? false,
    supervisor_comment: e.supervisorComment ?? null,
    supervisor_acknowledged_at: e.supervisorAcknowledgedAt ?? null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

function toAssessmentRow(a: any) {
  return {
    id: a.id,
    placement_id: a.placementId,
    officer_id: a.officerId,
    visit_date: a.visitDate,
    physical_logbook_present: a.physicalLogbookPresent ?? false,
    entries_match_uploads: a.entriesMatchUploads ?? false,
    supervisor_confirmed: a.supervisorConfirmed ?? false,
    discrepancy_notes: a.discrepancyNotes ?? null,
    practical_notes: a.practicalNotes ?? null,
    overall_score: a.overallScore,
    site_evidence_urls: a.siteEvidenceUrls ?? [],
    credibility_authorized: a.credibilityAuthorized ?? false,
    authorized_at: a.authorizedAt ?? null,
    officer_signature_url: a.officerSignatureUrl ?? null,
    created_at: a.createdAt,
  };
}

function toAttendanceRow(r: any) {
  return {
    id: r.id,
    placement_id: r.placementId,
    trainee_id: r.traineeId,
    date: r.date,
    day_of_week: r.dayOfWeek,
    status: r.status,
    marked_by: r.markedBy ?? null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function toDocumentRow(d: any) {
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    version: d.version,
    file_url: d.fileUrl,
    file_hash: d.fileHash ?? null,
    visibility: d.visibility,
    visibility_filter: d.visibilityFilter ?? null,
    effective_from: d.effectiveFrom ?? null,
    effective_to: d.effectiveTo ?? null,
    download_policy: d.downloadPolicy,
    download_limit: d.downloadLimit ?? null,
    is_active: d.isActive ?? true,
    uploaded_by: d.uploadedBy,
    validation_code: d.validationCode ?? null,
    created_at: d.createdAt,
  };
}

function toEntitlementRow(e: any) {
  return {
    id: e.id,
    document_id: e.documentId,
    user_id: e.userId,
    downloads_used: e.downloadsUsed ?? 0,
    last_download_at: e.lastDownloadAt ?? null,
    reset_by: e.resetBy ?? null,
    reset_at: e.resetAt ?? null,
  };
}

function toDownloadEventRow(d: any) {
  return {
    id: d.id,
    document_id: d.documentId,
    user_id: d.userId,
    document_version: d.documentVersion ?? null,
    ip_address: d.ipAddress ?? null,
    user_agent: d.userAgent ?? null,
    success: d.success ?? true,
    created_at: d.createdAt,
  };
}

function toNotificationRow(n: any) {
  return {
    id: n.id,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    is_read: n.isRead ?? false,
    related_entity_type: n.relatedEntityType ?? null,
    related_entity_id: n.relatedEntityId ?? null,
    created_at: n.createdAt,
  };
}

function toAuditRow(a: any) {
  return {
    id: a.id,
    user_id: a.userId ?? null,
    action: a.action,
    entity_type: a.entityType ?? null,
    entity_id: a.entityId ?? null,
    old_values: safeJson(a.oldValues),
    new_values: safeJson(a.newValues),
    metadata: safeJson(a.metadata),
    ip_address: a.ipAddress ?? null,
    created_at: a.createdAt,
  };
}

function toSmsRow(s: any) {
  return {
    id: s.id,
    phone_number: s.phoneNumber,
    message: s.message,
    sender_id: s.senderId ?? null,
    status: s.status,
    created_at: s.createdAt,
  };
}

// old code stored oldValues/newValues/metadata as plain strings in some
// places; jsonb column accepts either a JSON string or an object, but guard
// against malformed strings so the whole migration doesn't abort on one row.
function safeJson(v: any) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return { raw: String(v) }; }
}

async function insertBatch(table: string, rows: any[], mapper: (r: any) => any) {
  if (!rows || rows.length === 0) {
    console.log(`  ${table}: 0 rows, skipping`);
    return;
  }
  const mapped = rows.map(mapper);
  const BATCH = 500; // Supabase/Postgres prefer chunked inserts for big seed data
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) {
      console.error(`  ERROR inserting into ${table} (batch ${i}-${i + chunk.length}):`, error.message);
      throw error;
    }
  }
  console.log(`  ${table}: inserted ${mapped.length} rows`);
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`No db.json found at ${DB_FILE}. Nothing to migrate.`);
    process.exit(1);
  }

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  console.log('Starting migration to Supabase...\n');

  // Order matters: parents before children (FK constraints).
  await insertBatch('users', db.users, toUserRow);
  await insertBatch('trainee_profiles', db.traineeProfiles, toTraineeRow);
  await insertBatch('officer_profiles', db.officerProfiles, toOfficerRow);
  await insertBatch('supervisor_profiles', db.supervisorProfiles, toSupervisorRow);
  await insertBatch('admin_profiles', db.adminProfiles, toAdminRow);
  await insertBatch('placements', db.placements, toPlacementRow);
  await insertBatch('logbook_entries', db.logbookEntries, toLogbookRow);
  await insertBatch('assessments', db.assessments, toAssessmentRow);
  await insertBatch('attendance_records', db.attendanceRecords, toAttendanceRow);
  await insertBatch('institutional_documents', db.documents, toDocumentRow);
  await insertBatch('document_entitlements', db.documentEntitlements, toEntitlementRow);
  await insertBatch('download_events', db.downloadEvents, toDownloadEventRow);
  await insertBatch('app_notifications', db.notifications, toNotificationRow);
  await insertBatch('audit_logs', db.auditLogs, toAuditRow);
  await insertBatch('sms_logs', db.smsLogs, toSmsRow);

  if (db.systemSettings) {
    const s = db.systemSettings;
    const { error } = await supabase
      .from('system_settings')
      .update({
        institution_name: s.institutionName,
        attachment_duration_weeks: s.attachmentDurationWeeks,
        late_window_hours: s.lateWindowHours,
        sms_username: s.smsUsername,
        sms_sender_id: s.smsSenderId,
        fee_collection_enabled: s.feeCollectionEnabled,
        fee_amount: s.feeAmount,
        force_2fa: s.force2FA,
      })
      .eq('id', true);
    if (error) console.error('  ERROR updating system_settings:', error.message);
    else console.log('  system_settings: updated singleton row');
  }

  console.log('\nMigration complete.');
}

main().catch((err) => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
