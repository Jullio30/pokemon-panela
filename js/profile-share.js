// Perfis públicos, conquistas e gerador de imagem em Canvas 2D.
import { supabase, isCloudEnabled } from './config.js';
import { entries, getEntry, matchesSearch, spriteUrl } from './catalog.js';
import { allVotes, storeMode } from './storage.js';
import { getAccount, authEvents, openAuthDialog } from './auth.js';
import {
  h, fill, sprite, TIERS, TYPE_NAMES, fmt, toast, debounce, errorText,
} from './ui.js';

const MIN_FAVORITE_VOTES = 5;

const POT = [
  '................',
  '.....XXXXXX.....',
  '....X......X....',
  '...XXXXXXXXXX...',
  '.XXXXXXXXXXXXXX.',
  'X.XOOOOOOOOOOX.X',
  'X.XOOOOOOOOOOX.X',
  '.XXOWWOOOOOOOXX.',
  '..XOWOOOOOOOOX..',
  '..XOOOOOOOOOOX..',
  '..XOOOOOOOOOOX..',
  '..XOOOOOOOOODX..',
  '...XOOOOOOODX...',
  '....XXXXXXXX....',
  '................',
  '................',
];

const MEDALS = [
  { id: 'first', name: 'Primeira Colherada', hint: '1 voto', color: '#c86838', test: (s) => s.voted >= 1 },
  { id: 'cook', name: 'Aprendiz', hint: '50 votos', color: '#58a048', test: (s) => s.voted >= 50 },
  { id: 'sous', name: 'Subchef', hint: '250 votos', color: '#3878c8', test: (s) => s.voted >= 250 },
  { id: 'chef', name: 'Chef da Dex', hint: '1025 votos', color: '#e8b828', test: (s) => s.voted >= 1025 },
  { id: 'gen', name: 'Geração Completa', hint: 'Complete uma geração', color: '#a050c0', test: (s) => s.by_generation.some((g) => g.total > 0 && g.votes >= g.total) },
  { id: 'forms', name: 'Mil Faces', hint: '50 formas', color: '#d04878', test: (s) => s.forms_voted >= 50 },
  { id: 'legend', name: 'Caldo Lendário', hint: '30 especiais', color: '#30a8a8', test: (s) => s.special_class_voted >= 30 },
  { id: 'harsh', name: 'Paladar Exigente', hint: '25 notas D', color: '#685878', test: (s) => (s.distribution[1] ?? 0) >= 25 },
];

function drawMedal(ctx, x, y, scale, color, earned) {
  const palette = {
    X: earned ? '#283040' : '#a8a8a0', O: earned ? color : '#d0d0c8', W: earned ? '#f8f8f0' : '#e0e0d8', D: earned ? '#283040' : '#b8b8b0',
  };
  POT.forEach((row, ry) => [...row].forEach((ch, rx) => {
    if (ch === '.') return;
    ctx.fillStyle = palette[ch];
    ctx.fillRect(x + rx * scale, y + ry * scale, scale, scale);
  }));
}

/** Mesma forma de dados que get_public_profile devolve em `stats`. */
export function computeLocalStats() {
  const votes = allVotes();
  const gens = new Map();
  const types = new Map();
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const mine = [];
  let forms = 0;
  let special = 0;
  for (const e of entries()) {
    const g = gens.get(e.sg) ?? { gen: e.sg, total: 0, votes: 0, sum: 0 };
    g.total += 1;
    gens.set(e.sg, g);
    const v = votes.get(e.id);
    if (!v) continue;
    g.votes += 1;
    g.sum += v.s;
    distribution[v.s] += 1;
    mine.push({ id: e.id, ...v });
    if (e.cat !== 'base') forms += 1;
    if (e.cls) special += 1;
    for (const type of e.types) {
      const t = types.get(type) ?? { type, votes: 0, sum: 0 };
      t.votes += 1;
      t.sum += v.s;
      types.set(type, t);
    }
  }
  const avg = (x) => (x.votes ? x.sum / x.votes : null);
  return {
    voted: mine.length,
    total: entries().length,
    forms_voted: forms,
    special_class_voted: special,
    distribution,
    by_generation: [...gens.values()].sort((a, b) => a.gen - b.gen).map((g) => ({ gen: g.gen, total: g.total, votes: g.votes, avg: avg(g) })),
    by_type: [...types.values()].map((t) => ({ type: t.type, votes: t.votes, avg: avg(t) })),
    top6: mine.sort((a, b) => b.s - a.s || b.t - a.t || a.id - b.id).slice(0, 6).map((m) => m.id),
  };
}

function favorite(rows) {
  return rows.filter((r) => r.votes >= MIN_FAVORITE_VOTES)
    .sort((a, b) => Number(b.avg) - Number(a.avg) || b.votes - a.votes)[0] ?? null;
}

