/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import * as express from 'express';
import * as crypto from 'crypto';
import { Resend } from 'resend';
import { supabase } from './lib/supabase';

import { 
  User, TraineeProfile, OfficerProfile, SupervisorProfile, AdminProfile,
  Placement, LogbookEntry, Assessment, InstitutionalDocument, DocumentEntitlement, 
  DownloadEvent, AppNotification, AuditLog, SMSLog, AttendanceRecord
} from './src/types';

dotenv.config({ path: './.env.local' });

const expressFactory = express as any;
const app = expressFactory.default ? expressFactory.default() : expressFactory();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const resend = new Resend(process.env.RESEND_API_KEY || '');
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SUPABASE_RESET_PASSWORD_REDIRECT_URL = process.env.SUPABASE_RESET_PASSWORD_REDIRECT_URL || process.env.APP_URL || 'http://localhost:4173';

const otpStore = new Map<string, { code: string; expiresAt: number }>();
const resetTokenStore = new Map<string, { email: string; expiresAt: number }>();

function toSnakeCase(value: any): any {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).reduce((acc, [key, val]) => {
      const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      acc[snakeKey] = toSnakeCase(val);
      return acc;
    }, {} as any);
  }
  return value;
}

function toCamelCase(value: any): any {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).reduce((acc, [key, val]) => {
      const camelKey = key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
      acc[camelKey] = toCamelCase(val);
      return acc;
    }, {} as any);
  }
  return value;
}

async function fetchOne(table: string, filters: Record<string, any>) {
  let query = supabase.from(table).select('*');
  for (const [column, value] of Object.entries(filters)) {
    if (column === 'email' && typeof value === 'string') {
      query = query.ilike(column, value.toLowerCase());
    } else {
      query = query.eq(column, value);
    }
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return toCamelCase(data);
}

async function fetchAll(table: string, queryBuilder?: (builder: any) => any) {
  let query = supabase.from(table).select('*');
  if (queryBuilder) query = queryBuilder(query);
  const { data, error } = await query;
  if (error) throw error;
  return toCamelCase(data || []);
}

async function fetchAllWhere(table: string, filters: Record<string, any>) {
  let query = supabase.from(table).select('*');
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }
  const { data, error } = await query;
  if (error) throw error;
  return toCamelCase(data || []);
}

async function insertRow(table: string, row: any) {
  const { data, error } = await supabase.from(table).insert(toSnakeCase(row)).select();
  if (error) throw error;
  return toCamelCase(data?.[0]);
}

async function insertRows(table: string, rows: any[]) {
  const { data, error } = await supabase.from(table).insert(rows.map(toSnakeCase)).select();
  if (error) throw error;
  return toCamelCase(data || []);
}

async function updateRow(table: string, updates: any, filters: Record<string, any>) {
  let query = supabase.from(table).update(toSnakeCase(updates)).select();
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return toCamelCase(data);
}

async function getSystemSettings() {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 'default').maybeSingle();
  if (error || !data) {
    console.error('Failed to fetch system settings:', error);
    return {
      institutionName: 'Kenya National Polytechnic & Vocational Sciences',
      attachmentDurationWeeks: 12,
      lateWindowHours: 48,
      smsApiKey: 'at_key_8f97b001a2f3',
      smsUsername: 'knpss_attachment',
      smsSenderId: 'KNPSS_LINK',
      feeCollectionEnabled: true,
      feeAmount: 1500,
      force2FA: false
    };
  }
  return toCamelCase(data);
}

function hashPassword(password: string) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

async function logAudit(userId: string | undefined, action: string, type?: string, id?: string, oldVals?: any, newVals?: any, ip: string = '127.0.0.1') {
  await insertRow('audit_logs', {
    id: `al-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    action,
    entityType: type,
    entityId: id,
    oldValues: oldVals ? JSON.stringify(oldVals) : undefined,
    newValues: newVals ? JSON.stringify(newVals) : undefined,
    ipAddress: ip,
    createdAt: new Date().toISOString()
  });
}

async function makeNotification(userId: string, type: string, title: string, body: string, entType?: string, entId?: string) {
  await insertRow('app_notifications', {
    id: `not-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    type,
    title,
    body,
    isRead: false,
    relatedEntityType: entType,
    relatedEntityId: entId,
    createdAt: new Date().toISOString()
  });
}

async function sendSMS(phoneNumber: string, message: string) {
  const settings = await getSystemSettings();
  await insertRow('sms_logs', {
    id: `sms-${Math.random().toString(36).substr(2, 9)}`,
    phoneNumber,
    message,
    senderId: settings.smsSenderId,
    status: 'SENT',
    createdAt: new Date().toISOString()
  });
  console.log(`[SMS SIMULATION] To: ${phoneNumber} | From: ${settings.smsSenderId} | Content: "${message}"`);
}

async function ensureOfficerProfile(userId: string) {
  const existing = await fetchOne('officer_profiles', { user_id: userId });
  if (existing) return existing;
  const profile: OfficerProfile = {
    id: `op-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    employeeNo: `KNPSS-ASSESSOR-0${Math.floor(1 + Math.random() * 9)}`,
    department: 'School of Engineering & Technical Arts',
    specialization: 'On-Site Compliance & Practical Logbook Audit',
    assignedRegions: ['Nairobi Area', 'Kiambu County'],
    completedAssessmentsCount: 14,
    officeRoom: 'Liaison Wing B, Room 14',
    availabilityStatus: 'AVAILABLE',
    createdAt: new Date().toISOString()
  };
  return insertRow('officer_profiles', profile);
}

async function ensureSupervisorProfile(userId: string) {
  const existing = await fetchOne('supervisor_profiles', { user_id: userId });
  if (existing) return existing;
  const profile: SupervisorProfile = {
    id: `sp-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    companyName: 'Kenya Power and Lighting Company',
    jobTitle: 'Senior Electrical Engineering Superintendent',
    department: 'Substations & Distribution Systems',
    workEmail: 'supervisor@corporates.com',
    workPhone: '+254711223344',
    officeLocation: 'Stima Plaza, Block C, 4th Floor',
    maxTraineesCapacity: 5,
    currentAssignedTraineesCount: 1,
    createdAt: new Date().toISOString()
  };
  return insertRow('supervisor_profiles', profile);
}

