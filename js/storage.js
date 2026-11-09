// Abstração única: visitante (localStorage) ou usuário logado (Supabase).
import { supabase } from './config.js';
import { toast, errorText } from './ui.js';

const GUEST_KEY = 'panela_guest_state_v1';

export const storeEvents = new EventTarget();
const emit = () => storeEvents.dispatchEvent(new Event('change'));

let mode = 'guest';
let userId = null;
let votes = new Map(); // pokemon_id -> { s: nota, t: epoch ms }
let writeChain = Promise.resolve();

function readGuest() {
  try {
    const raw = JSON.parse(localStorage.getItem(GUEST_KEY));
    const map = new Map();
    for (const [id, v] of Object.entries(raw?.votes ?? {})) {
      if (v && v.s >= 1 && v.s <= 5) map.set(Number(id), { s: v.s, t: v.t ?? 0 });
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveGuest() {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify({ version: 1, votes: Object.fromEntries(votes) }));
  } catch {
    toast('Não foi possível salvar neste navegador.', 'error');
  }
}

export const guestVoteCount = () => readGuest().size;

export function guestVotesPayload() {
  return [...readGuest()].map(([pokemon_id, v]) => ({ pokemon_id, score: v.s, t: v.t }));
}

export function clearGuestState() {
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch { /* indisponível */ }
}

export function useGuest() {
  mode = 'guest';
  userId = null;
  votes = readGuest();
  emit();
}

export async function useCloud(uid) {
  mode = 'cloud';
  userId = uid;
  await reloadCloud();
}

export async function reloadCloud() {
  const next = new Map();
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from('votes')
      .select('pokemon_id,score,updated_at')
      .eq('user_id', userId)
      .order('pokemon_id')
      .range(from, from + size - 1);
    if (error) throw error;
    for (const r of data) next.set(r.pokemon_id, { s: r.score, t: Date.parse(r.updated_at) });
    if (data.length < size) break;
  }
  votes = next;
  emit();
}

function enqueue(write) {
  writeChain = writeChain.then(async () => {
    const { error } = await write();
    if (error) throw error;
  }).catch(async (err) => {
    toast(errorText(err), 'error');
    try {
      await reloadCloud(); // volta ao estado confirmado no servidor
    } catch { /* continua offline */ }
  });
  return writeChain;
}

export const storeMode = () => mode;
export const getVote = (id) => votes.get(id)?.s ?? null;
export const hasVote = (id) => votes.has(id);
export const allVotes = () => votes;

export function setVote(id, score) {
  votes.set(id, { s: score, t: Date.now() });
  emit();
  if (mode === 'guest') {
    saveGuest();
    return Promise.resolve();
  }
  const uid = userId;
  return enqueue(() => supabase.from('votes')
    .upsert({ user_id: uid, pokemon_id: id, score }, { onConflict: 'user_id,pokemon_id' }));
}

export function deleteVote(id) {
  votes.delete(id);
  emit();
  if (mode === 'guest') {
    saveGuest();
    return Promise.resolve();
  }
  const uid = userId;
  return enqueue(() => supabase.from('votes').delete().eq('user_id', uid).eq('pokemon_id', id));
}

/** Espera todas as escritas pendentes (antes de migrar ou sair). */
export const flushWrites = () => writeChain;
