/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ASSESSLINK / KNPSS Link — Express server, Supabase-backed.
 *
 * This replaces the original flat-file (data/db.json) store with real
 * Postgres queries against the schema in 001_schema.sql, and replaces local
 * disk file storage with Supabase Storage. Every route path and response
 * shape is kept identical to the original server.ts so the existing React
 * frontend does not need to change.
 *
 * NOT yet done here (see 003_notes.md, item 6): real password-based auth.
 * The /api/v1/auth/login route below preserves the ORIGINAL behavior
 * (look up by email, auto-create on first login, no password check) but
 * against Postgres instead of the JSON file. Swapping to Supabase Auth is
 * a separate, deliberate step — don't ship this auth flow to 50,000 real
 * users without doing that step first.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Clean quotes and whitespace from critical env vars to prevent "Invalid API key" and connection errors
const cleanEnvVar = (name: string) => {
  if (process.env[name]) {
    process.env[name] = process.env[name]!.replace(/^["']|["']$/g, '').trim();
  }
};
cleanEnvVar('SUPABASE_URL');
cleanEnvVar('SUPABASE_ANON_KEY');
cleanEnvVar('SUPABASE_SERVICE_ROLE_KEY');
cleanEnvVar('VITE_SUPABASE_URL');
cleanEnvVar('VITE_SUPABASE_ANON_KEY');

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { supabase, UPLOADS_BUCKET } from './supabaseClient';
import { createClient } from '@supabase/supabase-js';
import { Request, Response, NextFunction } from 'express';

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;

const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
for (const v of requiredEnvVars) {
  if (!process.env[v]) {
    console.warn(`Warning: Missing required env var: ${v} (Ignored during compile/init, but must be set at runtime)`);
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// camelCase <-> snake_case helpers
// Keeps every route's request/response shape identical to the original API
// while the database itself uses idiomatic snake_case columns.
// ============================================================================
function toSnakeCase(obj: any): any {
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`),
        toSnakeCase(v),
      ])
    );
  }
  return obj;
}
function toCamelCase(obj: any): any {
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase()),
        toCamelCase(v),
      ])
    );
  }
  return obj;
}

function randId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).substring(2, 11)}`;
}

// ============================================================================
// Shared helpers: audit log, notifications, SMS — now Postgres-backed
// ============================================================================
async function logAudit(
  userId: string | undefined,
  action: string,
  entityType?: string,
  entityId?: string,
  oldVals?: any,
  newVals?: any,
  ip: string = '127.0.0.1'
) {
  const { error } = await supabase.from('audit_logs').insert({
    user_id: userId ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    old_values: oldVals ?? null,
    new_values: newVals ?? null,
    ip_address: ip,
  });
  if (error) console.error('logAudit error:', error.message);
}

async function makeNotification(
  userId: string,
  type: string,
  title: string,
  body: string,
  entType?: string,
  entId?: string
) {
  const { error } = await supabase.from('app_notifications').insert({
    user_id: userId,
    type,
    title,
    body,
    is_read: false,
    related_entity_type: entType ?? null,
    related_entity_id: entId ?? null,
  });
  if (error) console.error('makeNotification error:', error.message);
}

async function getSystemSettings() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('*')
    .eq('id', true)
    .single();
  if (error) {
    console.error('getSystemSettings error:', error.message);
    return null;
  }
  return data;
}

async function sendSMS(phoneNumber: string, message: string) {
  const settings = await getSystemSettings();
  const senderId = settings?.sms_sender_id || 'KNPSS_LINK';
  await supabase.from('sms_logs').insert({
    phone_number: phoneNumber,
    message,
    sender_id: senderId,
    status: 'SENT',
  });
  console.log(`[SMS SIMULATION] To: ${phoneNumber} | From: ${senderId} | Content: "${message}"`);
}

// Creates a default trainee_profiles row for a freshly-created TRAINEE user.
// Mirrors the original seed/auto-signup behavior.
async function createDefaultTraineeProfile(userId: string, attachmentDurationWeeks: number) {
  const admissionNo = `KNPSS/ADMIT/${new Date().getFullYear()}/${Math.floor(1000 + Math.random() * 9000)}`;
  const { data, error } = await supabase
    .from('trainee_profiles')
    .insert({
      user_id: userId,
      admission_no: admissionNo,
      course_code: 'DICT',
      course_name: 'Diploma in Information Communication Technology',
      cohort: '2024 Intake',
      attachment_duration_weeks: attachmentDurationWeeks,
      eligibility_status: 'PENDING',
      fee_paid: false,
    })
    .select()
    .single();
  if (error) console.error('createDefaultTraineeProfile error:', error.message);
  return data;
}

// Generic error responder matching the original RFC7807-ish error shapes.
function problem(res: express.Response, status: number, title: string, detail: string) {
  return res.status(status).json({ type: 'about:blank', title, status, detail });
}

// ============================================================================
// 9.1 Authentication Endpoints
// ============================================================================
// ============================================================================
// Auth Middleware & Authentication Endpoints
// ============================================================================

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ title: 'Unauthorized', message: 'No token provided.' });
  }

  // Validate JWT via Supabase — getUser() verifies the token signature
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ title: 'Unauthorized', message: 'Invalid or expired session.' });
  }

  // Attach the Supabase auth user to the request for downstream use
  (req as any).authUser = user;
  next();
}

// Apply to ALL protected routes (everything except the /auth/* endpoints and USSD callback):
app.use('/api/v1', (req, res, next) => {
  const path = req.path;
  const publicPaths = [
    '/auth/login',
    '/auth/signup',
    '/auth/forgot-password',
    '/auth/verify-otp',
    '/auth/reset-password',
    '/ussd/callback'
  ];
  if (publicPaths.includes(path) || path.startsWith('/auth/')) {
    return next();
  }
  return requireAuth(req, res, next);
});

