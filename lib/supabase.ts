import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: any;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
} else {
  // provide a minimal stub for local/dev runs where Supabase isn't configured
  const stubQuery = () => ({
    ilike() { return this; },
    eq() { return this; },
    select() { return this; },
    maybeSingle: async () => ({ data: null, error: null }),
    then: async () => ({ data: null, error: null })
  });

  const stubStorage = () => ({
    upload: async () => ({ data: null, error: { message: 'no-storage' } }),
    getPublicUrl: (file: string) => ({ data: { publicUrl: '' } })
  });

  supabase = {
    from: () => stubQuery(),
    storage: { from: () => stubStorage() }
  } as any;
}

export { supabase };
