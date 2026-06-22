import { createClient } from '@supabase/supabase-js';

// These are safe for the frontend — ANON key only, never the service role key
const SUPABASE_URL = ((import.meta as any).env.VITE_SUPABASE_URL || '') as string;
const SUPABASE_ANON_KEY = ((import.meta as any).env.VITE_SUPABASE_ANON_KEY || '') as string;

export const supabasePublic = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder-anon-key');