const profileUrl = (username) => `${location.origin}${location.pathname}?u=${encodeURIComponent(username)}`;

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function buildCard(name, stats) {
  await Promise.all([document.fonts.load('28px "Press Start 2P"'), document.fonts.load('16px "Press Start 2P"')]).catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const rect = (x, y, w, h2, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h2);
  };
  const text = (value, x, y, size, color = '#283040', align = 'left') => {
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(value, x, y);
  };

  rect(0, 0, 1200, 630, '#283040');
  rect(8, 8, 1184, 614, '#e8b058');
  rect(16, 16, 1168, 598, '#f8f8e8');
  rect(16, 16, 1168, 88, '#c83838');
  rect(16, 104, 1168, 8, '#283040');
  text('CARTÃO DE TREINADOR', 44, 34, 22, '#f8f8e8');
  text('HALL DA PANELA', 44, 68, 16, '#f8d878');

  const shown = name.length > 20 ? name.slice(0, 20) : name;
  text(shown, 44, 140, 24);

  const lines = [
    ['Votados', String(stats.voted)],
    ['Pokédex', `${stats.total ? ((stats.voted / stats.total) * 100).toFixed(1) : '0.0'}%`],
    ['Gen fav', favorite(stats.by_generation) ? `G${favorite(stats.by_generation).gen}` : '-'],
    ['Tipo fav', favorite(stats.by_type) ? (TYPE_NAMES[favorite(stats.by_type).type] ?? '-') : '-'],
  ];
  lines.forEach(([label, value], i) => {
    text(label, 44, 196 + i * 42, 16, '#586878');
    text(value, 520, 196 + i * 42, 16, '#283040', 'right');
  });
  TIERS.forEach((t, i) => {
    text(t.code, 44 + i * 96, 376, 16, '#c83838');
    text(String(stats.distribution[t.score] ?? 0), 72 + i * 96, 376, 12);
  });

  rect(560, 128, 600, 400, '#283040');
  rect(564, 132, 592, 392, '#d8e8c8');
  const images = await Promise.all(stats.top6.map((id) => {
    const e = getEntry(id);
    return e ? loadImage(spriteUrl(e)) : null;
  }));
  images.forEach((img, i) => {
    if (!img) return;
    const size = 192;
    ctx.drawImage(img, 572 + (i % 3) * 192, 136 + Math.floor(i / 3) * 192, size, size);
  });

  rect(44, 416, 480, 4, '#283040');
  text('Insígnias', 44, 432, 14, '#586878');
  MEDALS.forEach((m, i) => {
    drawMedal(ctx, 44 + (i % 4) * 88, 456 + Math.floor(i / 4) * 68, 4, m.color, m.test(stats));
  });

  text('Pokémon Panela', 1160, 556, 16, '#c83838', 'right');
  text('Projeto de fã, sem vínculo oficial', 1160, 586, 10, '#586878', 'right');
  return canvas;
}

function shareBar(name, stats, shareable) {
  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const filename = `panela-${name}.png`;

  const download = async () => {
    const blob = await toBlob(await buildCard(name, stats));
    if (!blob) {
      toast('Não foi possível gerar a imagem.', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    h('a', { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const share = async () => {
    const blob = await toBlob(await buildCard(name, stats));
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Pokémon Panela', url: shareable ? profileUrl(name) : undefined });
      } catch { /* cancelado */ }
    } else {
      toast('Compartilhamento indisponível aqui; use Baixar PNG.');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl(name));
      toast('Link copiado.');
    } catch {
      toast(profileUrl(name));
    }
  };

  return h('div', { class: 'row wrap' },
    h('button', { type: 'button', class: 'btn btn-primary', onClick: download }, 'Baixar PNG'),
    navigator.share && h('button', { type: 'button', class: 'btn', onClick: share }, 'Compartilhar'),
    shareable && h('button', { type: 'button', class: 'btn', onClick: copy }, 'Copiar link'));
}

function medalBoard(stats) {
  return h('div', { class: 'medals' }, MEDALS.map((m) => {
    const earned = m.test(stats);
    const c = h('canvas', { width: 16, height: 16, class: 'medal-canvas' });
    drawMedal(c.getContext('2d'), 0, 0, 1, m.color, earned);
    return h('div', { class: `medal ${earned ? 'is-earned' : ''}`, title: m.hint }, c, h('b', {}, m.name), h('span', { class: 'muted' }, m.hint));
  }));
}

function statsView(profile) {
  const { stats } = profile;
  const percent = stats.total ? (stats.voted / stats.total) * 100 : 0;
  const bar = h('div', { class: 'bar' });
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${Math.min(100, percent)}%`;
  bar.append(fill);
  const favGen = favorite(stats.by_generation);
  const favType = favorite(stats.by_type);
  const max = Math.max(1, ...Object.values(stats.distribution).map(Number));

  return h('div', { class: 'profile-grid' },
    h('section', { class: 'window stack-sm' },
      h('h2', {}, 'Estatísticas'),
      h('div', { class: 'stat-line' }, h('b', {}, 'Votados'), h('span', {}, `${stats.voted}/${stats.total}`)),
      bar,
      h('div', { class: 'stat-line' }, h('b', {}, 'Geração favorita'), h('span', {}, favGen ? `Geração ${favGen.gen} (${fmt(favGen.avg)})` : '-')),
      h('div', { class: 'stat-line' }, h('b', {}, 'Tipo favorito'), h('span', {}, favType ? `${TYPE_NAMES[favType.type]} (${fmt(favType.avg)})` : '-')),
      h('div', { class: 'dist' }, TIERS.map((t) => {
        const n = Number(stats.distribution[t.score] ?? 0);
        const f = h('div', { class: `dist-fill tier-${t.code}` });
        f.style.width = `${(n / max) * 100}%`;
        return h('div', { class: 'dist-row' }, h('b', {}, t.code), h('div', { class: 'dist-track' }, f), h('span', {}, String(n)));
      }))),
    h('section', { class: 'window stack-sm' },
      h('h2', {}, 'Top 6'),
      stats.top6.length ? h('div', { class: 'top6' }, stats.top6.map((id) => {
        const e = getEntry(id);
        return e ? h('a', { href: `#formas/${e.dex}`, class: 'center' }, sprite(e, 'sprite sprite-lg'), h('div', {}, e.name)) : null;
      })) : h('p', { class: 'muted' }, 'Ainda sem votos.')),
    h('section', { class: 'window stack-sm profile-wide' }, h('h2', {}, 'Insígnias'), medalBoard(stats)));
}

