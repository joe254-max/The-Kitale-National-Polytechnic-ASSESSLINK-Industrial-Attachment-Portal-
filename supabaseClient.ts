/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Supabase client for server-side use only. This uses the SERVICE ROLE key,
 * which bypasses Row Level Security — that's correct here because the
 * Express server is the trusted backend; RLS (002_rls_policies.sql) exists
 * as a safety net for any future direct client-to-Supabase calls.
 *
 * NEVER import this file or expose SUPABASE_SERVICE_ROLE_KEY in any
 * frontend/browser code.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. ' +
    'There is no fallback store anymore (the old db.json file is gone) — set these ' +
    'in your .env locally, or in Render/Railway environment settings in production.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Storage bucket used by the generic /api/v1/upload endpoint.
// Create this bucket (private) in Supabase Storage before deploying.
export const UPLOADS_BUCKET = 'assesslink-uploads';