app.post('/api/v1/auth/signup', async (req, res) => {
  try {
    const { email, password, fullName, role, phone, ...profileFields } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ title: 'Bad Request', message: 'Email, password and Full Name are required.' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        title: 'Configuration Error',
        message: 'Supabase URL or Service Role Key is not configured. Please add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Secrets.'
      });
    }

    // 1. Validate role is allowed for self-registration
    const selfRegRoles = ['TRAINEE', 'SUPERVISOR'];
    const userRole = role || 'TRAINEE';
    if (!selfRegRoles.includes(userRole)) {
      return res.status(403).json({ title: 'Forbidden', message: 'Officers and Admins are created by Admin only.' });
    }

    // 2. Create Supabase Auth user (service role can create without email confirmation)
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      phone: phone ?? undefined,
      email_confirm: true,
    });

    if (authErr || !authData?.user) {
      return res.status(400).json({ title: 'Signup failed', message: authErr?.message ?? 'Could not create auth user' });
    }

    // 3. Insert into app users table, linking auth_user_id
    const { data: newUser, error: insertErr } = await supabase.from('users').insert({
      auth_user_id: authData.user.id,
      role: userRole,
      full_name: fullName,
      email: email.toLowerCase(),
      phone: phone ?? null,
      is_active: true,
      is_approved_for_login: userRole === 'TRAINEE' ? false : true,
    }).select().single();

    if (insertErr) {
      // Rollback: delete the Auth user we just created to avoid orphans
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ title: 'DB error', message: insertErr.message });
    }

    // 4. Insert role profile (trainee/supervisor)
    if (userRole === 'TRAINEE') {
      const settings = await getSystemSettings();
      await supabase.from('trainee_profiles').insert({
        user_id: newUser.id,
        admission_no: profileFields.admissionNo || `KNPSS/ADMIT/${new Date().getFullYear()}/${Math.floor(1000 + Math.random() * 9000)}`,
        course_code: profileFields.courseCode || 'DICT',
        course_name: profileFields.courseName || 'Diploma in Information Communication Technology',
        cohort: profileFields.cohort || '2024 Intake',
        attachment_duration_weeks: profileFields.attachmentDurationWeeks ?? settings?.attachment_duration_weeks ?? 12,
      });
    }
    if (userRole === 'SUPERVISOR') {
      await supabase.from('supervisor_profiles').insert({
        user_id: newUser.id,
        company_name: profileFields.companyName || 'Kenya Power and Lighting Company',
        job_title: profileFields.jobTitle ?? null,
        department: profileFields.department ?? null,
        work_email: profileFields.workEmail ?? null,
        work_phone: profileFields.workPhone ?? null,
      });
    }

    await logAudit(newUser.id, 'USER_SIGNUP', 'USER', newUser.id, undefined, toCamelCase(newUser), req.ip);

    return res.status(201).json({
      user: {
        id: newUser.id,
        role: newUser.role,
        fullName: newUser.full_name,
        email: newUser.email,
        isApprovedForLogin: newUser.is_approved_for_login,
      },
      message: userRole === 'TRAINEE'
        ? 'Account created. Awaiting Admin approval before you can log in.'
        : 'Account created. You can now log in.',
    });
  } catch (error: any) {
    console.error('Signup route error:', error);
    return res.status(500).json({
      title: 'Internal Server Error',
      message: error?.message || 'An unexpected error occurred during signup.'
    });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ title: 'Bad Request', message: 'Email and password are required.' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({
        title: 'Configuration Error',
        message: 'Supabase URL or Anonymous Key is not configured. Please add SUPABASE_URL and SUPABASE_ANON_KEY to your Secrets.'
      });
    }

    // 1. Authenticate via Supabase Auth — this validates the password
    const anonClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    const { data: session, error: loginErr } = await anonClient.auth.signInWithPassword({ email, password });

    if (loginErr || !session?.session) {
      return res.status(401).json({ title: 'Invalid credentials', message: loginErr?.message ?? 'Login failed' });
    }

    // 2. Look up app user row
    const { data: user, error: findErr } = await supabase
      .from('users')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ title: 'Not found', message: 'No app profile for this account.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ title: 'Deactivated', message: 'Account is deactivated.' });
    }
    if (user.role === 'TRAINEE' && !user.is_approved_for_login) {
      return res.status(403).json({ title: 'Pending approval', message: 'Account is pending Admin approval.' });
    }

    // 3. Update last login
    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

    await logAudit(user.id, 'USER_LOGIN', 'USER', user.id, undefined, undefined, req.ip);

    // 4. Return real Supabase JWT + app profile
    return res.json({
      accessToken: session.session.access_token,   // REAL JWT signed by Supabase
      refreshToken: session.session.refresh_token,
      expiresAt: session.session.expires_at,
      user: {
        id: user.id,
        role: user.role,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profile_photo_url,
        isApprovedForLogin: user.is_approved_for_login,
      },
    });
  } catch (error: any) {
    console.error('Login route error:', error);
    return res.status(500).json({
      title: 'Internal Server Error',
      message: error?.message || 'An unexpected error occurred during login.'
    });
  }
});

app.post('/api/v1/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ message: 'refreshToken required' });

  const anonClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: refreshed, error: refErr } = await anonClient.auth.refreshSession({ refresh_token: refreshToken });

  if (refErr || !refreshed?.session) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  return res.json({
    accessToken: refreshed.session.access_token,
    refreshToken: refreshed.session.refresh_token,
    expiresAt: refreshed.session.expires_at,
  });
});

app.delete('/api/v1/auth/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    await supabase.auth.signOut();
  }
  return res.json({ message: 'Logged out.' });
});

app.post('/api/v1/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }
  const { error } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${process.env.APP_URL || 'http://localhost:3000'}/reset-password` },
  });

  return res.json({ message: 'If that email is registered, a password reset link has been sent.' });
});

app.post('/api/v1/auth/verify-otp', (_req, res) => {
  res.json({ resetToken: `reset_token_verified_${Math.random()}` });
});

app.post('/api/v1/auth/reset-password', (_req, res) => {
  res.json({ status: 'success', detail: 'Password resets finalized successfully.' });
});

app.post('/api/v1/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const authUser = (req as any).authUser;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Both current password and new password are required.' });
  }

  // Re-authenticate to verify current password
  const anonClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { error: verifyErr } = await anonClient.auth.signInWithPassword({
    email: authUser.email,
    password: currentPassword,
  });
  if (verifyErr) return res.status(401).json({ message: 'Current password is wrong.' });

  // Update to new password
  const { error: updateErr } = await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
  if (updateErr) return res.status(500).json({ message: updateErr.message });

  return res.json({ message: 'Password updated successfully.' });
});

// ============================================================================
// 9.2 Users Endpoints
// ============================================================================
app.get('/api/v1/users', async (_req, res) => {
  const { data: users, error } = await supabase.from('users').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const { data: traineeProfiles } = await supabase.from('trainee_profiles').select('*');

  const stitched = users.map((u) => {
    if (u.role === 'TRAINEE') {
      const tp = traineeProfiles?.find((t) => t.user_id === u.id);
      return {
        ...toCamelCase(u),
        admissionNo: tp?.admission_no || 'Pending Allocation',
        eligibilityStatus: tp?.eligibility_status || 'PENDING',
      };
    }
    return toCamelCase(u);
  });
  res.json(stitched);
});

app.post('/api/v1/users/:id/approve-login', async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('users').select('*').eq('id', req.params.id).single();
  if (findErr || !existing) return res.status(404).send('User Not Found');

  const oldApprovalStatus = existing.is_approved_for_login;
  const newApprovalStatus = req.body.isApprovedForLogin !== undefined ? req.body.isApprovedForLogin : true;

  const { data: updated, error } = await supabase
    .from('users')
    .update({ is_approved_for_login: newApprovalStatus, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(
    undefined,
    'USER_APPROVAL_OVERRIDE',
    'USER',
    updated.id,
    { previousApproved: oldApprovalStatus },
    { currentApproved: updated.is_approved_for_login },
    req.ip
  );

  res.json({ success: true, user: toCamelCase(updated) });
});

app.post('/api/v1/users', async (req, res) => {
  const { role, fullName, email, phone, profilePhotoUrl } = req.body;

  if (!email || !fullName) {
    return res.status(400).json({ title: 'Bad Request', message: 'Email and Full Name are required.' });
  }

  // 1. Generate a secure temporary password
  const tempPassword = `KNPSS-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // 2. Create the Auth user using the service role admin client
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    phone: phone ?? undefined,
    email_confirm: true,
  });

  if (authErr || !authData?.user) {
    return res.status(400).json({ title: 'User creation failed', message: authErr?.message ?? 'Could not create auth user' });
  }

  // 3. Link the user row with auth_user_id
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({
      auth_user_id: authData.user.id,
      role,
      full_name: fullName,
      email: email.toLowerCase(),
      phone: phone || null,
      profile_photo_url:
        profilePhotoUrl || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
      is_active: true,
      is_approved_for_login: role === 'TRAINEE' ? false : true,
    })
    .select()
    .single();

  if (error) {
    // Rollback Auth user creation to prevent orphans
    await supabase.auth.admin.deleteUser(authData.user.id);
    return res.status(500).json({ error: error.message });
  }

  // 4. Create trainee profile if TRAINEE
  if (role === 'TRAINEE') {
    const settings = await getSystemSettings();
    await createDefaultTraineeProfile(newUser.id, settings?.attachment_duration_weeks ?? 12);
  }

  // 5. Send credentials via simulated SMS
  if (phone) {
    await sendSMS(phone, `Your KNPSS Link login: email=${email}, temp password=${tempPassword}. Change on first login.`);
  }

  await logAudit(undefined, 'USER_CREATION_ADMIN', 'USER', newUser.id, undefined, toCamelCase(newUser), req.ip);

  res.status(201).json(toCamelCase(newUser));
});

