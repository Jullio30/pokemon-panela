// URL e Anon Key são públicas por definição; a segurança vem do RLS.
// NUNCA coloque a service_role key aqui.
export const SUPABASE_URL = 'https://dxifpiflqdkcbrajkzuq.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4aWZwaWZscWRrY2JyYWprenVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNTI0OTMsImV4cCI6MjEwOTgyODQ5M30.kw779pDrPKuFqssJirEbQnKxAVbwx-fSiazcaGDsDGo';

export const SYNTHETIC_EMAIL_DOMAIN = 'users.pokemonpanela.invalid';

export const isCloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);

export const supabase = isCloudEnabled
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;