async function ensureAdminProfile(userId: string) {
  const existing = await fetchOne('admin_profiles', { user_id: userId });
  if (existing) return existing;
  const profile: AdminProfile = {
    id: `ap-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    adminStaffCode: 'KNPSS-ILO-ADMIN-01',
    portfolio: 'Director of Industrial Liaison & Placement Services',
    permissionsRole: 'SYSTEM_ADMIN',
    officeExtension: 'EXT-8012',
    deskLocation: 'Administration Block A, Suite 10',
    createdAt: new Date().toISOString()
  };
  return insertRow('admin_profiles', profile);
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Email and password are required' });
    }

    const emailLower = String(email).toLowerCase();
    const user = await fetchOne('users', { email: emailLower });
    if (!user) {
      return res.status(401).json({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid login credentials' });
    }

    const hashedPassword = hashPassword(String(password));
    if (!user.passwordHash || user.passwordHash !== hashedPassword) {
      return res.status(401).json({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid login credentials' });
    }

    if (!user.isActive) {
      return res.status(410).json({ type: 'about:blank', title: 'Unauthorized', status: 410, detail: 'This account has been deactivated' });
    }

    if (user.role === 'TRAINEE' && user.isApprovedForLogin === false) {
      return res.status(403).json({ type: 'about:blank', title: 'Approval Pending', status: 403, detail: 'Your account is in the Trainees Directory, but your permanent active login is locked. Please request Admin approval.' });
    }

    await updateRow('users', { lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { id: user.id });
    await logAudit(user.id, 'USER_LOGIN', 'USER', user.id, undefined, undefined, req.ip);

    res.json({
      accessToken: `at_jwt_${user.id}_${Math.random().toString(36).substr(2, 9)}`,
      user: {
        id: user.id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        isApprovedForLogin: user.isApprovedForLogin,
        profilePhotoUrl: user.profilePhotoUrl
      }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ type: 'about:blank', title: 'Server Error', status: 500, detail: 'Failed to log in' });
  }
});

app.post('/api/v1/auth/signup', async (req, res) => {
  try {
    const { fullName, email, phone, role, password, confirmPassword } = req.body;
    if (!fullName || !email || !phone || !password || !confirmPassword) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Full Name, Email, Phone, and Password are required fields' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Password must be at least 8 characters long' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Password and confirmation do not match' });
    }

    const emailLower = String(email).toLowerCase();
    const existingUser = await fetchOne('users', { email: emailLower });
    if (existingUser) {
      return res.status(400).json({ title: 'Bad Request', detail: 'An account with this email address already exists' });
    }

    const userRole = role || 'TRAINEE';
    const newUser: User = {
      id: `u-${Math.random().toString(36).substr(2, 9)}`,
      role: userRole,
      fullName,
      email: emailLower,
      passwordHash: hashPassword(String(password)),
      phone: phone || '',
      profilePhotoUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
      isActive: true,
      isApprovedForLogin: true,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insertRow('users', newUser);

    if (userRole === 'TRAINEE') {
      const admissionNo = `KNPSS/ADMIT/${new Date().getFullYear()}/${Math.floor(1000 + Math.random() * 9000)}`;
      const tp: TraineeProfile = {
        id: `tp-${Math.random().toString(36).substr(2, 9)}`,
        userId: newUser.id,
        admissionNo,
        courseCode: 'DICT',
        courseName: 'Diploma in Information Communication Technology',
        cohort: '2024 Intake',
        attachmentDurationWeeks: (await getSystemSettings()).attachmentDurationWeeks,
        eligibilityStatus: 'PENDING',
        feePaid: false,
        createdAt: new Date().toISOString()
      };
      await insertRow('trainee_profiles', tp);
    }

    await logAudit(newUser.id, 'USER_SIGNUP', 'USER', newUser.id, undefined, newUser, req.ip);

    res.json({
      accessToken: `at_jwt_${newUser.id}_${Math.random().toString(36).substr(2, 9)}`,
      user: {
        id: newUser.id,
        role: newUser.role,
        fullName: newUser.fullName,
        email: newUser.email,
        phone: newUser.phone,
        isApprovedForLogin: newUser.isApprovedForLogin,
        profilePhotoUrl: newUser.profilePhotoUrl
      }
    });
  } catch (error: any) {
    console.error('Signup error:', error);
    res.status(500).json({ title: 'Server Error', detail: 'Failed to sign up' });
  }
});

app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({ accessToken: `at_jwt_refresh_${Date.now()}` });
});

app.delete('/api/v1/auth/logout', (req, res) => {
  res.status(200).send('OK');
});

app.post('/api/v1/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Email is required' });
    }
    const emailLower = String(email).toLowerCase();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(emailLower, { code: otp, expiresAt });

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ title: 'Email Config Error', detail: 'RESEND_API_KEY not configured.' });
    }

    try {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: emailLower,
        subject: 'KNPSS AssessLink - Email Verification Code',
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Email Verification</h2><p>Your verification code is:</p><div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;"><h1 style="letter-spacing: 5px; color: #333; margin: 0;">${otp}</h1></div><p>This code expires in 10 minutes. Do not share this code with anyone.</p><p style="color: #999; font-size: 12px;">If you did not request this code, please ignore this email.</p></div>`
      });
    } catch (emailError) {
      console.error('Resend send-otp error:', emailError);
      return res.status(500).json({ title: 'Email Error', detail: 'Failed to send OTP email. Please check your Resend settings.' });
    }

    res.json({ message: 'OTP sent to your email.', email: emailLower, expiresIn: 600, otp });
  } catch (error: any) {
    console.error('Send OTP error:', error);
    res.status(500).json({ title: 'Server Error', detail: 'Failed to send OTP' });
  }
});

app.post('/api/v1/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Email and OTP are required' });
    }
    const emailLower = String(email).toLowerCase();
    const storedOtp = otpStore.get(emailLower);
    if (!storedOtp) {
      return res.status(400).json({ title: 'Invalid', detail: 'OTP not found. Please request a new one.' });
    }
    if (storedOtp.expiresAt < Date.now()) {
      otpStore.delete(emailLower);
      return res.status(400).json({ title: 'Expired', detail: 'OTP has expired. Please request a new one.' });
    }
    if (storedOtp.code !== otp.toString()) {
      return res.status(400).json({ title: 'Invalid', detail: 'Incorrect OTP. Please try again.' });
    }
    otpStore.delete(emailLower);
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiresAt = Date.now() + 30 * 60 * 1000;
    resetTokenStore.set(resetToken, { email: emailLower, expiresAt: resetTokenExpiresAt });
    res.json({ message: 'OTP verified successfully', resetToken, email: emailLower });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ title: 'Server Error', detail: 'Failed to verify OTP' });
  }
});

app.post('/api/v1/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Email is required' });
    }
    const emailLower = String(email).toLowerCase();
    const user = await fetchOne('users', { email: emailLower });
    if (!user) {
      return res.status(404).json({ title: 'Not Found', detail: 'Email not discovered' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(emailLower, { code: otp, expiresAt });

    if (process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: emailLower,
          subject: 'KNPSS AssessLink - Password Reset Code',
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Password Reset</h2><p>Your password reset code is:</p><div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;"><h1 style="letter-spacing: 5px; color: #333; margin: 0;">${otp}</h1></div><p>This code expires in 10 minutes. Do not share this code with anyone.</p><p style="color: #999; font-size: 12px;">If you did not request this code, please ignore this email.</p></div>`
        });
      } catch (emailError) {
        console.error('Forgot-password email error:', emailError);
        return res.status(500).json({ title: 'Email Error', detail: 'Failed to send password reset email.' });
      }
    }

    if (user.phone) {
      await sendSMS(user.phone, `Your KNPSS Link password reset code is ${otp}. Expires in 10 minutes. Do not share.`);
    }

    await logAudit(user.id, 'PASSWORD_RESET_OTP_TRIGGERED', 'USER', user.id, undefined, undefined, req.ip);
    res.json({ message: 'OTP sent to your email and phone number.', mode: 'otp', simulatedOtp: otp });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ title: 'Server Error', detail: 'Failed to process password reset request' });
  }
});

app.post('/api/v1/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) {
      return res.status(400).json({ title: 'Bad Request', detail: 'Reset token and new password are required' });
    }
    const tokenData = resetTokenStore.get(resetToken);
    if (!tokenData) {
      return res.status(400).json({ title: 'Invalid', detail: 'Reset token not found. Please request a new one.' });
    }
    if (tokenData.expiresAt < Date.now()) {
      resetTokenStore.delete(resetToken);
      return res.status(400).json({ title: 'Expired', detail: 'Reset token has expired. Please request a new one.' });
    }
    const user = await fetchOne('users', { email: tokenData.email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ title: 'Not Found', detail: 'User not found' });
    }
    await updateRow('users', { passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() }, { id: user.id });
    resetTokenStore.delete(resetToken);
    await logAudit(user.id, 'PASSWORD_RESET_COMPLETED', 'USER', user.id, undefined, undefined, req.ip);
    res.json({ status: 'success', message: 'Password reset successfully. You can now login with your new password.' });
  } catch (error: any) {
    console.error('Reset password error:', error);
    res.status(500).json({ title: 'Server Error', detail: 'Failed to reset password' });
  }
});

