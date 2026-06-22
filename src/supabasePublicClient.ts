import { createClient } from '@supabase/supabase-js';

const clean = (val: string) => val ? val.replace(/^["']|["']$/g, '').trim() : '';

// These are safe for the frontend — ANON key only, never the service role key
const SUPABASE_URL = clean(((import.meta as any).env.VITE_SUPABASE_URL || '') as string);
const SUPABASE_ANON_KEY = clean(((import.meta as any).env.VITE_SUPABASE_ANON_KEY || '') as string);

export const supabasePublic = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder-anon-key');
