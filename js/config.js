// URL e Anon Key são públicas por definição; a segurança vem do RLS.
// NUNCA coloque a service_role key aqui.
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const SYNTHETIC_EMAIL_DOMAIN = 'users.pokemonpanela.invalid';

export const isCloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);

export const supabase = isCloudEnabled
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;