app.get('/api/v1/users', async (req, res) => {
  try {
    const users = await fetchAll('users');
    const traineeProfiles = await fetchAll('trainee_profiles');
    const response = users.map((u: User) => {
      if (u.role === 'TRAINEE') {
        const tp = traineeProfiles.find((t: TraineeProfile) => t.userId === u.id);
        return {
          ...u,
          admissionNo: tp?.admissionNo || 'Pending Allocation',
          eligibilityStatus: tp?.eligibilityStatus || 'PENDING'
        };
      }
      return u;
    });
    res.json(response);
  } catch (error: any) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/v1/users/:id/approve-login', async (req, res) => {
  try {
    const user = await fetchOne('users', { id: req.params.id });
    if (!user) return res.status(404).send('User Not Found');
    const updatedUser = await updateRow('users', { isApprovedForLogin: req.body.isApprovedForLogin !== undefined ? req.body.isApprovedForLogin : true, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'USER_APPROVAL_OVERRIDE', 'USER', updatedUser.id, { previousApproved: user.isApprovedForLogin }, { currentApproved: updatedUser.isApprovedForLogin }, req.ip);
    res.json({ success: true, user: updatedUser });
  } catch (error: any) {
    console.error('Approve login error:', error);
    res.status(500).json({ error: 'Failed to approve login' });
  }
});

app.post('/api/v1/users', async (req, res) => {
  try {
    const { role, fullName, email, phone, profilePhotoUrl } = req.get('content-type')?.includes('application/json') ? req.body : req.query;
    const newUser: User = {
      id: `u-${Math.random().toString(36).substr(2, 9)}`,
      role,
      fullName,
      email,
      phone,
      profilePhotoUrl: profilePhotoUrl || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
      isActive: true,
      isApprovedForLogin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insertRow('users', newUser);
    if (role === 'TRAINEE') {
      const admissionNo = `KNPSS/ADMIT/${new Date().getFullYear()}/${Math.floor(1000 + Math.random() * 9000)}`;
      const tp: TraineeProfile = {
        id: `tp-${Math.random().toString(36).substr(2, 9)}`,
        userId: newUser.id,
        admissionNo,
        courseCode: 'DICT',
        courseName: 'Diploma in Information Communication Technology',
        cohort: '2024 Intake',
        attachmentDurationWeeks: (await getSystemSettings()).attachmentDurationWeeks,
        eligibilityStatus: 'PENDING',
        feePaid: false,
        createdAt: new Date().toISOString()
      };
      await insertRow('trainee_profiles', tp);
    }
    await logAudit(undefined, 'USER_CREATION_ADMIN', 'USER', newUser.id, undefined, newUser, req.ip);
    res.status(201).json(newUser);
  } catch (error: any) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.get('/api/v1/users/:id', async (req, res) => {
  try {
    const user = await fetchOne('users', { id: req.params.id });
    if (!user) return res.status(404).send('User Not Found');
    res.json(user);
  } catch (error: any) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.get('/api/v1/trainee-profile/:userId', async (req, res) => {
  try {
    const profile = await fetchOne('trainee_profiles', { user_id: req.params.userId });
    if (!profile) return res.status(404).send('Trainee Profile Not Found');
    res.json(profile);
  } catch (error: any) {
    console.error('Get trainee profile error:', error);
    res.status(500).json({ error: 'Failed to fetch trainee profile' });
  }
});

app.get('/api/v1/officer-profile/:userId', async (req, res) => {
  try {
    const profile = await ensureOfficerProfile(req.params.userId);
    res.json(profile);
  } catch (error: any) {
    console.error('Get officer profile error:', error);
    res.status(500).json({ error: 'Failed to fetch officer profile' });
  }
});

app.patch('/api/v1/officer-profile/:userId', async (req, res) => {
  try {
    const profile = await fetchOne('officer_profiles', { user_id: req.params.userId });
    if (!profile) return res.status(404).send('Officer Profile Not Found');
    const updated = await updateRow('officer_profiles', req.body, { user_id: req.params.userId });
    res.json(updated);
  } catch (error: any) {
    console.error('Patch officer profile error:', error);
    res.status(500).json({ error: 'Failed to update officer profile' });
  }
});

app.get('/api/v1/supervisor-profile/:userId', async (req, res) => {
  try {
    const profile = await ensureSupervisorProfile(req.params.userId);
    res.json(profile);
  } catch (error: any) {
    console.error('Get supervisor profile error:', error);
    res.status(500).json({ error: 'Failed to fetch supervisor profile' });
  }
});

app.patch('/api/v1/supervisor-profile/:userId', async (req, res) => {
  try {
    const profile = await fetchOne('supervisor_profiles', { user_id: req.params.userId });
    if (!profile) return res.status(404).send('Supervisor Profile Not Found');
    const updated = await updateRow('supervisor_profiles', req.body, { user_id: req.params.userId });
    res.json(updated);
  } catch (error: any) {
    console.error('Patch supervisor profile error:', error);
    res.status(500).json({ error: 'Failed to update supervisor profile' });
  }
});

app.get('/api/v1/admin-profile/:userId', async (req, res) => {
  try {
    const profile = await ensureAdminProfile(req.params.userId);
    res.json(profile);
  } catch (error: any) {
    console.error('Get admin profile error:', error);
    res.status(500).json({ error: 'Failed to fetch admin profile' });
  }
});

app.patch('/api/v1/admin-profile/:userId', async (req, res) => {
  try {
    const profile = await fetchOne('admin_profiles', { user_id: req.params.userId });
    if (!profile) return res.status(404).send('Admin Profile Not Found');
    const updated = await updateRow('admin_profiles', req.body, { user_id: req.params.userId });
    res.json(updated);
  } catch (error: any) {
    console.error('Patch admin profile error:', error);
    res.status(500).json({ error: 'Failed to update admin profile' });
  }
});

app.patch('/api/v1/users/:id', async (req, res) => {
  try {
    const user = await fetchOne('users', { id: req.params.id });
    if (!user) return res.status(404).send('User Not Found');
    const updated = await updateRow('users', { ...req.body, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(req.params.id, 'USER_MODIFICATION', 'USER', req.params.id, user, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Patch user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/v1/users/:id', async (req, res) => {
  try {
    const user = await fetchOne('users', { id: req.params.id });
    if (!user) return res.status(404).send('User Not Found');
    const updated = await updateRow('users', { isActive: false, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'USER_DEACTIVATION_ADMIN', 'USER', updated.id, undefined, updated, req.ip);
    res.json({ message: 'User deactivated successfully.', user: updated });
  } catch (error: any) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

app.post('/api/v1/users/import-csv', async (req, res) => {
  try {
    const { csvData } = req.body;
    const lines = String(csvData).split('\n').filter((l: string) => l.trim().length > 0);
    const recordsAdded: User[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 4) {
        const fullName = parts[0].trim();
        const email = parts[1].trim();
        const phone = parts[2].trim();
        const adNo = parts[3].trim();
        const newUser: User = {
          id: `u-csv-${Math.random().toString(36).substr(2, 9)}`,
          role: 'TRAINEE',
          fullName,
          email,
          phone,
          isActive: true,
          isApprovedForLogin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await insertRow('users', newUser);
        const tp: TraineeProfile = {
          id: `tp-csv-${Math.random().toString(36).substr(2, 9)}`,
          userId: newUser.id,
          admissionNo: adNo,
          courseCode: 'DICT',
          courseName: 'Diploma in Information Communication Technology',
          cohort: '2024 Intake',
          attachmentDurationWeeks: 12,
          eligibilityStatus: 'ELIGIBLE',
          feePaid: false,
          createdAt: new Date().toISOString()
        };
        await insertRow('trainee_profiles', tp);
        recordsAdded.push(newUser);
      }
    }

    await logAudit(undefined, 'USER_CSV_IMPORT', 'USER', undefined, undefined, { count: recordsAdded.length }, req.ip);
    res.json({ count: recordsAdded.length, users: recordsAdded });
  } catch (error: any) {
    console.error('Import CSV error:', error);
    res.status(500).json({ error: 'Failed to import CSV users' });
  }
});

app.get('/api/v1/placements', async (req, res) => {
  try {
    const placements = await fetchAll('placements');
    const traineeProfiles = await fetchAll('trainee_profiles');
    const users = await fetchAll('users');
    const list = placements.map((pl: Placement) => {
      const tp = traineeProfiles.find((t: TraineeProfile) => t.id === pl.traineeId);
      const userObj = tp ? users.find((u: User) => u.id === tp.userId) : null;
      const officer = pl.assignedOfficerId ? users.find((u: User) => u.id === pl.assignedOfficerId) : null;
      return { ...pl, traineeEnrollment: tp, traineeUser: userObj, assignedOfficer: officer };
    });
    res.json(list);
  } catch (error: any) {
    console.error('Get placements error:', error);
    res.status(500).json({ error: 'Failed to fetch placements' });
  }
});

app.post('/api/v1/placements', async (req, res) => {
  try {
    const { traineeId, companyName, companyAddress, supervisorName, supervisorPhone, supervisorEmail, county, startDate, endDate, acceptanceLetterUrl, locationLat, locationLng } = req.body;
    const newPl: Placement = {
      id: `pl-${Math.random().toString(36).substr(2, 9)}`,
      traineeId,
      companyName,
      companyAddress,
      supervisorName,
      supervisorPhone,
      supervisorEmail,
      county: county || 'Nairobi',
      locationLat: locationLat !== undefined && locationLat !== null ? parseFloat(locationLat) : undefined,
      locationLng: locationLng !== undefined && locationLng !== null ? parseFloat(locationLng) : undefined,
      startDate,
      endDate,
      status: 'PLACED',
      isLocked: req.body.isLocked || false,
      assignedOfficerId: 'u-officer-1',
      acceptanceLetterUrl: acceptanceLetterUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insertRow('placements', newPl);
    await logAudit(undefined, 'PLACEMENT_CREATION_BY_TRAINEE', 'PLACEMENT', newPl.id, undefined, newPl, req.ip);
    res.status(201).json(newPl);
  } catch (error: any) {
    console.error('Create placement error:', error);
    res.status(500).json({ error: 'Failed to create placement' });
  }
});

app.get('/api/v1/placements/:id', async (req, res) => {
  try {
    const pl = await fetchOne('placements', { id: req.params.id });
    if (!pl) return res.status(404).send('Placement Not Found');
    const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
    const traineeUser = tp ? await fetchOne('users', { id: tp.userId }) : null;
    res.json({ ...pl, traineeEnrollment: tp, traineeUser });
  } catch (error: any) {
    console.error('Get placement error:', error);
    res.status(500).json({ error: 'Failed to fetch placement' });
  }
});

app.patch('/api/v1/placements/:id', async (req, res) => {
  try {
    const existing = await fetchOne('placements', { id: req.params.id });
    if (!existing) return res.status(404).send('Placement Not Found');
    const updated = await updateRow('placements', { ...req.body, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'PLACEMENT_MODIFIED', 'PLACEMENT', req.params.id, existing, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Patch placement error:', error);
    res.status(500).json({ error: 'Failed to update placement' });
  }
});

app.patch('/api/v1/placements/:id/assign-officer', async (req, res) => {
  try {
    const { officerId } = req.body;
    const pl = await fetchOne('placements', { id: req.params.id });
    if (!pl) return res.status(404).send('Placement Not Found');
    const updated = await updateRow('placements', { assignedOfficerId: officerId, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'OFFICER_ASSIGNED_TO_PLACEMENT', 'PLACEMENT', updated.id, { previousOfficer: pl.assignedOfficerId }, { currentOfficer: officerId }, req.ip);
    const tp = await fetchOne('trainee_profiles', { id: updated.traineeId });
    const officerObj = officerId ? await fetchOne('users', { id: officerId }) : null;
    if (tp && officerObj) {
      await makeNotification(tp.userId, 'OFFICER_ASSIGNED', 'Attachment Cover Appointed', `Officer ${officerObj.fullName} has been designated for your placement assessments.`, 'PLACEMENT', updated.id);
      if (officerObj.phone) {
        await sendSMS(officerObj.phone, `KNPSS Link: You have been assigned to evaluate trainee ${tp.admissionNo} at ${updated.companyName}.`);
      }
    }
    res.json(updated);
  } catch (error: any) {
    console.error('Assign officer error:', error);
    res.status(500).json({ error: 'Failed to assign officer' });
  }
});

app.get('/api/v1/logbook/:placementId/entries', async (req, res) => {
  try {
    const entries = await fetchAllWhere('logbook_entries', { placement_id: req.params.placementId });
    const sorted = (entries as LogbookEntry[]).sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    res.json(sorted);
  } catch (error: any) {
    console.error('Get logbook entries error:', error);
    res.status(500).json({ error: 'Failed to fetch logbook entries' });
  }
});

app.post('/api/v1/logbook/:placementId/entries', async (req, res) => {
  try {
    const { activitiesDescription, skillsAcquired, toolsUsed, entryDate, supervisorName, fileUrls } = req.body;
    const placementId = req.params.placementId;
    const pl = await fetchOne('placements', { id: placementId });
    if (!pl) return res.status(404).send('Placement Not Found');
    let weekNumber = 1;
    if (pl.startDate) {
      const start = new Date(pl.startDate);
      const curr = new Date(entryDate);
      const diffDays = Math.floor((curr.getTime() - start.getTime()) / (24 * 3600 * 1000));
      weekNumber = Math.max(1, Math.floor(diffDays / 7) + 1);
    }
    let isLate = false;
    const created = Date.now();
    const entDateMid = new Date(`${entryDate}T23:59:59`).getTime();
    const lateCutoff = 48 * 3600 * 1000;
    if (created - entDateMid > lateCutoff) {
      isLate = true;
    }
    const sameDateEntry = await fetchAllWhere('logbook_entries', { placement_id: placementId, entry_date: entryDate });
    const version = (sameDateEntry as LogbookEntry[]).length + 1;
    const newEntry: LogbookEntry = {
      id: `le-${Math.random().toString(36).substr(2, 9)}`,
      placementId,
      entryDate,
      weekNumber,
      activitiesDescription,
      skillsAcquired,
      toolsUsed,
      supervisorName: supervisorName || pl.supervisorName,
      fileUrls: fileUrls || [],
      fileHashes: (fileUrls || []).map(() => Math.random().toString(36).substr(2, 9)),
      status: 'DRAFT',
      version,
      isLate,
      supervisorAcknowledged: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insertRow('logbook_entries', newEntry);
    await logAudit(undefined, 'LOGBOOK_ENTRY_CREATED', 'LOGBOOK_ENTRY', newEntry.id, undefined, newEntry, req.ip);
    res.status(201).json(newEntry);
  } catch (error: any) {
    console.error('Create logbook entry error:', error);
    res.status(500).json({ error: 'Failed to create logbook entry' });
  }
});

app.get('/api/v1/logbook/entries/:id', async (req, res) => {
  try {
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Discovered');
    res.json(entry);
  } catch (error: any) {
    console.error('Get logbook entry error:', error);
    res.status(500).json({ error: 'Failed to fetch logbook entry' });
  }
});

app.patch('/api/v1/logbook/entries/:id', async (req, res) => {
  try {
    const existing = await fetchOne('logbook_entries', { id: req.params.id });
    if (!existing) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', { ...req.body, updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'LOGBOOK_ENTRY_UPDATED', 'LOGBOOK_ENTRY', req.params.id, existing, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Patch logbook entry error:', error);
    res.status(500).json({ error: 'Failed to update logbook entry' });
  }
});

app.post('/api/v1/logbook/entries/:id/submit', async (req, res) => {
  try {
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', { status: 'SUBMITTED', updatedAt: new Date().toISOString() }, { id: req.params.id });
    await logAudit(undefined, 'LOGBOOK_ENTRY_SUBMITTED', 'LOGBOOK_ENTRY', entry.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Submit logbook entry error:', error);
    res.status(500).json({ error: 'Failed to submit logbook entry' });
  }
});

app.post('/api/v1/logbook/entries/:id/approve', async (req, res) => {
  try {
    const { rubricScores, comment, evaluatedBy } = req.body;
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', {
      status: 'APPROVED',
      officerComments: comment,
      rubricScores,
      reviewedAt: new Date().toISOString(),
      reviewedBy: evaluatedBy || 'u-officer-1',
      updatedAt: new Date().toISOString()
    }, { id: req.params.id });
    const pl = await fetchOne('placements', { id: updated.placementId });
    if (pl) {
      const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
      if (tp) {
        await makeNotification(tp.userId, 'LOGBOOK_ENTRY_APPROVED', 'Logbook Entry Approved', `Your weekly logbook entry for ${updated.entryDate} has been analyzed and approved.`, 'LOGBOOK_ENTRY', updated.id);
        const traineeUser = await fetchOne('users', { id: tp.userId });
        if (traineeUser && traineeUser.phone) {
          await sendSMS(traineeUser.phone, `KNPSS Link: Your logbook entry for ${updated.entryDate} has been approved. Keep up the good work!`);
        }
      }
    }
    await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_APPROVED', 'LOGBOOK_ENTRY', updated.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Approve logbook entry error:', error);
    res.status(500).json({ error: 'Failed to approve logbook entry' });
  }
});

app.get('/api/v1/attendance', async (req, res) => {
  try {
    const { placementId, traineeId } = req.query;
    let list = await fetchAll('attendance_records');
    if (placementId) list = (list as AttendanceRecord[]).filter(r => r.placementId === placementId);
    if (traineeId) list = (list as AttendanceRecord[]).filter(r => r.traineeId === traineeId);
    res.json(list);
  } catch (error: any) {
    console.error('Get attendance error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

app.post('/api/v1/attendance', async (req, res) => {
  try {
    const { records } = req.body;
    const now = new Date().toISOString();
    let updatedCount = 0;
    let insertedCount = 0;

    if (!records || !Array.isArray(records)) {
      const { placementId, traineeId, date, dayOfWeek, status, markedBy } = req.body;
      if (!placementId || !traineeId || !date || !status) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const existing = await fetchOne('attendance_records', { placement_id: placementId, date });
      if (existing) {
        await updateRow('attendance_records', { status, markedBy: markedBy || 'John Mwangi', updatedAt: now }, { id: existing.id });
      } else {
        const newRec: AttendanceRecord = {
          id: `att-${Math.random().toString(36).substr(2, 9)}`,
          placementId,
          traineeId,
          date,
          dayOfWeek: dayOfWeek || 'Monday',
          status,
          markedBy: markedBy || 'John Mwangi',
          createdAt: now,
          updatedAt: now
        };
        await insertRow('attendance_records', newRec);
      }
      await logAudit(undefined, 'ATTENDANCE_MARKED', 'ATTENDANCE', placementId, undefined, { date, status }, req.ip);
      return res.json({ success: true, count: 1 });
    }

    for (const rec of records) {
      const { placementId, traineeId, date, dayOfWeek, status, markedBy } = rec;
      if (!placementId || !date || !status) continue;
      const existing = await fetchOne('attendance_records', { placement_id: placementId, date });
      if (existing) {
        await updateRow('attendance_records', { status, markedBy: markedBy || 'John Mwangi', updatedAt: now }, { id: existing.id });
        updatedCount++;
      } else {
        const newRec: AttendanceRecord = {
          id: `att-${Math.random().toString(36).substr(2, 9)}`,
          placementId,
          traineeId: traineeId || '',
          date,
          dayOfWeek: dayOfWeek || 'Monday',
          status,
          markedBy: markedBy || 'John Mwangi',
          createdAt: now,
          updatedAt: now
        };
        await insertRow('attendance_records', newRec);
        insertedCount++;
      }
    }

    if ((records || []).length > 0) {
      await logAudit(undefined, 'ATTENDANCE_BULK_MARKED', 'ATTENDANCE', undefined, undefined, { updated: updatedCount, inserted: insertedCount }, req.ip);
    }
    res.json({ success: true, updated: updatedCount, inserted: insertedCount });
  } catch (error: any) {
    console.error('Post attendance error:', error);
    res.status(500).json({ error: 'Failed to save attendance records' });
  }
});

app.post('/api/v1/logbook/entries/:id/reject', async (req, res) => {
  try {
    const { comment, evaluatedBy } = req.body;
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', {
      status: 'REJECTED',
      officerComments: comment,
      reviewedAt: new Date().toISOString(),
      reviewedBy: evaluatedBy || 'u-officer-1',
      updatedAt: new Date().toISOString()
    }, { id: req.params.id });
    const pl = await fetchOne('placements', { id: updated.placementId });
    if (pl) {
      const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
      if (tp) {
        await makeNotification(tp.userId, 'LOGBOOK_ENTRY_REJECTED', 'Logbook Entry Rejected', `Your logbook entry for ${updated.entryDate} was rejected. Feedback: '${comment}'`, 'LOGBOOK_ENTRY', updated.id);
        const traineeUser = await fetchOne('users', { id: tp.userId });
        if (traineeUser && traineeUser.phone) {
          await sendSMS(traineeUser.phone, `KNPSS Link: Your logbook entry for ${updated.entryDate} was rejected. Reason: ${comment}. Please resubmit.`);
        }
      }
    }
    await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_REJECTED', 'LOGBOOK_ENTRY', updated.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Reject logbook entry error:', error);
    res.status(500).json({ error: 'Failed to reject logbook entry' });
  }
});

app.post('/api/v1/logbook/entries/:id/request-correction', async (req, res) => {
  try {
    const { comment, evaluatedBy } = req.body;
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', {
      status: 'CORRECTION_REQUESTED',
      officerComments: comment,
      reviewedAt: new Date().toISOString(),
      reviewedBy: evaluatedBy || 'u-officer-1',
      updatedAt: new Date().toISOString()
    }, { id: req.params.id });
    const pl = await fetchOne('placements', { id: updated.placementId });
    if (pl) {
      const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
      if (tp) {
        await makeNotification(tp.userId, 'LOGBOOK_ENTRY_CORRECTION', 'Correction Requested', `Please revise your entry for ${updated.entryDate}. Comments: '${comment}'`, 'LOGBOOK_ENTRY', updated.id);
      }
    }
    await logAudit(evaluatedBy, 'LOGBOOK_ENTRY_CORRECTION_REQUESTED', 'LOGBOOK_ENTRY', updated.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Request correction error:', error);
    res.status(500).json({ error: 'Failed to request logbook correction' });
  }
});

app.post('/api/v1/logbook/entries/:id/acknowledge', async (req, res) => {
  try {
    const { supervisorComment } = req.body;
    const entry = await fetchOne('logbook_entries', { id: req.params.id });
    if (!entry) return res.status(404).send('Entry Not Found');
    const updated = await updateRow('logbook_entries', {
      supervisorAcknowledged: true,
      supervisorComment,
      supervisorAcknowledgedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { id: req.params.id });
    await logAudit(undefined, 'LOGBOOK_ENTRY_SUPERVISOR_ACKNOWLEDGED', 'LOGBOOK_ENTRY', updated.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Acknowledge logbook entry error:', error);
    res.status(500).json({ error: 'Failed to acknowledge logbook entry' });
  }
});

app.get('/api/v1/logbook/:placementId/gaps', async (req, res) => {
  try {
    const entries = await fetchAllWhere('logbook_entries', { placement_id: req.params.placementId });
    const pl = await fetchOne('placements', { id: req.params.placementId });
    if (!pl || !pl.startDate) return res.json([]);
    const filtered = (entries as LogbookEntry[]).filter(le => le.status !== 'DRAFT');
    const gaps: string[] = [];
    const start = new Date(pl.startDate);
    const endLimit = pl.endDate ? new Date(pl.endDate) : new Date();
    const today = new Date();
    const compareMax = endLimit.getTime() < today.getTime() ? endLimit : today;
    const current = new Date(start);
    while (current.getTime() <= compareMax.getTime()) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        const dateStr = current.toISOString().split('T')[0];
        const hasEntry = filtered.some(le => le.entryDate === dateStr);
        if (!hasEntry) gaps.push(dateStr);
      }
      current.setDate(current.getDate() + 1);
    }
    res.json(gaps.slice(0, 10));
  } catch (error: any) {
    console.error('Get logbook gaps error:', error);
    res.status(500).json({ error: 'Failed to compute logbook gaps' });
  }
});

app.get('/api/v1/logbook/:placementId/progress', async (req, res) => {
  try {
    const entries = await fetchAllWhere('logbook_entries', { placement_id: req.params.placementId });
    const totalExpected = 60;
    const submitted = (entries as LogbookEntry[]).filter(le => le.status !== 'DRAFT').length;
    const approved = (entries as LogbookEntry[]).filter(le => le.status === 'APPROVED').length;
    const percentage = Math.round((approved / totalExpected) * 100);
    res.json({ totalExpected, submitted, approved, percentage: Math.min(100, percentage) });
  } catch (error: any) {
    console.error('Get logbook progress error:', error);
    res.status(500).json({ error: 'Failed to compute logbook progress' });
  }
});

app.get('/api/v1/assessments/:placementId', async (req, res) => {
  try {
    const assessment = await fetchOne('assessments', { placement_id: req.params.placementId });
    if (!assessment) return res.status(404).send('Assessment Not Recorded');
    res.json(assessment);
  } catch (error: any) {
    console.error('Get assessments error:', error);
    res.status(500).json({ error: 'Failed to fetch assessment' });
  }
});

app.post('/api/v1/assessments', async (req, res) => {
  try {
    const { placementId, officerId, visitDate, physicalLogbookPresent, entriesMatchUploads, supervisorConfirmed, discrepancyNotes, practicalNotes, overallScore, siteEvidenceUrls } = req.get('content-type')?.includes('application/json') ? req.body : req.query;
    const newAs: Assessment = {
      id: `as-${Math.random().toString(36).substr(2, 9)}`,
      placementId,
      officerId,
      visitDate: visitDate || new Date().toISOString().split('T')[0],
      physicalLogbookPresent: physicalLogbookPresent === true || physicalLogbookPresent === 'true',
      entriesMatchUploads: entriesMatchUploads === true || entriesMatchUploads === 'true',
      supervisorConfirmed: supervisorConfirmed === true || supervisorConfirmed === 'true',
      discrepancyNotes,
      practicalNotes,
      overallScore: Number(overallScore || 8),
      siteEvidenceUrls: siteEvidenceUrls || [],
      credibilityAuthorized: false,
      createdAt: new Date().toISOString()
    };
    const existing = await fetchOne('assessments', { placement_id: placementId });
    let savedAssessment: any;
    if (existing) {
      savedAssessment = await updateRow('assessments', newAs, { placement_id: placementId });
    } else {
      savedAssessment = await insertRow('assessments', newAs);
    }
    const pl = await fetchOne('placements', { id: placementId });
    if (pl) {
      await updateRow('placements', { status: 'ASSESSED', updatedAt: new Date().toISOString() }, { id: pl.id });
      const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
      if (tp) {
        await makeNotification(tp.userId, 'ASSESSMENT_COMPLETED', 'Site Field Visit Completed', 'Your physical field assessment has been authorized by Officer Mary Wanjiku.', 'PLACEMENT', pl.id);
        const traineeUser = await fetchOne('users', { id: tp.userId });
        if (traineeUser && traineeUser.phone) {
          await sendSMS(traineeUser.phone, 'KNPSS Link: Your field visit has been successfully authorized by Mary Wanjiku. Status marked: Assessed.');
        }
      }
    }
    await logAudit(officerId, 'SITE_FIELD_VERIFICATION_CREATED', 'ASSESSMENT', newAs.id, undefined, newAs, req.ip);
    res.status(201).json(savedAssessment);
  } catch (error: any) {
    console.error('Create assessment error:', error);
    res.status(500).json({ error: 'Failed to create assessment' });
  }
});

app.post('/api/v1/assessments/:id/authorize', async (req, res) => {
  try {
    const assessment = await fetchOne('assessments', { id: req.params.id });
    if (!assessment) return res.status(404).send('Assessment Not Found');
    const updated = await updateRow('assessments', { credibilityAuthorized: true, authorizedAt: new Date().toISOString() }, { id: req.params.id });
    const pl = await fetchOne('placements', { id: assessment.placementId });
    if (pl) {
      await updateRow('placements', { status: 'COMPLETED', updatedAt: new Date().toISOString() }, { id: pl.id });
      const tp = await fetchOne('trainee_profiles', { id: pl.traineeId });
      if (tp) {
        await makeNotification(tp.userId, 'CREDIBILITY_GRANTED', 'Attachment Status: Completed!', 'Your digital dossier has been approved and completed successfully!', 'PLACEMENT', pl.id);
      }
    }
    await logAudit(undefined, 'ASSESSMENT_CREDIBILITY_AUTHORIZED', 'ASSESSMENT', updated.id, undefined, updated, req.ip);
    res.json(updated);
  } catch (error: any) {
    console.error('Authorize assessment error:', error);
    res.status(500).json({ error: 'Failed to authorize assessment' });
  }
});

app.post('/api/v1/upload', async (req, res) => {
  try {
    const { name, type, base64 } = req.body;
    if (!name || !base64) {
      return res.status(400).json({ error: 'Missing filename or file content' });
    }
    const base64Data = String(base64).replace(/^data:.*;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const fileId = `${Date.now()}-${name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const { data, error } = await supabase.storage.from('attachments').upload(fileId, buffer, { contentType: type || 'application/octet-stream' });
    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: error.message });
    }
    const publicUrlData = supabase.storage.from('attachments').getPublicUrl(fileId);
    if (!publicUrlData.data?.publicUrl) {
      console.error('Supabase public url error:', 'missing publicUrl');
      return res.status(500).json({ error: 'Failed to generate public URL' });
    }
    res.json({ fileUrl: publicUrlData.data.publicUrl, originalName: name });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/documents', async (req, res) => {
  try {
    const documents = await fetchAll('institutional_documents');
    res.json(documents);
  } catch (error: any) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

app.post('/api/v1/documents', async (req, res) => {
  try {
    const { title, category, version, fileUrl, visibility, visibilityFilter, downloadPolicy, downloadLimit, validationCode } = req.get('content-type')?.includes('application/json') ? req.body : req.query;
    const newDoc: InstitutionalDocument = {
      id: `doc-${Math.random().toString(36).substr(2, 9)}`,
      title,
      category,
      version,
      fileUrl: fileUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      fileHash: `fh-${Math.random().toString(36).substring(3, 11)}`,
      visibility: visibility || 'ALL',
      visibilityFilter,
      downloadPolicy: downloadPolicy || 'UNLIMITED',
      downloadLimit: downloadLimit ? Number(downloadLimit) : undefined,
      isActive: true,
      uploadedBy: 'u-admin-1',
      createdAt: new Date().toISOString(),
      validationCode: validationCode || undefined
    };
    await insertRow('institutional_documents', newDoc);
    const trainees = await fetchAll('users', q => q.eq('role', 'TRAINEE'));
    await Promise.all((trainees as User[]).map(trainee => makeNotification(trainee.id, 'NEW_DOCUMENT', 'Revised Policy Bulletin Published', `Institutional document '${title}' has been issued and is available for review.`, 'DOCUMENT', newDoc.id)));
    await logAudit(undefined, 'DOCUMENT_UPLOADED_ADMIN', 'DOCUMENT', newDoc.id, undefined, newDoc, req.ip);
    res.status(201).json(newDoc);
  } catch (error: any) {
    console.error('Create document error:', error);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

app.post('/api/v1/documents/:id/download', async (req, res) => {
  try {
    const { userId } = req.body;
    const doc = await fetchOne('institutional_documents', { id: req.params.id });
    if (!doc) return res.status(404).send('Document not located');
    let entitlement = await fetchOne('document_entitlements', { document_id: doc.id, user_id: userId });
    if (!entitlement) {
      entitlement = await insertRow('document_entitlements', {
        id: `ent-${Math.random().toString(36).substr(2, 9)}`,
        documentId: doc.id,
        userId,
        downloadsUsed: 0
      });
    }
    if (doc.downloadPolicy !== 'UNLIMITED') {
      const limit = doc.downloadPolicy === 'SINGLE' ? 1 : (doc.downloadLimit || 1);
      if ((entitlement.downloadsUsed || 0) >= limit) {
        return res.status(403).json({ type: 'about:blank', title: 'Forbidden', status: 403, detail: `Download limitation reached. You have consumed all ${limit} allocated download rights for this document.` });
      }
      await updateRow('document_entitlements', { downloadsUsed: (entitlement.downloadsUsed || 0) + 1, lastDownloadAt: new Date().toISOString() }, { id: entitlement.id });
    }
    await insertRow('download_events', {
      id: `ev-${Math.random().toString(36).substr(2, 9)}`,
      documentId: doc.id,
      userId,
      documentVersion: doc.version,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] as string,
      success: true,
      createdAt: new Date().toISOString()
    });
    await logAudit(userId, 'DOCUMENT_DOWNLOAD_VERIFIED', 'DOCUMENT', doc.id, undefined, { version: doc.version }, req.ip);
    const downloadsRemaining = doc.downloadPolicy === 'UNLIMITED' ? 'UNLIMITED' : Math.max(0, (doc.downloadPolicy === 'SINGLE' ? 1 : (doc.downloadLimit || 1)) - ((entitlement.downloadsUsed || 0) + 1));
    res.json({ signedUrl: doc.fileUrl, enforcedPolicy: doc.downloadPolicy, downloadsRemaining });
  } catch (error: any) {
    console.error('Document download error:', error);
    res.status(500).json({ error: 'Failed to process document download' });
  }
});

app.post('/api/v1/documents/:id/reset-entitlement/:userId', async (req, res) => {
  try {
    const entitlement = await fetchOne('document_entitlements', { document_id: req.params.id, user_id: req.params.userId });
    if (entitlement) {
      await updateRow('document_entitlements', { downloadsUsed: 0, resetAt: new Date().toISOString(), resetBy: 'u-admin-1' }, { id: entitlement.id });
      await logAudit(undefined, 'DOCUMENT_ENTITLEMENT_RESET', 'DOCUMENT', req.params.id, undefined, { resetTrainee: req.params.userId }, req.ip);
    }
    res.json({ status: 'success', detail: 'Trainee entitlements reset.' });
  } catch (error: any) {
    console.error('Reset entitlement error:', error);
    res.status(500).json({ error: 'Failed to reset entitlement' });
  }
});

app.get('/api/v1/documents/:id/download-log', async (req, res) => {
  try {
    const logs = await fetchAllWhere('download_events', { document_id: req.params.id });
    const users = await fetchAll('users');
    const enriched = (logs as DownloadEvent[]).map(l => ({ ...l, user: users.find((u: User) => u.id === l.userId) }));
    res.json(enriched);
  } catch (error: any) {
    console.error('Get download log error:', error);
    res.status(500).json({ error: 'Failed to fetch download log' });
  }
});

app.get('/api/v1/notifications', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    let list = await fetchAll('app_notifications');
    if (userId) list = (list as AppNotification[]).filter(n => n.userId === userId);
    res.json(list);
  } catch (error: any) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.patch('/api/v1/notifications/:id/read', async (req, res) => {
  try {
    const notification = await fetchOne('app_notifications', { id: req.params.id });
    if (notification) await updateRow('app_notifications', { isRead: true }, { id: req.params.id });
    res.json({ success: true });
  } catch (error: any) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

app.post('/api/v1/notifications/mark-all-read', async (req, res) => {
  try {
    const { userId } = req.body;
    const notifications = await fetchAllWhere('app_notifications', { user_id: userId });
    await Promise.all((notifications as AppNotification[]).map(n => updateRow('app_notifications', { isRead: true }, { id: n.id })));
    res.json({ success: true });
  } catch (error: any) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

app.get('/api/v1/notifications/unread-count', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const notifications = await fetchAllWhere('app_notifications', { user_id: userId });
    const count = (notifications as AppNotification[]).filter(n => !n.isRead).length;
    res.json({ count });
  } catch (error: any) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to fetch unread notification count' });
  }
});

app.post('/api/v1/exports/dossier/:placementId', (req, res) => {
  const dId = `export-${Math.random().toString(36).substr(2, 9)}`;
  res.json({ exportId: dId, status: 'ready', downloadUrl: `/api/v1/exports/${dId}/download?placementId=${req.params.placementId}` });
});

app.get('/api/v1/exports/:id/status', (req, res) => {
  res.json({ status: 'ready' });
});

app.get('/api/v1/exports/:id/download', (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=KNPSS_Dossier_Export_${req.params.id}.pdf`);
  res.send(Buffer.from('MOCK_PDF_DATA_KNPSS_PORTFOLIO'));
});

app.get('/api/v1/analytics/overview', async (req, res) => {
  try {
    const users = await fetchAll('users');
    const placements = await fetchAll('placements');
    const assessments = await fetchAll('assessments');
    const documents = await fetchAll('institutional_documents');
    const logbookEntries = await fetchAll('logbook_entries');
    res.json({
      totalTrainees: (users as User[]).filter(u => u.role === 'TRAINEE').length,
      placedRate: Math.round(((placements as Placement[]).filter(p => p.status !== 'UNPLACED').length / Math.max(1, (users as User[]).filter(u => u.role === 'TRAINEE').length)) * 100),
      activeAttachmentsCount: (placements as Placement[]).filter(p => p.status === 'ACTIVE').length,
      completedAssessmentsCount: (assessments as Assessment[]).length,
      documentsCount: (documents as InstitutionalDocument[]).length,
      pendingReviews: (logbookEntries as LogbookEntry[]).filter(le => le.status === 'SUBMITTED').length
    });
  } catch (error: any) {
    console.error('Get analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

app.get('/api/v1/analytics/placement-stats', async (req, res) => {
  try {
    const users = await fetchAll('users');
    const placements = await fetchAll('placements');
    const traineeCount = (users as User[]).filter(u => u.role === 'TRAINEE').length;
    const placementList = placements as Placement[];
    res.json([
      { name: 'Unplaced', count: traineeCount - placementList.length, color: '#9CA3AF' },
      { name: 'Placed', count: placementList.filter(p => p.status === 'PLACED').length, color: '#1565C0' },
      { name: 'Active', count: placementList.filter(p => p.status === 'ACTIVE').length, color: '#F57F17' },
      { name: 'Assessed', count: placementList.filter(p => p.status === 'ASSESSED').length, color: '#6A1B9A' },
      { name: 'Completed', count: placementList.filter(p => p.status === 'COMPLETED').length, color: '#2E7D32' }
    ]);
  } catch (error: any) {
    console.error('Get placement stats error:', error);
    res.status(500).json({ error: 'Failed to fetch placement stats' });
  }
});

app.get('/api/v1/analytics/submission-trend', (req, res) => {
  res.json([
    { day: 'Mon', submissions: 14, approved: 12 },
    { day: 'Tue', submissions: 19, approved: 17 },
    { day: 'Wed', submissions: 22, approved: 18 },
    { day: 'Thu', submissions: 15, approved: 15 },
    { day: 'Fri', submissions: 26, approved: 23 },
    { day: 'Sat', submissions: 5, approved: 4 },
    { day: 'Sun', submissions: 2, approved: 2 }
  ]);
});

app.get('/api/v1/analytics/missing-logbooks', (req, res) => {
  res.json([{ id: 'tp-2', fullName: 'Mary Wambui', admissionNo: 'KNPSS/DEEE/2022/9104', companyName: 'Athee River Cement Works', missingCount: 4 }]);
});

app.get('/api/v1/analytics/officer-performance', async (req, res) => {
  try {
    const placements = await fetchAll('placements');
    const assessments = await fetchAll('assessments');
    const pendingReviews = (await fetchAll('logbook_entries')).filter((le: LogbookEntry) => le.status === 'SUBMITTED').length;
    res.json([{ name: 'Mary Wanjiku', assignedCount: (placements as Placement[]).filter(p => p.assignedOfficerId === 'u-officer-1').length, verifiedCount: (assessments as Assessment[]).length, pendingReviews }]);
  } catch (error: any) {
    console.error('Get officer performance error:', error);
    res.status(500).json({ error: 'Failed to fetch officer performance' });
  }
});

app.get('/api/v1/analytics/document-report', async (req, res) => {
  try {
    const documents = await fetchAll('institutional_documents');
    const downloadEvents = await fetchAll('download_events');
    res.json((documents as InstitutionalDocument[]).map(d => ({ title: d.title, policy: d.downloadPolicy, downloads: (downloadEvents as DownloadEvent[]).filter(e => e.documentId === d.id).length })));
  } catch (error: any) {
    console.error('Get document report error:', error);
    res.status(500).json({ error: 'Failed to fetch document report' });
  }
});

app.get('/api/v1/audit', async (req, res) => {
  try {
    const auditLogs = await fetchAll('audit_logs');
    res.json(auditLogs);
  } catch (error: any) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

app.post('/api/v1/ussd/callback', async (req, res) => {
  try {
    const { sessionId, phoneNumber, text } = req.body;
    const phone = phoneNumber || '+254712345678';
    const user = await fetchOne('users', { phone });
    const tp = user ? await fetchOne('trainee_profiles', { user_id: user.id }) : null;
    const pl = tp ? await fetchOne('placements', { trainee_id: tp.id }) : null;
    if (!user || !tp) {
      return res.send('END Trainee mobile number is not registered on KNPSS Link.');
    }
    const inputParts = text ? String(text).split('*') : [];
    const lastInput = inputParts[inputParts.length - 1] || '';
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
      const entries = await fetchAllWhere('logbook_entries', { placement_id: pl.id });
      const approved = (entries as LogbookEntry[]).filter(le => le.status === 'APPROVED').length;
      const pending = (entries as LogbookEntry[]).filter(le => le.status === 'SUBMITTED').length;
      let resp = `CON Logbook Progress: ${Math.round((approved / 60) * 100)}%\n`;
      resp += `Approved: ${approved} | Pending: ${pending}\n`;
      resp += '0. Back';
      return res.send(resp);
    } else if (selection === '2') {
      let resp = 'CON Missing dates (last 7 days):\n';
      resp += '- 18 June 2026\n- 19 June 2026\n';
      resp += 'Upload via app when online.\n';
      resp += '0. Back';
      return res.send(resp);
    } else if (selection === '3') {
      if (!pl) return res.send('CON No active placement.\n0. Back');
      let resp = `CON Company: ${pl.companyName.substring(0, 20)}\n`;
      resp += `Supervisor: ${pl.supervisorName || 'N/A'}\n`;
      resp += 'Officer: Mary Wanjiku\n';
      resp += '0. Back';
      return res.send(resp);
    } else if (selection === '4') {
      const officer = pl && pl.assignedOfficerId ? await fetchOne('users', { id: pl.assignedOfficerId }) : null;
      let resp = 'CON Assessor contact:\n';
      resp += `Name: ${officer ? officer.fullName : 'Mary Wanjiku'}\n`;
      resp += `Phone: ${officer ? officer.phone : '0799000111'}\n`;
      resp += '0. Back';
      return res.send(resp);
    }
    res.send('END Thank you for visiting KNPSS Link.');
  } catch (error: any) {
    console.error('USSD callback error:', error);
    res.status(500).send('END An error occurred. Please try again later.');
  }
});

app.get('/api/v1/sms-logs', async (req, res) => {
  try {
    const logs = await fetchAll('sms_logs');
    res.json(logs);
  } catch (error: any) {
    console.error('Get sms logs error:', error);
    res.status(500).json({ error: 'Failed to fetch sms logs' });
  }
});

app.get('/api/v1/system/settings', async (req, res) => {
  try {
    const settings = await getSystemSettings();
    res.json(settings);
  } catch (error: any) {
    console.error('Get system settings error:', error);
    res.status(500).json({ error: 'Failed to fetch system settings' });
  }
});

app.post('/api/v1/system/settings', async (req, res) => {
  try {
    const existing = await fetchOne('settings', { id: 'default' });
    let updated;
    if (existing) {
      updated = await updateRow('settings', { ...req.body, updatedAt: new Date().toISOString() }, { id: 'default' });
    } else {
      updated = await insertRow('settings', { id: 'default', ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    res.json(updated);
  } catch (error: any) {
    console.error('Post system settings error:', error);
    res.status(500).json({ error: 'Failed to update system settings' });
  }
});

app.post('/api/v1/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, userId } = req.get('content-type')?.includes('application/json') ? req.body : req.query;
    const attendee = await fetchOne('users', { id: userId });
    const tp = attendee ? await fetchOne('trainee_profiles', { user_id: attendee.id }) : null;
    if (tp) {
      await updateRow('trainee_profiles', { feePaid: true }, { id: tp.id });
      await logAudit(userId, 'MPESA_DARAJA_PAYMENT_SUCCESS', 'TRAINEE_PROFILE', tp.id, { feePaid: false }, { feePaid: true }, req.ip);
      await makeNotification(userId, 'PAYMENT_SUCCESS', 'M-Pesa STK Push Successful', `KSH ${(await getSystemSettings()).feeAmount} attachment fee received via STK push. Receipt: LHX382K19J`, 'PROFILE', tp.id);
      await sendSMS(phone || attendee?.phone || '+254712345678', `KNPSS Link: Confirmed KES ${(await getSystemSettings()).feeAmount}.00 paid via M-Pesa. Receipt: LHX382K19J. Status marked as ELIGIBLE.`);
    }
    res.json({ status: 'success', detail: ' Daraja API Callback successfully resolved. Account registered paid successfully.', transactionId: 'LHX382K19J', amount: (await getSystemSettings()).feeAmount });
  } catch (error: any) {
    console.error('MPESA STK Push error:', error);
    res.status(500).json({ error: 'Failed to process Daraja callback' });
  }
});

if (process.env.VERCEL !== '1' && process.env.VERCEL !== 'true') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[KNPSS Link Applet Running on http://localhost:${PORT}]`);
  });
}

export { app };
