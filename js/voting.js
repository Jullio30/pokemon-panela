// Arena de votação: fila, ordem, teclado e pilha de undo.
import { filtered, ordered, progress, spriteUrl } from './catalog.js';
import { getVote, hasVote, setVote, deleteVote, storeMode } from './storage.js';
import { h, fill, sprite, typeBadges, dexLabel, TIERS, select } from './ui.js';

const SETTINGS_KEY = 'panela_settings_v1';
const SEED_KEY = 'panela_seed_v1';
const UNDO_LIMIT = 200;
const SWITCH_DELAY_MS = 600;

const defaults = {
  journey: 'full', generation: 1, order: 'dex', forms: 'all', groups: { regional: true, mega: true, special: true },
};

let settings = loadSettings();
let queue = [];
let list = [];
let skipped = new Set();
let undoStack = [];
let pinned = null;
let active = false;
let stage = null;
let keyboardBound = false;
let shownId = null;
let lockedUntil = 0;
let lockTimer = null;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return { ...defaults, ...saved, groups: { ...defaults.groups, ...saved?.groups } };
  } catch {
    return structuredClone(defaults);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* indisponível */ }
}

function sessionSeed(reset = false) {
  try {
    let seed = Number(sessionStorage.getItem(SEED_KEY));
    if (reset || !seed) {
      seed = (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
      sessionStorage.setItem(SEED_KEY, String(seed));
    }
    return seed;
  } catch {
    return 20240229;
  }
}

function rebuild() {
  list = filtered(settings);
  queue = ordered(list, settings.order, sessionSeed());
  const valid = new Set(list.map((e) => e.id));
  skipped = new Set([...skipped].filter((id) => valid.has(id)));
}

function current() {
  if (pinned !== null) {
    const entry = list.find((e) => e.id === pinned);
    if (entry) return entry;
    pinned = null;
  }
  return queue.find((e) => !hasVote(e.id) && !skipped.has(e.id)) ?? null;
}

const isLocked = () => Date.now() < lockedUntil;

function vote(score) {
  const entry = current();
  if (!entry || isLocked()) return;
  undoStack.push({ id: entry.id, prev: getVote(entry.id) });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  pinned = null;
  skipped.delete(entry.id);
  setVote(entry.id, score);
  renderStage();
}

function skip() {
  const entry = current();
  if (!entry || isLocked()) return;
  pinned = null;
  skipped.add(entry.id);
  renderStage();
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  if (last.prev === null) deleteVote(last.id);
  else setVote(last.id, last.prev);
  pinned = last.id;
  renderStage();
}

function preloadNext(entry) {
  const next = queue.filter((e) => e !== entry && !hasVote(e.id) && !skipped.has(e.id)).slice(0, 3);
  for (const e of next) new Image().src = spriteUrl(e);
}

/** Trava voto e pulo por um instante sempre que outro Pokémon aparece. */
function applySwitchLock(entry, grid) {
  clearTimeout(lockTimer);
  if (entry.id !== shownId) {
    shownId = entry.id;
    lockedUntil = Date.now() + SWITCH_DELAY_MS;
  }
  const remaining = lockedUntil - Date.now();
  if (remaining <= 0) return;
  grid.classList.add('is-locked');
  lockTimer = setTimeout(() => grid.classList.remove('is-locked'), remaining);
}

function renderStage() {
  if (!stage) return;
  const entry = current();
  const stats = progress(list, hasVote);
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': stats.total, 'aria-valuenow': stats.voted });
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${Math.min(100, stats.percent)}%`;
  bar.append(fill);

  const header = h('div', { class: 'stack-sm' },
    h('div', { class: 'row between' },
      h('strong', {}, `${stats.voted}/${stats.total}`),
      h('span', {}, `${stats.percent.toFixed(1)}%`)),
    bar);

  if (!entry) {
    stage.replaceChildren(header, h('div', { class: 'window center stack' },
      h('h2', {}, skipped.size ? 'Fim da fila' : 'Jornada completa!'),
      h('p', {}, skipped.size ? `Você pulou ${skipped.size} Pokémon.` : 'Todos deste filtro já têm nota.'),
      skipped.size > 0 && h('button', {
        type: 'button', class: 'btn btn-primary',
        onClick: () => { skipped.clear(); renderStage(); },
      }, 'Rever pulados'),
      undoStack.length > 0 && h('button', { type: 'button', class: 'btn', onClick: undo }, 'Desfazer (Z)')));
    return;
  }

  preloadNext(entry);
  const art = sprite(entry, 'sprite sprite-xl');
  art.loading = 'eager';
  const grid = h('div', { class: 'vote-grid' }, TIERS.map((t) => h('button', {
    type: 'button',
    class: `vote-btn tier-${t.code}`,
    'aria-label': `${t.code}: ${t.label}`,
    onClick: (e) => { e.currentTarget.blur(); vote(t.score); },
  }, h('kbd', {}, String(t.score)), h('b', {}, t.code), h('span', {}, t.label))));
  applySwitchLock(entry, grid);
  stage.replaceChildren(
    header,
    h('div', { class: 'window arena-card' },
      h('div', { class: 'arena-sprite' }, art),
      h('div', { class: 'dialogue' },
        h('p', { class: 'dex' }, dexLabel(entry.dex)),
        h('h2', { id: 'arena-name' }, entry.name),
        typeBadges(entry),
        h('p', {}, 'Vai para a panela?'))),
    grid,
    h('div', { class: 'row center-row' },
      h('button', { type: 'button', class: 'btn', onClick: (e) => { e.currentTarget.blur(); skip(); } }, 'Pular (Espaço)'),
      h('button', { type: 'button', class: 'btn', disabled: undoStack.length === 0, onClick: (e) => { e.currentTarget.blur(); undo(); } }, 'Desfazer (Z)')),
  );
}

function renderConfig(panel) {
  const change = (patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    pinned = null;
    rebuild();
    renderConfig(panel);
    renderStage();
  };
  const groupBox = (key, label) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox', checked: settings.groups[key],
      onChange: (e) => change({ groups: { ...settings.groups, [key]: e.target.checked } }),
    }), label);

  fill(panel,
    h('h2', {}, 'Jornada'),
    h('label', {}, 'Modo'),
    select(settings.journey, [['full', 'Jornada Completa'], ['generation', 'Seleção de Geração']], (journey) => change({ journey }), 'Modo'),
    settings.journey === 'generation' && select(settings.generation,
      Array.from({ length: 9 }, (_, i) => [i + 1, `Geração ${i + 1}`]), (g) => change({ generation: Number(g) }), 'Geração'),
    h('label', {}, 'Ordem'),
    select(settings.order, [['dex', 'Pokédex'], ['random', 'Aleatória'], ['alpha', 'Alfabética']], (order) => change({ order }), 'Ordem'),
    settings.order === 'random' && h('button', {
      type: 'button', class: 'btn',
      onClick: () => { sessionSeed(true); change({}); },
    }, 'Reembaralhar'),
    h('label', {}, 'Formas'),
    select(settings.forms, [['all', 'Incluir todas'], ['base', 'Apenas espécies base'], ['custom', 'Personalizar']], (forms) => change({ forms }), 'Formas'),
    settings.forms === 'custom' && h('div', { class: 'stack-sm' },
      groupBox('regional', 'Regionais'), groupBox('mega', 'Megas / Primal'), groupBox('special', 'Especiais / G-Max')),
    h('p', { class: 'hint' }, 'Teclas 1-5 votam. Espaço pula. Z ou Backspace desfaz.'),
    storeMode() === 'guest' && h('p', { class: 'warn' }, 'Modo visitante: seus votos ficam neste navegador e não pontuam nos rankings.'),
  );
}

function onKeyDown(e) {
  if (!active || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const target = e.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  const digit = e.code.match(/^(?:Digit|Numpad)([1-5])$/);
  if (digit) {
    e.preventDefault();
    vote(Number(digit[1]));
  } else if (e.code === 'Space') {
    if (target instanceof HTMLElement && /^(BUTTON|A)$/.test(target.tagName)) return; // ativa o foco atual
    e.preventDefault();
    skip();
  } else if (e.code === 'Backspace' || e.code === 'KeyZ') {
    e.preventDefault();
    undo();
  }
}

export function renderArena(container) {
  if (!keyboardBound) {
    document.addEventListener('keydown', onKeyDown);
    keyboardBound = true;
  }
  rebuild();
  active = true;
  stage = h('section', { class: 'stack arena-stage', 'aria-label': 'Votação' });
  const panel = h('aside', { class: 'window stack-sm arena-config' });
  container.append(h('div', { class: 'arena' }, stage, panel));
  renderConfig(panel);
  renderStage();
  return () => {
    active = false;
    stage = null;
  };
}

/** Limpa o estado de sessão ao trocar de conta. */
export function resetArena() {
  undoStack = [];
  skipped = new Set();
  pinned = null;
}
