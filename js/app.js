// Inicialização, navegação e roteamento por hash.
import { supabase, isCloudEnabled } from './config.js';
import { loadCatalog, setInactive } from './catalog.js';
import { initAuth, authEvents, getAccount, openAuthDialog, signOut } from './auth.js';
import { renderArena, resetArena } from './voting.js';
import { renderRankings, renderPokedex, renderCompare, renderFriends } from './rankings.js';
import { renderProfile } from './profile-share.js';
import { renderAdmin } from './admin.js';
import { h, toast, errorText } from './ui.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let dispose = null;

const ROUTES = {
  arena: renderArena,
  pokedex: renderPokedex,
  formas: renderCompare,
  ranking: renderRankings,
  amigos: renderFriends,
  perfil: (el) => renderProfile(el, null),
  admin: renderAdmin,
};

function currentRoute() {
  const hash = location.hash.replace(/^#/, '');
  const shared = new URLSearchParams(location.search).get('u');
  if (!hash && shared) return { name: 'public', shared };
  const [name, param] = hash.split('/');
  return { name: ROUTES[name] ? name : 'arena', param };
}

function route() {
  dispose?.();
  dispose = null;
  view.replaceChildren();
  const r = currentRoute();
  dispose = (r.name === 'public' ? renderProfile(view, r.shared) : ROUTES[r.name](view, r.param)) ?? null;
  drawNav(r.name);
  window.scrollTo(0, 0);
}

function drawNav(active) {
  const account = getAccount();
  const links = [
    ['arena', 'Arena'], ['pokedex', 'Pokédex'], ['formas', 'Formas'], ['ranking', 'Ranking'],
    ['amigos', 'Amigos'], ['perfil', 'Perfil'], ...(account?.is_admin ? [['admin', 'Admin']] : []),
  ];
  // Com ?u= na URL, a navegação precisa sair do perfil compartilhado sem recarregar lógica extra.
  nav.replaceChildren(
    ...links.map(([id, label]) => h('a', { href: `#${id}`, class: `nav-link ${active === id ? 'is-on' : ''}`, 'aria-current': active === id ? 'page' : undefined }, label)),
    account
      ? h('button', { type: 'button', class: 'nav-link', onClick: () => signOut().catch((e) => toast(errorText(e), 'error')) }, `Sair (${account.username})`)
      : h('button', { type: 'button', class: 'nav-link', onClick: () => openAuthDialog() }, 'Entrar'),
  );
}

async function loadInactive() {
  if (!isCloudEnabled) return;
  const { data, error } = await supabase.from('pokemon_catalog').select('pokemon_id').eq('is_active', false);
  if (!error) setInactive(data.map((r) => r.pokemon_id));
}

async function main() {
  try {
    await loadCatalog();
  } catch (err) {
    view.replaceChildren(h('p', { class: 'window center form-error' }, `Falha ao carregar o catálogo: ${err.message}`));
    return;
  }
  await loadInactive();
  await initAuth();
  window.addEventListener('hashchange', route);
  authEvents.addEventListener('change', () => {
    resetArena();
    const name = currentRoute().name;
    drawNav(name);
    if (name !== 'perfil' && name !== 'public') route();
  });
  route();
}

main();
