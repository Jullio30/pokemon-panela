// Painel administrativo. Esconder a tela é só conveniência:
// a autorização real está em public.is_admin(), dentro de cada RPC.
import { supabase } from './config.js';
import { getAccount } from './auth.js';
import { allEntries, isInactive, matchesSearch, setInactive } from './catalog.js';
import {
  h, sprite, dexLabel, toast, debounce, pager, choose, openDialog, errorText,
} from './ui.js';

const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    toast(errorText(error), 'error');
    return null;
  }
  return data ?? true;
};

function usersTab(body) {
  const f = { search: '', offset: 0 };
  const PER = 50;
  const list = h('div', { class: 'stack-sm' });

  const askReason = () => openDialog((close) => {
    const input = h('input', { maxlength: 300, 'aria-label': 'Motivo' });
    return h('div', { class: 'stack' }, h('h2', {}, 'Banir conta'), h('label', {}, 'Motivo'), input,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close(input.value.trim() || 'Sem motivo informado') }, 'Banir'),
        h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'Cancelar')));
  });

  const load = async () => {
    const data = await rpc('admin_list_users', { p_search: f.search || null, p_limit: PER, p_offset: f.offset });
    if (!data || data === true) return;
    const total = data.length ? Number(data[0].total_count) : 0;
    list.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Usuário', 'Votos', 'Qualif.', 'Status', 'Ação'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.map((u) => h('tr', {},
          h('td', {}, u.username, u.is_admin ? ' [admin]' : ''),
          h('td', { class: 'num' }, String(u.vote_count)),
          h('td', {}, u.is_qualified ? 'Sim' : 'Não'),
          h('td', {}, u.is_banned ? `Banido: ${u.ban_reason ?? ''}` : 'Ativo'),
          h('td', {}, u.id === getAccount().id ? '-' : h('button', {
            type: 'button', class: 'btn btn-sm',
            onClick: async () => {
              let reason = null;
              if (!u.is_banned) {
                reason = await askReason();
                if (!reason) return;
              }
              if (await rpc('admin_set_ban', { p_user: u.id, p_banned: !u.is_banned, p_reason: reason })) {
                toast('Conta atualizada e ranking recalculado.');
                load();
              }
            },
          }, u.is_banned ? 'Desbanir' : 'Banir'))))))),
      pager(f.offset, PER, total, (offset) => { f.offset = offset; load(); }),
    );
  };

  body.replaceChildren(
    h('input', { type: 'search', placeholder: 'Buscar usuário', 'aria-label': 'Buscar usuário', onInput: debounce((e) => { f.search = e.target.value; f.offset = 0; load(); }, 250) }),
    list,
  );
  load();
}

function formsTab(body) {
  const list = h('div', { class: 'stack-sm' });
  const f = { q: '', offset: 0 };
  const PER = 40;

  const draw = () => {
    const results = allEntries().filter((e) => e.cat !== 'base' && matchesSearch(e, f.q));
    list.replaceChildren(
      ...results.slice(f.offset, f.offset + PER).map((e) => h('div', { class: 'user-line' },
        sprite(e, 'sprite sprite-sm'),
        h('span', {}, `${dexLabel(e.dex)} ${e.name}`),
        h('span', { class: 'muted' }, isInactive(e.id) ? 'Inativa' : 'Ativa'),
        h('button', {
          type: 'button', class: 'btn btn-sm',
          onClick: async () => {
            const next = isInactive(e.id);
            if (await rpc('admin_set_form_active', { p_pokemon_id: e.id, p_active: next })) {
              const ids = allEntries().filter((x) => isInactive(x.id)).map((x) => x.id).filter((id) => id !== e.id);
              setInactive(next ? ids : [...ids, e.id]);
              draw();
            }
          },
        }, isInactive(e.id) ? 'Ativar' : 'Desativar'))),
      pager(f.offset, PER, results.length, (offset) => { f.offset = offset; draw(); }),
    );
  };

  body.replaceChildren(
    h('input', { type: 'search', placeholder: 'Buscar forma', 'aria-label': 'Buscar forma', onInput: debounce((e) => { f.q = e.target.value; f.offset = 0; draw(); }, 150) }),
    list,
  );
  draw();
}

function auditTab(body) {
  const button = h('button', {
    type: 'button', class: 'btn btn-primary',
    onClick: async () => {
      const ok = await choose('Recalcular', 'Recalcular integralmente pokemon_stats agora?', [
        { label: 'Recalcular', value: true, primary: true }, { label: 'Cancelar', value: false },
      ]);
      if (!ok) return;
      button.disabled = true;
      const data = await rpc('recalculate_all_pokemon_stats');
      button.disabled = false;
      if (data) toast(`Concluído: ${data.rows} linhas, ${data.drift_fixed} corrigidas.`);
    },
  }, 'Auditar e recalcular estatísticas');
  body.replaceChildren(button);
}

function logsTab(body) {
  const f = { offset: 0 };
  const PER = 100;
  const load = async () => {
    const data = await rpc('admin_get_audit_logs', { p_limit: PER, p_offset: f.offset });
    if (!data || data === true) return;
    body.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Data', 'Admin', 'Ação', 'Alvo', 'Detalhes'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.map((l) => h('tr', {},
          h('td', {}, new Date(l.created_at).toLocaleString('pt-BR')),
          h('td', {}, l.admin_username ?? '-'),
          h('td', {}, l.action),
          h('td', {}, l.target ?? '-'),
          h('td', {}, JSON.stringify(l.details))))))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', disabled: f.offset === 0, onClick: () => { f.offset = Math.max(0, f.offset - PER); load(); } }, '< Ant'),
        h('button', { type: 'button', class: 'btn', disabled: data.length < PER, onClick: () => { f.offset += PER; load(); } }, 'Próx >')),
    );
  };
  load();
}

export function renderAdmin(container) {
  if (!getAccount()?.is_admin) {
    container.append(h('p', { class: 'window center' }, 'Acesso restrito.'));
    return;
  }
  const body = h('div', { class: 'window stack-sm' });
  const defs = [['Usuários', usersTab], ['Formas', formsTab], ['Auditoria', auditTab], ['Logs', logsTab]];
  const tabs = h('div', { class: 'tabs' });
  const activate = (index) => {
    tabs.replaceChildren(...defs.map(([label], i) => h('button', {
      type: 'button', class: `tab ${i === index ? 'is-on' : ''}`, onClick: () => activate(i),
    }, label)));
    body.replaceChildren();
    defs[index][1](body);
  };
  container.append(h('h1', {}, 'Administração'), tabs, body);
  activate(0);
}
