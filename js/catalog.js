// Loader, cache local e motor de filtros determinísticos.
const CACHE_KEY = 'panela_catalog_cache_v1';
let spriteBase = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
let all = [];
let active = [];
let byId = new Map();
let inactive = new Set();

/** Grupo granular de cada categoria (filtro Regionais/Megas/Especiais). */
const FORM_GROUP = { regional: 'regional', mega: 'mega', primal: 'mega', gmax: 'special', special: 'special' };

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY));
  } catch {
    return null;
  }
}

export async function loadCatalog() {
  let data;
  try {
    const res = await fetch('data/catalog.min.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch { /* cota cheia ou modo privado */ }
  } catch (err) {
    data = readCache();
    if (!data) throw err;
  }
  spriteBase = data.spriteBase;
  all = data.entries;
  byId = new Map(all.map((e) => [e.id, e]));
  refreshActive();
}

function refreshActive() {
  active = all.filter((e) => !inactive.has(e.id));
}

export function setInactive(ids) {
  inactive = new Set(ids);
  refreshActive();
}

export const isInactive = (id) => inactive.has(id);
export const allEntries = () => all;
export const entries = () => active;
export const getEntry = (id) => byId.get(id);
export const isAvailable = (id) => byId.has(id) && !inactive.has(id);
export const spriteUrl = (e) => `${spriteBase}${e.sprite ?? `${e.id}.png`}`;

export function formsOf(dex) {
  return active.filter((e) => e.dex === dex);
}

export function multiFormSpecies() {
  const count = new Map();
  for (const e of active) count.set(e.dex, (count.get(e.dex) ?? 0) + 1);
  return active.filter((e) => e.cat === 'base' && count.get(e.dex) > 1);
}

/** Predicado único: usado no numerador e no denominador do progresso. */
export function matchesFilter(e, f) {
  if (f.journey === 'generation' && e.sg !== Number(f.generation)) return false;
  if (e.cat === 'base') return true;
  if (f.forms === 'all') return true;
  if (f.forms === 'base') return false;
  return Boolean(f.groups[FORM_GROUP[e.cat]]);
}

export const filtered = (f) => active.filter((e) => matchesFilter(e, f));

export function progress(list, hasVote) {
  const total = list.length;
  const voted = list.reduce((n, e) => n + (hasVote(e.id) ? 1 : 0), 0);
  return { voted, total, percent: total ? (voted / total) * 100 : 0 };
}

export function matchesSearch(e, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^#?\d{1,4}$/.test(q)) return e.dex === Number(q.replace('#', ''));
  return e.name.toLowerCase().includes(q) || e.slug.includes(q);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ordered(list, order, seed) {
  const out = [...list];
  if (order === 'alpha') return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (order === 'random') {
    const sorted = out.sort((a, b) => a.id - b.id);
    const rand = mulberry32(seed);
    for (let i = sorted.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    }
    return sorted;
  }
  return out.sort((a, b) => a.dex - b.dex || (a.cat === 'base' ? -1 : b.cat === 'base' ? 1 : a.id - b.id));
}
