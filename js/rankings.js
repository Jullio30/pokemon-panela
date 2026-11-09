// Ranking global 25+, ranking de amigos, Pokédex pessoal, amizades e comparador de formas.
import { supabase, isCloudEnabled } from './config.js';
import {
  entries, getEntry, matchesSearch, formsOf, multiFormSpecies,
} from './catalog.js';
import { allVotes, getVote, setVote, deleteVote, storeMode, storeEvents } from './storage.js';
import { getAccount, openAuthDialog } from './auth.js';
import {
  h, fill, sprite, typeBadges, tierBadge, tierPicker, dexLabel, fmt, debounce, toast, pager, select,
  GEN_OPTIONS, TYPE_OPTIONS, CATEGORY_OPTIONS, TIERS, errorText,
} from './ui.js';

const PAGE = 50;

function loginNotice(text) {
  return h('div', { class: 'window center stack' }, h('p', {}, text),
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAuthDialog() }, 'Entrar ou criar conta'));
}

const cloudNotice = () => h('div', { class: 'window center' },
  h('p', {}, 'Rankings indisponíveis: o Supabase ainda não foi configurado em js/config.js.'));

// ---------------- RANKINGS ----------------
export function renderRankings(container) {
  const f = { tab: 'global', generation: '', type: '', category: '', search: '', minVotes: 2, offset: 0 };
  const body = h('div', { class: 'stack' });
  const tabs = h('div', { class: 'tabs' });
  const controls = h('div', { class: 'filters' });
  let token = 0;

  const load = async () => {
    const mine = ++token;
    if (!isCloudEnabled) {
      body.replaceChildren(cloudNotice());
      return;
    }
    if (f.tab === 'friends' && !getAccount()) {
      body.replaceChildren(loginNotice('Crie uma conta para ver o ranking entre amigos.'));
      return;
    }
    body.replaceChildren(h('p', { class: 'center' }, 'Carregando...'));
    const shared = {
      p_generation: f.generation ? Number(f.generation) : null,
      p_type: f.type || null,
      p_category: f.category || null,
      p_search: f.search || null,
      p_limit: PAGE,
      p_offset: f.offset,
    };
    const { data, error } = f.tab === 'global'
      ? await supabase.rpc('get_global_ranking', shared)
      : await supabase.rpc('get_friends_ranking', { ...shared, p_min_votes: f.minVotes });
    if (mine !== token) return;
    if (error) {
      body.replaceChildren(h('p', { class: 'form-error' }, errorText(error)));
      return;
    }
    if (!data.length) {
      body.replaceChildren(h('div', { class: 'window center' }, h('p', {},
        f.tab === 'global' ? 'Nada aqui ainda: uma forma entra no ranking com 25 votos de contas qualificadas.' : 'Nenhum Pokémon atingiu o mínimo de votos no grupo.')));
      return;
    }
    const isGlobal = f.tab === 'global';
    const rows = data.map((r) => {
      const e = getEntry(r.pokemon_id);
      if (!e) return null;
      return h('tr', {},
        h('td', { class: 'num' }, String(r.rank_position)),
        h('td', {}, sprite(e, 'sprite sprite-sm')),
        h('td', {}, h('a', { href: `#formas/${e.dex}` }, e.name), h('div', { class: 'muted' }, dexLabel(e.dex))),
        h('td', { class: 'hide-sm' }, typeBadges(e)),
        isGlobal && h('td', { class: 'num' }, fmt(r.bayesian_score, 3)),
        h('td', { class: 'num' }, fmt(r.avg_score)),
        h('td', { class: 'num' }, String(r.total_votes)),
        h('td', {}, tierBadge(getVote(e.id))));
    });
    fill(body,
      h('div', { class: 'window table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Pos'), h('th', {}, ''), h('th', {}, 'Nome'), h('th', { class: 'hide-sm' }, 'Tipo'),
          isGlobal && h('th', {}, 'Score'), h('th', {}, 'Média'), h('th', {}, 'Votos'), h('th', {}, 'Você'))),
        h('tbody', {}, rows))),
      pager(f.offset, PAGE, Number(data[0].total_count), (offset) => { f.offset = offset; load(); }),
    );
  };

  const update = (patch) => {
    Object.assign(f, patch, { offset: 0 });
    load();
  };
  const debouncedSearch = debounce((search) => update({ search }), 250);

  const drawControls = () => {
    tabs.replaceChildren(
      h('button', { type: 'button', class: `tab ${f.tab === 'global' ? 'is-on' : ''}`, onClick: () => { f.tab = 'global'; drawControls(); update({}); } }, 'Global'),
      h('button', { type: 'button', class: `tab ${f.tab === 'friends' ? 'is-on' : ''}`, onClick: () => { f.tab = 'friends'; drawControls(); update({}); } }, 'Amigos'),
    );
    fill(controls,
      h('input', { type: 'search', placeholder: 'Nome ou #001', value: f.search, 'aria-label': 'Buscar', onInput: (e) => debouncedSearch(e.target.value) }),
      select(f.generation, GEN_OPTIONS, (generation) => update({ generation }), 'Geração'),
      select(f.type, TYPE_OPTIONS, (type) => update({ type }), 'Tipo'),
      select(f.category, CATEGORY_OPTIONS, (category) => update({ category }), 'Categoria'),
      f.tab === 'friends' && h('label', { class: 'check' }, 'Mín. votos',
        h('input', {
          type: 'number', min: 1, max: 500, value: f.minVotes, class: 'input-num',
          onChange: (e) => update({ minVotes: Math.max(1, Number(e.target.value) || 2) }),
        })),
    );
  };

  container.append(h('h1', {}, 'Ranking'), tabs, controls, body);
  drawControls();
  load();
}