app.get('/api/v1/users/:id', async (req, res) => {
  const { data: u, error } = await supabase.from('users').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!u) return res.status(404).send('User Not Found');
  res.json(toCamelCase(u));
});

app.get('/api/v1/trainee-profile/:userId', async (req, res) => {
  const { data: tp, error } = await supabase
    .from('trainee_profiles')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!tp) return res.status(404).send('Trainee Profile Not Found');
  res.json(toCamelCase(tp));
});

app.get('/api/v1/officer-profile/:userId', async (req, res) => {
  let { data: op, error } = await supabase
    .from('officer_profiles')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  if (!op) {
    const { data: created, error: insertErr } = await supabase
      .from('officer_profiles')
      .insert({
        user_id: req.params.userId,
        employee_no: 'KNPSS-ASSESSOR-0' + Math.floor(Math.random() * 9 + 1),
        department: 'School of Engineering & Technical Arts',
        specialization: 'On-Site Compliance & Practical Logbook Audit',
        assigned_regions: ['Nairobi Area', 'Kiambu County'],
        completed_assessments_count: 14,
        office_room: 'Liaison Wing B, Room 14',
        availability_status: 'AVAILABLE',
      })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    op = created;
  }
  res.json(toCamelCase(op));
});

app.patch('/api/v1/officer-profile/:userId', async (req, res) => {
  const { data: updated, error } = await supabase
    .from('officer_profiles')
    .update(toSnakeCase(req.body))
    .eq('user_id', req.params.userId)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).send('Officer Profile Not Found');
  res.json(toCamelCase(updated));
});

app.get('/api/v1/supervisor-profile/:userId', async (req, res) => {
  let { data: sp, error } = await supabase
    .from('supervisor_profiles')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  if (!sp) {
    const { data: created, error: insertErr } = await supabase
      .from('supervisor_profiles')
      .insert({
        user_id: req.params.userId,
        company_name: 'Kenya Power and Lighting Company',
        job_title: 'Senior Electrical Engineering Superintendent',
        department: 'Substations & Distribution Systems',
        work_email: 'supervisor@corporates.com',
        work_phone: '+254711223344',
        office_location: 'Stima Plaza, Block C, 4th Floor',
        max_trainees_capacity: 5,
        current_assigned_trainees_count: 1,
      })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    sp = created;
  }
  res.json(toCamelCase(sp));
});

app.patch('/api/v1/supervisor-profile/:userId', async (req, res) => {
  const { data: updated, error } = await supabase
    .from('supervisor_profiles')
    .update(toSnakeCase(req.body))
    .eq('user_id', req.params.userId)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).send('Supervisor Profile Not Found');
  res.json(toCamelCase(updated));
});

app.get('/api/v1/admin-profile/:userId', async (req, res) => {
  let { data: ap, error } = await supabase
    .from('admin_profiles')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  if (!ap) {
    const { data: created, error: insertErr } = await supabase
      .from('admin_profiles')
      .insert({
        user_id: req.params.userId,
        admin_staff_code: 'KNPSS-ILO-ADMIN-01',
        portfolio: 'Director of Industrial Liaison & Placement Services',
        permissions_role: 'SYSTEM_ADMIN',
        office_extension: 'EXT-8012',
        desk_location: 'Administration Block A, Suite 10',
      })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    ap = created;
  }
  res.json(toCamelCase(ap));
});

app.patch('/api/v1/admin-profile/:userId', async (req, res) => {
  const { data: updated, error } = await supabase
    .from('admin_profiles')
    .update(toSnakeCase(req.body))
    .eq('user_id', req.params.userId)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).send('Admin Profile Not Found');
  res.json(toCamelCase(updated));
});

app.patch('/api/v1/users/:id', async (req, res) => {
  const { data: old } = await supabase.from('users').select('*').eq('id', req.params.id).maybeSingle();
  if (!old) return res.status(404).send('User Not Found');

  const { data: updated, error } = await supabase
    .from('users')
    .update({ ...toSnakeCase(req.body), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(req.params.id, 'USER_MODIFICATION', 'USER', req.params.id, toCamelCase(old), toCamelCase(updated), req.ip);
  res.json(toCamelCase(updated));
});

app.delete('/api/v1/users/:id', async (req, res) => {
  const { data: updated, error } = await supabase
    .from('users')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).send('User Not Found');

  await logAudit(undefined, 'USER_DEACTIVATION_ADMIN', 'USER', updated.id, undefined, toCamelCase(updated), req.ip);
  res.json({ message: 'User deactivated successfully.', user: toCamelCase(updated) });
});

app.post('/api/v1/users/import-csv', async (req, res) => {
  const { csvData } = req.body;
  const lines: string[] = csvData.split('\n').filter((l: string) => l.trim().length > 0);
  const recordsAdded: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 4) {
      const fullName = parts[0].trim();
      const email = parts[1].trim();
      const phone = parts[2].trim();
      const adNo = parts[3].trim();

      const { data: newUser, error } = await supabase
        .from('users')
        .insert({ role: 'TRAINEE', full_name: fullName, email, phone, is_active: true })
        .select()
        .single();
      if (error) {
        console.error('CSV import row failed:', error.message);
        continue;
      }

      await supabase.from('trainee_profiles').insert({
        user_id: newUser.id,
        admission_no: adNo,
        course_code: 'DICT',
        course_name: 'Diploma in Information Communication Technology',
        cohort: '2024 Intake',
        attachment_duration_weeks: 12,
        eligibility_status: 'ELIGIBLE',
        fee_paid: false,
      });

      recordsAdded.push(toCamelCase(newUser));
    }
  }

  await logAudit(undefined, 'USER_CSV_IMPORT', 'USER', undefined, undefined, { count: recordsAdded.length }, req.ip);
  res.json({ count: recordsAdded.length, users: recordsAdded });
});

// ============================================================================
// 9.3 Placements Endpoints
// ============================================================================
app.get('/api/v1/placements', async (_req, res) => {
  const { data: placements, error } = await supabase.from('placements').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const { data: traineeProfiles } = await supabase.from('trainee_profiles').select('*');
  const { data: users } = await supabase.from('users').select('*');

  const list = placements.map((pl) => {
    const tp = traineeProfiles?.find((t) => t.id === pl.trainee_id);
    const userObj = tp ? users?.find((u) => u.id === tp.user_id) : null;
    const officer = pl.assigned_officer_id ? users?.find((u) => u.id === pl.assigned_officer_id) : null;
    return {
      ...toCamelCase(pl),
      traineeEnrollment: tp ? toCamelCase(tp) : null,
      traineeUser: userObj ? toCamelCase(userObj) : null,
      assignedOfficer: officer ? toCamelCase(officer) : null,
    };
  });
  res.json(list);
});