function avatarOf(id) {
  const e = id ? getEntry(id) : null;
  return e ? sprite(e, 'sprite sprite-lg') : h('span', { class: 'avatar-empty' }, '?');
}

function editForm(account, onSaved) {
  let avatar = account.avatar_id;
  const preview = h('div', {}, avatarOf(avatar));
  const results = h('div', { class: 'avatar-results' });
  const bio = h('textarea', { maxlength: 160, rows: 3, 'aria-label': 'Bio' });
  bio.value = account.bio ?? '';
  const search = debounce((q) => {
    results.replaceChildren(...(q.trim() ? entries().filter((e) => matchesSearch(e, q)).slice(0, 16).map((e) => h('button', {
      type: 'button', class: 'avatar-pick', title: e.name,
      onClick: () => { avatar = e.id; preview.replaceChildren(avatarOf(avatar)); },
    }, sprite(e, 'sprite sprite-sm'))) : []));
  }, 150);
  const save = async () => {
    const { error } = await supabase.from('profiles').update({ avatar_id: avatar, bio: bio.value.trim() }).eq('id', account.id);
    if (error) {
      toast(errorText(error), 'error');
      return;
    }
    account.avatar_id = avatar;
    account.bio = bio.value.trim();
    toast('Perfil salvo.');
    onSaved();
  };
  return h('section', { class: 'window stack-sm' },
    h('h2', {}, 'Editar perfil'),
    preview,
    h('input', { type: 'search', placeholder: 'Buscar avatar', 'aria-label': 'Buscar avatar', onInput: (e) => search(e.target.value) }),
    results,
    h('label', {}, 'Bio (até 160)'),
    bio,
    h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Salvar'));
}

function header(name, avatarId, bio) {
  return h('section', { class: 'window profile-head' },
    avatarOf(avatarId),
    h('div', { class: 'stack-sm' }, h('h1', {}, name), bio ? h('p', {}, bio) : null));
}

export function renderProfile(container, username) {
  let disposed = false;
  const draw = async () => {
    const mine = getAccount();
    container.replaceChildren(h('p', { class: 'center' }, 'Carregando...'));

    if (!username && storeMode() === 'guest') {
      const profile = { stats: computeLocalStats() };
      fill(container,
        header('Visitante', null, 'Estatísticas salvas neste navegador.'),
        h('div', { class: 'row wrap' },
          isCloudEnabled && h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAuthDialog('signup') }, 'Criar conta'),
          shareBar('Visitante', profile.stats, false)),
        statsView(profile),
      );
      return;
    }

    if (!isCloudEnabled) {
      container.replaceChildren(h('p', { class: 'window center' }, 'Perfis indisponíveis: o Supabase ainda não foi configurado.'));
      return;
    }
    const target = username ?? mine.username;
    const { data, error } = await supabase.rpc('get_public_profile', { p_username: target });
    if (disposed) return;
    if (error || !data) {
      container.replaceChildren(h('p', { class: 'window center' }, error ? errorText(error) : 'Treinador não encontrado.'));
      return;
    }
    const isSelf = mine && mine.id === data.id;
    fill(container,
      header(data.username, data.avatar_id, data.bio),
      mine?.is_banned && isSelf ? h('p', { class: 'form-error window' }, `Conta suspensa. ${mine.ban_reason ?? ''}`) : null,
      shareBar(data.username, data.stats, true),
      statsView(data),
      ...(isSelf ? [editForm(mine, draw)] : []),
    );
  };
  authEvents.addEventListener('change', draw);
  draw();
  return () => {
    disposed = true;
    authEvents.removeEventListener('change', draw);
  };
}