// ---------------- POKÉDEX PESSOAL ----------------
export function renderPokedex(container) {
  const f = { search: '', tier: 'voted', offset: 0 };
  const PER = 60;
  const body = h('div', { class: 'stack' });

  const draw = () => {
    const votes = allVotes();
    const results = entries().filter((e) => {
      if (!matchesSearch(e, f.search)) return false;
      const v = votes.get(e.id);
      if (f.tier === 'voted') return Boolean(v);
      if (f.tier === 'none') return !v;
      if (f.tier === 'all') return true;
      return v?.s === Number(f.tier);
    });
    if (f.offset >= results.length) f.offset = Math.max(0, Math.floor((results.length - 1) / PER) * PER);
    const page = results.slice(f.offset, f.offset + PER);
    body.replaceChildren(
      h('div', { class: 'dex-list' }, page.map((e) => h('article', { class: 'window dex-row' },
        sprite(e, 'sprite sprite-sm'),
        h('div', { class: 'dex-info' },
          h('a', { href: `#formas/${e.dex}` }, e.name),
          h('div', { class: 'muted' }, dexLabel(e.dex)),
          typeBadges(e)),
        h('div', { class: 'dex-actions' },
          tierPicker(getVote(e.id), (score) => setVote(e.id, score)),
          getVote(e.id) !== null && h('button', { type: 'button', class: 'btn btn-sm', onClick: () => deleteVote(e.id) }, 'Excluir'))))),
      results.length === 0 ? h('p', { class: 'window center' }, 'Nada encontrado.') : pager(f.offset, PER, results.length, (offset) => { f.offset = offset; draw(); }),
    );
  };

  const debounced = debounce((search) => { f.search = search; f.offset = 0; draw(); }, 150);
  container.append(
    h('h1', {}, 'Pokédex Pessoal'),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Nome, #001 ou 1', 'aria-label': 'Buscar', onInput: (e) => debounced(e.target.value) }),
      select(f.tier, [['voted', 'Todos os votados'], ['none', 'Sem voto'], ['all', 'Tudo'],
        ...TIERS.map((t) => [t.score, `${t.code}: ${t.label}`])], (tier) => { f.tier = tier; f.offset = 0; draw(); }, 'Nota')),
    body,
  );
  storeEvents.addEventListener('change', draw);
  draw();
  return () => storeEvents.removeEventListener('change', draw);
}

// ---------------- COMPARADOR DE FORMAS ----------------
export function renderCompare(container, param) {
  const dex = Number(param);
  container.append(h('h1', {}, 'Comparar Formas'));

  if (!dex) {
    const grid = h('div', { class: 'species-grid' });
    const draw = (q = '') => grid.replaceChildren(...multiFormSpecies().filter((e) => matchesSearch(e, q)).map((e) => h('a', { class: 'window species-cell', href: `#formas/${e.dex}` },
      sprite(e, 'sprite sprite-sm'), h('span', {}, e.name))));
    container.append(
      h('div', { class: 'filters' }, h('input', { type: 'search', placeholder: 'Nome ou número', 'aria-label': 'Buscar espécie', onInput: debounce((e) => draw(e.target.value), 150) })),
      grid,
    );
    draw();
    return undefined;
  }

  const forms = formsOf(dex);
  if (!forms.length) {
    container.append(h('p', { class: 'window center' }, 'Espécie não encontrada.'));
    return undefined;
  }

  const grid = h('div', { class: 'compare-grid' });
  let remote = new Map();
  const cell = (label, rank, avg, votes) => h('div', { class: 'stat-line' },
    h('b', {}, label),
    rank ? h('span', {}, `${rank}º, média ${fmt(avg)} (${votes})`) : h('span', { class: 'muted' }, 'Sem dados suficientes'));

  const draw = () => grid.replaceChildren(...forms.map((e) => {
    const r = remote.get(e.id);
    return h('article', { class: 'window stack-sm center' },
      sprite(e, 'sprite sprite-lg'),
      h('h2', {}, e.name),
      typeBadges(e),
      tierPicker(getVote(e.id), (score) => setVote(e.id, score)),
      getVote(e.id) !== null && h('button', { type: 'button', class: 'btn btn-sm', onClick: () => deleteVote(e.id) }, 'Excluir voto'),
      cell('Global', r?.global_rank, r?.global_avg, r?.global_votes),
      storeMode() === 'cloud' && cell('Amigos', r?.friends_rank, r?.friends_avg, r?.friends_votes));
  }));

  container.append(h('p', {}, h('a', { href: '#formas' }, '< Todas as espécies')), grid);
  storeEvents.addEventListener('change', draw);
  draw();
  if (isCloudEnabled) {
    supabase.rpc('get_form_comparison', { p_dex: dex }).then(({ data, error }) => {
      if (error) {
        toast(errorText(error), 'error');
        return;
      }
      remote = new Map(data.map((r) => [r.pokemon_id, r]));
      draw();
    });
  }
  return () => storeEvents.removeEventListener('change', draw);
}