app.post('/api/v1/placements', async (req, res) => {
  const {
    traineeId, companyName, companyAddress, supervisorName, supervisorPhone,
    supervisorEmail, county, startDate, endDate, acceptanceLetterUrl, locationLat, locationLng,
  } = req.body;

  const { data: newPl, error } = await supabase
    .from('placements')
    .insert({
      trainee_id: traineeId,
      company_name: companyName,
      company_address: companyAddress,
      supervisor_name: supervisorName,
      supervisor_phone: supervisorPhone,
      supervisor_email: supervisorEmail,
      county: county || 'Nairobi',
      location_lat: locationLat !== undefined && locationLat !== null ? parseFloat(locationLat) : null,
      location_lng: locationLng !== undefined && locationLng !== null ? parseFloat(locationLng) : null,
      start_date: startDate || null,
      end_date: endDate || null,
      status: 'PLACED',
      is_locked: req.body.isLocked || false,
      // Default officer assignment kept identical to original behavior.
      assigned_officer_id: null,
      acceptance_letter_url: acceptanceLetterUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(undefined, 'PLACEMENT_CREATION_BY_TRAINEE', 'PLACEMENT', newPl.id, undefined, toCamelCase(newPl), req.ip);
  res.status(201).json(toCamelCase(newPl));
});

app.get('/api/v1/placements/:id', async (req, res) => {
  const { data: pl, error } = await supabase.from('placements').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!pl) return res.status(404).send('Placement Not Found');

  const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
  const traineeUser = tp ? (await supabase.from('users').select('*').eq('id', tp.user_id).maybeSingle()).data : null;

  res.json({
    ...toCamelCase(pl),
    traineeEnrollment: tp ? toCamelCase(tp) : null,
    traineeUser: traineeUser ? toCamelCase(traineeUser) : null,
  });
});

app.patch('/api/v1/placements/:id', async (req, res) => {
  const { data: old } = await supabase.from('placements').select('*').eq('id', req.params.id).maybeSingle();
  if (!old) return res.status(404).send('Placement Not Found');

  const { data: updated, error } = await supabase
    .from('placements')
    .update({ ...toSnakeCase(req.body), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(undefined, 'PLACEMENT_MODIFIED', 'PLACEMENT', req.params.id, toCamelCase(old), toCamelCase(updated), req.ip);
  res.json(toCamelCase(updated));
});

app.patch('/api/v1/placements/:id/assign-officer', async (req, res) => {
  const { officerId } = req.body;
  const { data: pl, error: findErr } = await supabase.from('placements').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!pl) return res.status(404).send('Placement Not Found');

  const oldOfficer = pl.assigned_officer_id;
  const { data: updated, error } = await supabase
    .from('placements')
    .update({ assigned_officer_id: officerId, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(
    undefined, 'OFFICER_ASSIGNED_TO_PLACEMENT', 'PLACEMENT', updated.id,
    { previousOfficer: oldOfficer }, { currentOfficer: officerId }, req.ip
  );

  const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', updated.trainee_id).maybeSingle();
  const { data: officerObj } = await supabase.from('users').select('*').eq('id', officerId).maybeSingle();
  if (tp && officerObj) {
    await makeNotification(
      tp.user_id, 'OFFICER_ASSIGNED', 'Attachment Cover Appointed',
      `Officer ${officerObj.full_name} has been designated for your placement assessments.`,
      'PLACEMENT', updated.id
    );
    if (officerObj.phone) {
      await sendSMS(officerObj.phone, `KNPSS Link: You have been assigned to evaluate trainee ${tp.admission_no} at ${updated.company_name}.`);
    }
  }

  res.json(toCamelCase(updated));
});

// ============================================================================
// 9.4 Logbook Entries Endpoints
// ============================================================================
app.get('/api/v1/logbook/:placementId/entries', async (req, res) => {
  const { data, error } = await supabase
    .from('logbook_entries')
    .select('*')
    .eq('placement_id', req.params.placementId)
    .order('entry_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

app.post('/api/v1/logbook/:placementId/entries', async (req, res) => {
  const { activitiesDescription, skillsAcquired, toolsUsed, entryDate, supervisorName, fileUrls } = req.body;
  const placementId = req.params.placementId;

  const { data: pl, error: plErr } = await supabase.from('placements').select('*').eq('id', placementId).maybeSingle();
  if (plErr) return res.status(500).json({ error: plErr.message });
  if (!pl) return res.status(404).send('Placement Not Found');

  let weekNumber = 1;
  if (pl.start_date) {
    const start = new Date(pl.start_date);
    const curr = new Date(entryDate);
    const diffDays = Math.floor((curr.getTime() - start.getTime()) / (24 * 3600 * 1000));
    weekNumber = Math.max(1, Math.floor(diffDays / 7) + 1);
  }

  let isLate = false;
  const created = Date.now();
  const entDateMid = new Date(entryDate + 'T23:59:59').getTime();
  if (created - entDateMid > 48 * 3600 * 1000) isLate = true;

  const { count: sameDateCount } = await supabase
    .from('logbook_entries')
    .select('*', { count: 'exact', head: true })
    .eq('placement_id', placementId)
    .eq('entry_date', entryDate);
  const version = (sameDateCount || 0) + 1;

  const { data: newEntry, error } = await supabase
    .from('logbook_entries')
    .insert({
      placement_id: placementId,
      entry_date: entryDate,
      week_number: weekNumber,
      activities_description: activitiesDescription,
      skills_acquired: skillsAcquired,
      tools_used: toolsUsed,
      supervisor_name: supervisorName || pl.supervisor_name,
      file_urls: fileUrls || [],
      file_hashes: (fileUrls || []).map(() => Math.random().toString(36).substring(2, 11)),
      status: 'DRAFT',
      version,
      is_late: isLate,
      supervisor_acknowledged: false,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(undefined, 'LOGBOOK_ENTRY_CREATED', 'LOGBOOK_ENTRY', newEntry.id, undefined, toCamelCase(newEntry), req.ip);
  res.status(201).json(toCamelCase(newEntry));
});

app.get('/api/v1/logbook/entries/:id', async (req, res) => {
  const { data: le, error } = await supabase.from('logbook_entries').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!le) return res.status(404).send('Entry Not Discovered');
  res.json(toCamelCase(le));
});

app.patch('/api/v1/logbook/entries/:id', async (req, res) => {
  const { data: old } = await supabase.from('logbook_entries').select('*').eq('id', req.params.id).maybeSingle();
  if (!old) return res.status(404).send('Entry Not Found');

  const { data: updated, error } = await supabase
    .from('logbook_entries')
    .update({ ...toSnakeCase(req.body), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(undefined, 'LOGBOOK_ENTRY_UPDATED', 'LOGBOOK_ENTRY', req.params.id, toCamelCase(old), toCamelCase(updated), req.ip);
  res.json(toCamelCase(updated));
});

app.post('/api/v1/logbook/entries/:id/submit', async (req, res) => {
  const { data: entry, error } = await supabase
    .from('logbook_entries')
    .update({ status: 'SUBMITTED', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!entry) return res.status(404).send('Entry Not Found');

  await logAudit(undefined, 'LOGBOOK_ENTRY_SUBMITTED', 'LOGBOOK_ENTRY', entry.id, undefined, toCamelCase(entry), req.ip);
  res.json(toCamelCase(entry));
});

app.post('/api/v1/logbook/entries/:id/approve', async (req, res) => {
  const { rubricScores, comment, evaluatedBy } = req.body;

  const { data: entry, error } = await supabase
    .from('logbook_entries')
    .update({
      status: 'APPROVED',
      officer_comments: comment,
      rubric_scores: rubricScores,
      reviewed_at: new Date().toISOString(),
      reviewed_by: evaluatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!entry) return res.status(404).send('Entry Not Found');

  const { data: pl } = await supabase.from('placements').select('*').eq('id', entry.placement_id).maybeSingle();
  if (pl) {
    const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
    if (tp) {
      await makeNotification(
        tp.user_id, 'LOGBOOK_ENTRY_APPROVED', 'Logbook Entry Approved',
        `Your weekly logbook entry for ${entry.entry_date} has been analyzed and approved.`,
        'LOGBOOK_ENTRY', entry.id
      );
      const { data: traineeUser } = await supabase.from('users').select('*').eq('id', tp.user_id).maybeSingle();
      if (traineeUser?.phone) {
        await sendSMS(traineeUser.phone, `KNPSS Link: Your logbook entry for ${entry.entry_date} has been approved. Keep up the good work!`);
      }
    }
  }

  await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_APPROVED', 'LOGBOOK_ENTRY', entry.id, undefined, toCamelCase(entry), req.ip);
  res.json(toCamelCase(entry));
});

app.post('/api/v1/logbook/entries/:id/reject', async (req, res) => {
  const { comment, evaluatedBy } = req.body;

  const { data: entry, error } = await supabase
    .from('logbook_entries')
    .update({
      status: 'REJECTED',
      officer_comments: comment,
      reviewed_at: new Date().toISOString(),
      reviewed_by: evaluatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!entry) return res.status(404).send('Entry Not Found');

  const { data: pl } = await supabase.from('placements').select('*').eq('id', entry.placement_id).maybeSingle();
  if (pl) {
    const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
    if (tp) {
      await makeNotification(
        tp.user_id, 'LOGBOOK_ENTRY_REJECTED', 'Logbook Entry Rejected',
        `Your logbook entry for ${entry.entry_date} was rejected. Feedback: '${comment}'`,
        'LOGBOOK_ENTRY', entry.id
      );
      const { data: traineeUser } = await supabase.from('users').select('*').eq('id', tp.user_id).maybeSingle();
      if (traineeUser?.phone) {
        await sendSMS(traineeUser.phone, `KNPSS Link: Your logbook entry for ${entry.entry_date} was rejected. Reason: ${comment}. Please resubmit.`);
      }
    }
  }

  await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_REJECTED', 'LOGBOOK_ENTRY', entry.id, undefined, toCamelCase(entry), req.ip);
  res.json(toCamelCase(entry));
});

app.post('/api/v1/logbook/entries/:id/request-correction', async (req, res) => {
  const { comment, evaluatedBy } = req.body;

  const { data: entry, error } = await supabase
    .from('logbook_entries')
    .update({
      status: 'CORRECTION_REQUESTED',
      officer_comments: comment,
      reviewed_at: new Date().toISOString(),
      reviewed_by: evaluatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!entry) return res.status(404).send('Entry Not Found');

  const { data: pl } = await supabase.from('placements').select('*').eq('id', entry.placement_id).maybeSingle();
  if (pl) {
    const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
    if (tp) {
      await makeNotification(
        tp.user_id, 'LOGBOOK_ENTRY_CORRECTION', 'Correction Requested',
        `Please revise your entry for ${entry.entry_date}. Comments: '${comment}'`,
        'LOGBOOK_ENTRY', entry.id
      );
    }
  }

  await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_CORRECTION_REQUESTED', 'LOGBOOK_ENTRY', entry.id, undefined, toCamelCase(entry), req.ip);
  res.json(toCamelCase(entry));
});

app.post('/api/v1/logbook/entries/:id/acknowledge', async (req, res) => {
  const { supervisorComment } = req.body;

  const { data: entry, error } = await supabase
    .from('logbook_entries')
    .update({
      supervisor_acknowledged: true,
      supervisor_comment: supervisorComment,
      supervisor_acknowledged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!entry) return res.status(404).send('Entry Not Found');

  await logAudit(undefined, 'LOGBOOK_ENTRY_SUPERVISOR_ACKNOWLEDGED', 'LOGBOOK_ENTRY', entry.id, undefined, toCamelCase(entry), req.ip);
  res.json(toCamelCase(entry));
});

app.get('/api/v1/logbook/:placementId/gaps', async (req, res) => {
  const { data: entries, error } = await supabase
    .from('logbook_entries')
    .select('entry_date')
    .eq('placement_id', req.params.placementId)
    .neq('status', 'DRAFT');
  if (error) return res.status(500).json({ error: error.message });

  const { data: pl } = await supabase.from('placements').select('*').eq('id', req.params.placementId).maybeSingle();
  if (!pl || !pl.start_date) return res.json([]);

  const gaps: string[] = [];
  const start = new Date(pl.start_date);
  const endLimit = pl.end_date ? new Date(pl.end_date) : new Date();
  const today = new Date();
  const compareMax = endLimit.getTime() < today.getTime() ? endLimit : today;

  const current = new Date(start);
  while (current.getTime() <= compareMax.getTime()) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      const dateStr = current.toISOString().split('T')[0];
      const hasEntry = entries.some((le) => le.entry_date === dateStr);
      if (!hasEntry) gaps.push(dateStr);
    }
    current.setDate(current.getDate() + 1);
  }

  res.json(gaps.slice(0, 10));
});

app.get('/api/v1/logbook/:placementId/progress', async (req, res) => {
  const { data: entries, error } = await supabase
    .from('logbook_entries')
    .select('status')
    .eq('placement_id', req.params.placementId);
  if (error) return res.status(500).json({ error: error.message });

  const totalExpected = 60; // 12 weeks * 5 working days
  const submitted = entries.filter((le) => le.status !== 'DRAFT').length;
  const approved = entries.filter((le) => le.status === 'APPROVED').length;
  const percentage = Math.round((approved / totalExpected) * 100);

  res.json({ totalExpected, submitted, approved, percentage: Math.min(100, percentage) });
});

// ============================================================================
// 9.5 Attendance Registry Endpoints
// ============================================================================
app.get('/api/v1/attendance', async (req, res) => {
  const { placementId, traineeId } = req.query;
  let query = supabase.from('attendance_records').select('*');
  if (placementId) query = query.eq('placement_id', placementId as string);
  if (traineeId) query = query.eq('trainee_id', traineeId as string);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

app.post('/api/v1/attendance', async (req, res) => {
  const { records } = req.body;
  const now = new Date().toISOString();

  if (!records || !Array.isArray(records)) {
    const { placementId, traineeId, date, dayOfWeek, status, markedBy } = req.body;
    if (!placementId || !traineeId || !date || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // upsert on (placement_id, date) unique constraint from 001_schema.sql
    const { error } = await supabase.from('attendance_records').upsert(
      {
        placement_id: placementId,
        trainee_id: traineeId,
        date,
        day_of_week: dayOfWeek || 'Monday',
        status,
        marked_by: markedBy || 'John Mwangi',
        updated_at: now,
      },
      { onConflict: 'placement_id,date' }
    );
    if (error) return res.status(500).json({ error: error.message });

    await logAudit(undefined, 'ATTENDANCE_MARKED', 'ATTENDANCE', placementId, undefined, { date, status }, req.ip);
    return res.json({ success: true, count: 1 });
  }

  const rows = records
    .filter((r: any) => r.placementId && r.date && r.status)
    .map((r: any) => ({
      placement_id: r.placementId,
      trainee_id: r.traineeId || '',
      date: r.date,
      day_of_week: r.dayOfWeek || 'Monday',
      status: r.status,
      marked_by: r.markedBy || 'John Mwangi',
      updated_at: now,
    }));

  if (rows.length === 0) return res.json({ success: true, updated: 0, inserted: 0 });

  const { error } = await supabase.from('attendance_records').upsert(rows, { onConflict: 'placement_id,date' });
  if (error) return res.status(500).json({ error: error.message });

  await logAudit(undefined, 'ATTENDANCE_BULK_MARKED', 'ATTENDANCE', undefined, undefined, { count: rows.length }, req.ip);
  res.json({ success: true, updated: rows.length, inserted: 0 });
});

// ============================================================================
// 9.5 Assessments Endpoints
// ============================================================================
app.get('/api/v1/assessments/:placementId', async (req, res) => {
  const { data: as_, error } = await supabase
    .from('assessments')
    .select('*')
    .eq('placement_id', req.params.placementId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!as_) return res.status(404).send('Assessment Not Recorded');
  res.json(toCamelCase(as_));
});

app.post('/api/v1/assessments', async (req, res) => {
  const {
    placementId, officerId, visitDate, physicalLogbookPresent,
    entriesMatchUploads, supervisorConfirmed, discrepancyNotes,
    practicalNotes, overallScore, siteEvidenceUrls,
  } = req.body;

  const row = {
    placement_id: placementId,
    officer_id: officerId,
    visit_date: visitDate || new Date().toISOString().split('T')[0],
    physical_logbook_present: physicalLogbookPresent === true || physicalLogbookPresent === 'true',
    entries_match_uploads: entriesMatchUploads === true || entriesMatchUploads === 'true',
    supervisor_confirmed: supervisorConfirmed === true || supervisorConfirmed === 'true',
    discrepancy_notes: discrepancyNotes,
    practical_notes: practicalNotes,
    overall_score: Number(overallScore ?? 8),
    site_evidence_urls: siteEvidenceUrls || [],
    credibility_authorized: false,
  };

  // Enforce 1-assessment-per-placement limit (original behavior)
  const { data: existing } = await supabase.from('assessments').select('id').eq('placement_id', placementId).maybeSingle();

  let newAs;
  if (existing) {
    const { data, error } = await supabase.from('assessments').update(row).eq('id', existing.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    newAs = data;
  } else {
    const { data, error } = await supabase.from('assessments').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    newAs = data;
  }

  const { data: pl } = await supabase
    .from('placements')
    .update({ status: 'ASSESSED', updated_at: new Date().toISOString() })
    .eq('id', placementId)
    .select()
    .maybeSingle();

  if (pl) {
    const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
    if (tp) {
      await makeNotification(
        tp.user_id, 'ASSESSMENT_COMPLETED', 'Site Field Visit Completed',
        `Your physical field assessment has been authorized by Officer Mary Wanjiku.`,
        'PLACEMENT', pl.id
      );
      const { data: traineeUser } = await supabase.from('users').select('*').eq('id', tp.user_id).maybeSingle();
      if (traineeUser?.phone) {
        await sendSMS(traineeUser.phone, `KNPSS Link: Your field visit has been successfully authorized by Mary Wanjiku. Status marked: Assessed.`);
      }
    }
  }

  await logAudit(officerId, 'SITE_FIELD_VERIFICATION_CREATED', 'ASSESSMENT', newAs.id, undefined, toCamelCase(newAs), req.ip);
  res.status(201).json(toCamelCase(newAs));
});

app.post('/api/v1/assessments/:id/authorize', async (req, res) => {
  const { data: as_, error } = await supabase
    .from('assessments')
    .update({ credibility_authorized: true, authorized_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!as_) return res.status(404).send('Assessment Not Found');

  const { data: pl } = await supabase
    .from('placements')
    .update({ status: 'COMPLETED', updated_at: new Date().toISOString() })
    .eq('id', as_.placement_id)
    .select()
    .maybeSingle();

  if (pl) {
    const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
    if (tp) {
      await makeNotification(
        tp.user_id, 'CREDIBILITY_GRANTED', 'Attachment Status: Completed!',
        `Your digital dossier has been approved and completed successfully!`,
        'PLACEMENT', pl.id
      );
    }
  }

  await logAudit(undefined, 'ASSESSMENT_CREDIBILITY_AUTHORIZED', 'ASSESSMENT', as_.id, undefined, toCamelCase(as_), req.ip);
  res.json(toCamelCase(as_));
});

// ============================================================================
// File Upload — now Supabase Storage instead of local disk
// ============================================================================
app.post('/api/v1/upload', async (req, res) => {
  try {
    const { name, type, base64 } = req.body;
    if (!name || !base64) {
      return res.status(400).json({ error: 'Missing filename or file content' });
    }

    const base64Data = base64.replace(/^data:.*;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const fileId = `${Date.now()}-${name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    const { error: uploadErr } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .upload(fileId, buffer, { contentType: type || 'application/octet-stream', upsert: false });
    if (uploadErr) return res.status(500).json({ error: uploadErr.message });

    res.json({ fileUrl: `/api/v1/files/${fileId}`, originalName: name });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/files/:filename', async (req, res) => {
  const { data, error } = await supabase.storage.from(UPLOADS_BUCKET).download(req.params.filename);
  if (error || !data) return res.status(404).send('File not found');

  const ext = path.extname(req.params.filename).toLowerCase();
  let contentType = 'application/octet-stream';
  if (ext === '.pdf') contentType = 'application/pdf';
  else if (ext === '.png') contentType = 'image/png';
  else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  else if (ext === '.doc') contentType = 'application/msword';
  else if (ext === '.docx') contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'inline');
  res.send(buffer);
});

// ============================================================================
// 9.6 Documents Endpoints
// ============================================================================
app.get('/api/v1/documents', async (_req, res) => {
  const { data, error } = await supabase.from('institutional_documents').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

app.post('/api/v1/documents', async (req, res) => {
  const {
    title, category, version, fileUrl, visibility, visibilityFilter,
    downloadPolicy, downloadLimit, validationCode,
  } = req.body;

  const { data: newDoc, error } = await supabase
    .from('institutional_documents')
    .insert({
      title,
      category,
      version,
      file_url: fileUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      file_hash: `fh-${Math.random().toString(36).substring(3, 11)}`,
      visibility: visibility || 'ALL',
      visibility_filter: visibilityFilter,
      download_policy: downloadPolicy || 'UNLIMITED',
      download_limit: downloadLimit ? Number(downloadLimit) : null,
      is_active: true,
      uploaded_by: null,
      validation_code: validationCode || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const { data: trainees } = await supabase.from('users').select('id').eq('role', 'TRAINEE');
  for (const trainee of trainees || []) {
    await makeNotification(
      trainee.id, 'NEW_DOCUMENT', 'Revised Policy Bulletin Published',
      `Institutional document '${title}' has been issued and is available for review.`,
      'DOCUMENT', newDoc.id
    );
  }

  await logAudit(undefined, 'DOCUMENT_UPLOADED_ADMIN', 'DOCUMENT', newDoc.id, undefined, toCamelCase(newDoc), req.ip);
  res.status(201).json(toCamelCase(newDoc));
});

app.post('/api/v1/documents/:id/download', async (req, res) => {
  const { userId } = req.body;
  const { data: doc, error: docErr } = await supabase
    .from('institutional_documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (docErr) return res.status(500).json({ error: docErr.message });
  if (!doc) return res.status(404).send('Document not located');

  if (doc.download_policy !== 'UNLIMITED') {
    let { data: entitlement } = await supabase
      .from('document_entitlements')
      .select('*')
      .eq('document_id', doc.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (!entitlement) {
      const { data: created, error: insertErr } = await supabase
        .from('document_entitlements')
        .insert({ document_id: doc.id, user_id: userId, downloads_used: 0 })
        .select()
        .single();
      if (insertErr) return res.status(500).json({ error: insertErr.message });
      entitlement = created;
    }

    const limit = doc.download_policy === 'SINGLE' ? 1 : doc.download_limit || 1;
    if (entitlement.downloads_used >= limit) {
      return res.status(403).json({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: `Download limitation reached. You have consumed all ${limit} allocated download rights for this document.`,
      });
    }

    await supabase
      .from('document_entitlements')
      .update({ downloads_used: entitlement.downloads_used + 1, last_download_at: new Date().toISOString() })
      .eq('id', entitlement.id);
  }

  await supabase.from('download_events').insert({
    document_id: doc.id,
    user_id: userId,
    document_version: doc.version,
    ip_address: req.ip || '127.0.0.1',
    user_agent: req.headers['user-agent'] as string,
    success: true,
  });

  await logAudit(userId, 'DOCUMENT_DOWNLOAD_VERIFIED', 'DOCUMENT', doc.id, undefined, { version: doc.version }, req.ip);

  const { data: finalEntitlement } = await supabase
    .from('document_entitlements')
    .select('downloads_used')
    .eq('document_id', doc.id)
    .eq('user_id', userId)
    .maybeSingle();

  res.json({
    signedUrl: doc.file_url,
    enforcedPolicy: doc.download_policy,
    downloadsRemaining:
      doc.download_policy === 'UNLIMITED'
        ? 'UNLIMITED'
        : Math.max(0, (doc.download_policy === 'SINGLE' ? 1 : doc.download_limit || 1) - (finalEntitlement?.downloads_used || 0)),
  });
});

app.post('/api/v1/documents/:id/reset-entitlement/:userId', async (req, res) => {
  const { data: entitlement } = await supabase
    .from('document_entitlements')
    .select('*')
    .eq('document_id', req.params.id)
    .eq('user_id', req.params.userId)
    .maybeSingle();

  if (entitlement) {
    await supabase
      .from('document_entitlements')
      .update({ downloads_used: 0, reset_at: new Date().toISOString(), reset_by: null })
      .eq('id', entitlement.id);
    await logAudit(undefined, 'DOCUMENT_ENTITLEMENT_RESET', 'DOCUMENT', req.params.id, undefined, { resetTrainee: req.params.userId }, req.ip);
  }
  res.json({ status: 'success', detail: 'Trainee entitlements reset.' });
});

app.get('/api/v1/documents/:id/download-log', async (req, res) => {
  const { data: logs, error } = await supabase.from('download_events').select('*').eq('document_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  const { data: users } = await supabase.from('users').select('*');
  const enriched = logs.map((l) => ({
    ...toCamelCase(l),
    user: toCamelCase(users?.find((u) => u.id === l.user_id)),
  }));
  res.json(enriched);
});

// ============================================================================
// 9.7 Notifications Endpoints
// ============================================================================
app.get('/api/v1/notifications', async (req, res) => {
  const userId = req.query.userId as string | undefined;
  let query = supabase.from('app_notifications').select('*').order('created_at', { ascending: false });
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

app.patch('/api/v1/notifications/:id/read', async (req, res) => {
  await supabase.from('app_notifications').update({ is_read: true }).eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/v1/notifications/mark-all-read', async (req, res) => {
  const { userId } = req.body;
  await supabase.from('app_notifications').update({ is_read: true }).eq('user_id', userId);
  res.json({ success: true });
});

app.get('/api/v1/notifications/unread-count', async (req, res) => {
  const userId = req.query.userId as string;
  const { count, error } = await supabase
    .from('app_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0 });
});

// ============================================================================
// 9.8 Dossier export — unchanged, no DB involved (mock PDF generation)
// ============================================================================
app.post('/api/v1/exports/dossier/:placementId', (req, res) => {
  const plId = req.params.placementId;
  const dId = randId('export');
  res.json({ exportId: dId, status: 'ready', downloadUrl: `/api/v1/exports/${dId}/download?placementId=${plId}` });
});

app.get('/api/v1/exports/:id/status', (_req, res) => {
  res.json({ status: 'ready' });
});

app.get('/api/v1/exports/:id/download', (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=KNPSS_Dossier_Export_${req.params.id}.pdf`);
  res.send(Buffer.from('MOCK_PDF_DATA_KNPSS_PORTFOLIO'));
});

// ============================================================================
// 9.9 Analytics — aggregation queries against Postgres
// ============================================================================
app.get('/api/v1/analytics/overview', async (_req, res) => {
  const [{ count: totalTrainees }, { data: placements }, { count: activeCount }, { count: assessmentsCount }, { count: documentsCount }, { count: pendingReviews }] =
    await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'TRAINEE'),
      supabase.from('placements').select('status'),
      supabase.from('placements').select('*', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
      supabase.from('assessments').select('*', { count: 'exact', head: true }),
      supabase.from('institutional_documents').select('*', { count: 'exact', head: true }),
      supabase.from('logbook_entries').select('*', { count: 'exact', head: true }).eq('status', 'SUBMITTED'),
    ]);

  const placedCount = (placements || []).filter((p) => p.status !== 'UNPLACED').length;

  res.json({
    totalTrainees: totalTrainees || 0,
    placedRate: Math.round((placedCount / Math.max(1, totalTrainees || 1)) * 100),
    activeAttachmentsCount: activeCount || 0,
    completedAssessmentsCount: assessmentsCount || 0,
    documentsCount: documentsCount || 0,
    pendingReviews: pendingReviews || 0,
  });
});

app.get('/api/v1/analytics/placement-stats', async (_req, res) => {
  const { count: totalTrainees } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'TRAINEE');
  const { data: placements } = await supabase.from('placements').select('status');
  const byStatus = (s: string) => (placements || []).filter((p) => p.status === s).length;

  res.json([
    { name: 'Unplaced', count: (totalTrainees || 0) - (placements?.length || 0), color: '#9CA3AF' },
    { name: 'Placed', count: byStatus('PLACED'), color: '#1565C0' },
    { name: 'Active', count: byStatus('ACTIVE'), color: '#F57F17' },
    { name: 'Assessed', count: byStatus('ASSESSED'), color: '#6A1B9A' },
    { name: 'Completed', count: byStatus('COMPLETED'), color: '#2E7D32' },
  ]);
});

app.get('/api/v1/analytics/submission-trend', async (_req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: entries, error } = await supabase
    .from('logbook_entries')
    .select('created_at, status')
    .gte('created_at', sevenDaysAgo);
  if (error) return res.status(500).json({ error: error.message });

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay: Record<string, { submissions: number; approved: number }> = {};
  dayNames.forEach((d) => (byDay[d] = { submissions: 0, approved: 0 }));

  (entries || []).forEach((e) => {
    const day = dayNames[new Date(e.created_at).getDay()];
    byDay[day].submissions += 1;
    if (e.status === 'APPROVED') byDay[day].approved += 1;
  });

  res.json(dayNames.map((day) => ({ day, ...byDay[day] })));
});

app.get('/api/v1/analytics/missing-logbooks', async (_req, res) => {
  const { data: placements, error } = await supabase.from('placements').select('*').in('status', ['PLACED', 'ACTIVE']);
  if (error) return res.status(500).json({ error: error.message });

  const results = [];
  for (const pl of placements || []) {
    if (!pl.start_date) continue;
    const { data: entries } = await supabase
      .from('logbook_entries')
      .select('entry_date')
      .eq('placement_id', pl.id)
      .neq('status', 'DRAFT');

    const start = new Date(pl.start_date);
    const endLimit = pl.end_date ? new Date(pl.end_date) : new Date();
    const today = new Date();
    const compareMax = endLimit.getTime() < today.getTime() ? endLimit : today;

    let missingCount = 0;
    const current = new Date(start);
    while (current.getTime() <= compareMax.getTime()) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        const dateStr = current.toISOString().split('T')[0];
        const hasEntry = (entries || []).some((le) => le.entry_date === dateStr);
        if (!hasEntry) missingCount++;
      }
      current.setDate(current.getDate() + 1);
    }

    if (missingCount >= 3) {
      const { data: tp } = await supabase.from('trainee_profiles').select('*').eq('id', pl.trainee_id).maybeSingle();
      const { data: user } = tp ? await supabase.from('users').select('full_name').eq('id', tp.user_id).maybeSingle() : { data: null };
      results.push({
        id: pl.trainee_id,
        fullName: user?.full_name || 'Unknown',
        admissionNo: tp?.admission_no || 'N/A',
        companyName: pl.company_name,
        missingCount,
      });
    }
  }

  res.json(results);
});

app.get('/api/v1/analytics/officer-performance', async (req, res) => {
  // Returns performance stats per officer. Pass ?officerId=<real uuid> to
  // scope to one officer; without it, aggregates across all officers.
  const officerId = req.query.officerId as string | undefined;

  let officerQuery = supabase.from('officer_profiles').select('id, user_id');
  if (officerId) officerQuery = officerQuery.eq('id', officerId);
  const { data: officers, error: officersErr } = await officerQuery;
  if (officersErr) return res.status(500).json({ error: officersErr.message });

  const { data: users } = await supabase.from('users').select('id, full_name');

  const results = await Promise.all(
    (officers || []).map(async (op) => {
      const { count: assignedCount } = await supabase
        .from('placements')
        .select('*', { count: 'exact', head: true })
        .eq('assigned_officer_id', op.id);
      const { count: verifiedCount } = await supabase
        .from('assessments')
        .select('*', { count: 'exact', head: true })
        .eq('officer_id', op.id);
      const { count: pendingReviews } = await supabase
        .from('logbook_entries')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'SUBMITTED');

      const user = users?.find((u) => u.id === op.user_id);
      return {
        name: user?.full_name || 'Unknown Officer',
        assignedCount: assignedCount || 0,
        verifiedCount: verifiedCount || 0,
        pendingReviews: pendingReviews || 0,
      };
    })
  );

  res.json(results);
});

app.get('/api/v1/analytics/document-report', async (_req, res) => {
  const { data: documents, error } = await supabase.from('institutional_documents').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const results = await Promise.all(
    documents.map(async (d) => {
      const { count } = await supabase.from('download_events').select('*', { count: 'exact', head: true }).eq('document_id', d.id);
      return { title: d.title, policy: d.download_policy, downloads: count || 0 };
    })
  );
  res.json(results);
});

// ============================================================================
// 9.10 Audit
// ============================================================================
app.get('/api/v1/audit', async (_req, res) => {
  const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

// ============================================================================
// 9.11 USSD callback simulation
// ============================================================================
app.post('/api/v1/ussd/callback', async (req, res) => {
  const { phoneNumber, text } = req.body;
  const phone = phoneNumber || '+254712345678';

  const { data: user } = await supabase.from('users').select('*').eq('phone', phone).maybeSingle();
  const tp = user ? (await supabase.from('trainee_profiles').select('*').eq('user_id', user.id).maybeSingle()).data : null;
  const pl = tp ? (await supabase.from('placements').select('*').eq('trainee_id', tp.id).maybeSingle()).data : null;

  if (!user || !tp) {
    return res.send('END Trainee mobile number is not registered on KNPSS Link.');
  }

  const inputParts = text ? text.split('*') : [];
  const level = inputParts.length;
  const lastInput = inputParts[level - 1] || '';

  if (!text || lastInput === '0') {
    let response = 'CON Welcome to KNPSS Link\n';
    response += '1. Check Logbook Status\n';
    response += '2. View Missing Entries\n';
    response += '3. My Placement Details\n';
    response += '4. Contact My Officer\n';
    response += '0. Exit';
    return res.send(response);
  }

  const selection = inputParts[0];

  if (selection === '1') {
    if (!pl) return res.send('END No active placement recorded.');
    const { data: entries } = await supabase.from('logbook_entries').select('status').eq('placement_id', pl.id);
    const approved = (entries || []).filter((le) => le.status === 'APPROVED').length;
    const pending = (entries || []).filter((le) => le.status === 'SUBMITTED').length;
    let resp = `CON Logbook Progress: ${Math.round((approved / 60) * 100)}%\n`;
    resp += `Approved: ${approved} | Pending: ${pending}\n`;
    resp += '0. Back';
    res.send(resp);
  } else if (selection === '2') {
    let resp = 'CON Missing dates (last 7 days):\n';
    resp += '- 18 June 2026\n- 19 June 2026\n';
    resp += 'Upload via app when online.\n';
    resp += '0. Back';
    res.send(resp);
  } else if (selection === '3') {
    if (!pl) return res.send('CON No active placement.\n0. Back');
    let resp = `CON Company: ${pl.company_name.substring(0, 20)}\n`;
    resp += `Supervisor: ${pl.supervisor_name || 'N/A'}\n`;
    resp += `Officer: Mary Wanjiku\n`;
    resp += '0. Back';
    res.send(resp);
  } else if (selection === '4') {
    const officer = pl?.assigned_officer_id
      ? (await supabase.from('users').select('*').eq('id', pl.assigned_officer_id).maybeSingle()).data
      : null;
    let resp = `CON Assessor contact:\n`;
    resp += `Name: ${officer ? officer.full_name : 'Mary Wanjiku'}\n`;
    resp += `Phone: ${officer ? officer.phone : '0799000111'}\n`;
    resp += '0. Back';
    res.send(resp);
  } else {
    res.send('END Thank you for visiting KNPSS Link.');
  }
});

app.get('/api/v1/sms-logs', async (_req, res) => {
  const { data, error } = await supabase.from('sms_logs').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

// ============================================================================
// System Settings
// ============================================================================
app.get('/api/v1/system/settings', async (_req, res) => {
  const settings = await getSystemSettings();
  res.json(toCamelCase(settings));
});

app.post('/api/v1/system/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('system_settings')
    .update({ ...toSnakeCase(req.body), updated_at: new Date().toISOString() })
    .eq('id', true)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamelCase(data));
});

// ============================================================================
// Daraja M-Pesa STK Push sandbox
// ============================================================================
app.post('/api/v1/mpesa/stkpush', async (req, res) => {
  const { phone, userId } = req.body;
  const { data: attendee } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  const tp = attendee ? (await supabase.from('trainee_profiles').select('*').eq('user_id', attendee.id).maybeSingle()).data : null;

  const settings = await getSystemSettings();

  if (tp) {
    await supabase.from('trainee_profiles').update({ fee_paid: true }).eq('id', tp.id);
    await logAudit(userId, 'MPESA_DARAJA_PAYMENT_SUCCESS', 'TRAINEE_PROFILE', tp.id, { feePaid: false }, { feePaid: true }, req.ip);
    await makeNotification(
      userId, 'PAYMENT_SUCCESS', 'M-Pesa STK Push Successful',
      `KSH ${settings?.fee_amount} attachment fee received via STK push. Receipt: LHX382K19J`,
      'PROFILE', tp.id
    );
    await sendSMS(phone || attendee?.phone || '+254712345678', `KNPSS Link: Confirmed KES ${settings?.fee_amount}.00 paid via M-Pesa. Receipt: LHX382K19J. Status marked as ELIGIBLE.`);
  }

  res.json({
    status: 'success',
    detail: 'Daraja API Callback successfully resolved. Account registered paid successfully.',
    transactionId: 'LHX382K19J',
    amount: settings?.fee_amount,
  });
});

// ============================================================================
// Serve static files / Vite middleware in full stack — unchanged
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[KNPSS Link Applet Running on http://localhost:${PORT}]`);
  });
}

startServer();
