// Utilitários de DOM. Todo texto passa por text nodes; innerHTML não é usado.
import { spriteUrl } from './catalog.js';

export const TIERS = [
  { score: 5, code: 'S', label: 'Panela de Ouro' },
  { score: 4, code: 'A', label: 'Na Panela' },
  { score: 3, code: 'B', label: 'Neutro' },
  { score: 2, code: 'C', label: 'Fora da Panela' },
  { score: 1, code: 'D', label: 'Fundo da Panela' },
];
export const tierOf = (score) => TIERS.find((t) => t.score === score);

export const TYPE_NAMES = {
  normal: 'Normal', fire: 'Fogo', water: 'Água', electric: 'Elétrico', grass: 'Planta', ice: 'Gelo',
  fighting: 'Lutador', poison: 'Veneno', ground: 'Terra', flying: 'Voador', psychic: 'Psíquico', bug: 'Inseto',
  rock: 'Pedra', ghost: 'Fantasma', dragon: 'Dragão', dark: 'Sombrio', steel: 'Aço', fairy: 'Fada',
};

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/** replaceChildren que ignora valores falsos, como h() faz com os filhos. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

export const dexLabel =(n) => `#${String(n).padStart(4, '0')}`;
export const fmt = (n, digits = 2) => (n === null || n === undefined ? '-' : Number(n).toFixed(digits));

export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function sprite(entry, className = 'sprite') {
  const img = h('img', {
    class: className, src: spriteUrl(entry), alt: entry.name, loading: 'lazy', width: 96, height: 96,
  });
  img.addEventListener('error', () => img.classList.add('sprite-missing'), { once: true });
  return img;
}

export const typeBadges = (entry) => h('span', { class: 'types' },
  entry.types.map((t) => h('span', { class: `type type-${t}` }, TYPE_NAMES[t] ?? t)));

export function tierBadge(score) {
  const tier = tierOf(score);
  return tier
    ? h('span', { class: `tier tier-${tier.code}`, title: tier.label }, tier.code)
    : h('span', { class: 'tier tier-none', title: 'Sem voto' }, '-');
}

/** Linha de 5 botões de nota; `onPick(score)`. */
export function tierPicker(current, onPick) {
  return h('div', { class: 'tier-picker', role: 'group', 'aria-label': 'Nota' },
    TIERS.map((t) => h('button', {
      type: 'button',
      class: `tier tier-${t.code}${t.score === current ? ' is-on' : ''}`,
      title: t.label,
      'aria-pressed': t.score === current ? 'true' : 'false',
      onClick: () => onPick(t.score),
    }, t.code)));
}

export function toast(message, kind = 'info') {
  const region = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  region.append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Abre um diálogo modal. Retorna o valor passado a close(). */
export function openDialog(build) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'gba-dialog' });
    let result;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.append(build(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function choose(title, message, options) {
  return openDialog((close) => h('div', { class: 'stack' },
    h('h2', {}, title),
    h('p', {}, message),
    h('div', { class: 'row wrap' }, options.map((o) => h('button', {
      type: 'button', class: `btn ${o.primary ? 'btn-primary' : ''}`, onClick: () => close(o.value),
    }, o.label)))));
}

export function pager(offset, limit, total, onChange) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return h('div', { class: 'pager' },
    h('button', { type: 'button', class: 'btn', disabled: offset <= 0, onClick: () => onChange(Math.max(0, offset - limit)) }, '< Ant'),
    h('span', {}, `Página ${page}/${pages} (${total})`),
    h('button', { type: 'button', class: 'btn', disabled: page >= pages, onClick: () => onChange(offset + limit) }, 'Próx >'));
}

export function select(value, options, onChange, label) {
  return h('select', { 'aria-label': label, onChange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
}

export const GEN_OPTIONS = [['', 'Todas as gerações'], ...Array.from({ length: 9 }, (_, i) => [String(i + 1), `Geração ${i + 1}`])];
export const TYPE_OPTIONS = [['', 'Todos os tipos'], ...Object.entries(TYPE_NAMES)];
export const CATEGORY_OPTIONS = [
  ['', 'Todas as categorias'], ['legendary', 'Lendários'], ['mythical', 'Míticos'], ['paradox', 'Paradoxo'], ['forms', 'Formas'],
];

export function errorText(err) {
  const msg = err?.message ?? String(err);
  if (msg.includes('rate_limited')) return 'Muitas ações em pouco tempo. Aguarde um instante.';
  if (msg.includes('forbidden') || err?.code === '42501') return 'Ação não permitida para esta conta.';
  if (msg.includes('Failed to fetch')) return 'Sem conexão com o servidor.';
  return `Erro: ${msg}`;
}