// ---------------- AMIZADES ----------------
export function renderFriends(container) {
  container.append(h('h1', {}, 'Amigos'));
  if (!isCloudEnabled) {
    container.append(cloudNotice());
    return;
  }
  if (!getAccount()) {
    container.append(loginNotice('Crie uma conta para adicionar amigos.'));
    return;
  }

  const results = h('div', { class: 'stack-sm' });
  const lists = h('div', { class: 'stack' });
  const userLine = (u, ...actions) => h('div', { class: 'user-line' },
    u.avatar_id && getEntry(u.avatar_id) ? sprite(getEntry(u.avatar_id), 'sprite sprite-sm') : h('span', { class: 'sprite-sm' }),
    h('a', { href: `?u=${encodeURIComponent(u.username)}` }, u.username),
    h('span', { class: 'muted' }, `${u.vote_count} votos`),
    h('span', { class: 'row' }, actions));

  const call = async (fn, args, ok) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      toast(errorText(error), 'error');
      return;
    }
    if (ok) toast(typeof ok === 'function' ? ok(data) : ok);
    await loadFriends();
  };

  const btn = (label, onClick, primary) => h('button', { type: 'button', class: `btn btn-sm ${primary ? 'btn-primary' : ''}`, onClick }, label);

  async function loadFriends() {
    const { data, error } = await supabase.rpc('get_my_friends');
    if (error) {
      lists.replaceChildren(h('p', { class: 'form-error' }, errorText(error)));
      return;
    }
    const section = (title, rows, make, empty) => h('section', { class: 'window stack-sm' },
      h('h2', {}, `${title} (${rows.length})`),
      rows.length ? rows.map(make) : h('p', { class: 'muted' }, empty));
    lists.replaceChildren(
      section('Convites recebidos', data.filter((d) => d.status === 'pending' && d.direction === 'incoming'),
        (d) => userLine(d,
          btn('Aceitar', () => call('respond_friend_request', { p_friendship_id: d.friendship_id, p_accept: true }, 'Convite aceito.'), true),
          btn('Recusar', () => call('respond_friend_request', { p_friendship_id: d.friendship_id, p_accept: false }))), 'Nenhum convite.'),
      section('Convites enviados', data.filter((d) => d.status === 'pending' && d.direction === 'outgoing'),
        (d) => userLine(d, btn('Cancelar', () => call('remove_friendship', { p_friendship_id: d.friendship_id }))), 'Nenhum convite pendente.'),
      section('Amigos', data.filter((d) => d.status === 'accepted'),
        (d) => userLine(d, btn('Remover', () => call('remove_friendship', { p_friendship_id: d.friendship_id }))), 'Busque treinadores acima.'),
    );
  }

  const search = debounce(async (q) => {
    if (q.trim().length < 2) {
      results.replaceChildren();
      return;
    }
    const { data, error } = await supabase.rpc('search_profiles', { p_query: q });
    if (error) {
      toast(errorText(error), 'error');
      return;
    }
    const messages = {
      sent: 'Convite enviado.', accepted: 'Agora vocês são amigos!', already_sent: 'Convite já enviado.', already_friends: 'Vocês já são amigos.',
    };
    results.replaceChildren(...(data.length ? data.map((u) => userLine(u,
      btn('Convidar', () => call('send_friend_request', { p_user: u.id }, (r) => messages[r] ?? r), true))) : [h('p', { class: 'muted' }, 'Ninguém encontrado.')]));
  }, 300);

  container.append(
    h('section', { class: 'window stack-sm' },
      h('h2', {}, 'Buscar treinador'),
      h('input', { type: 'search', placeholder: 'Nome de usuário', 'aria-label': 'Buscar treinador', onInput: (e) => search(e.target.value) }),
      results),
    lists,
  );
  loadFriends();
}
