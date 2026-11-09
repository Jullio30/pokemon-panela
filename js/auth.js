// Cadastro/login por username sintético, sessão e migração de visitante.
import { supabase, isCloudEnabled, SYNTHETIC_EMAIL_DOMAIN } from './config.js';
import {
  useCloud, useGuest, guestVoteCount, guestVotesPayload, clearGuestState, flushWrites,
} from './storage.js';
import { h, openDialog, choose, toast, errorText } from './ui.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

export const authEvents = new EventTarget();
let account = null;

export const getAccount = () => account;
const syntheticEmail = (username) => `${username.toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`;

export function usernameError(username) {
  if (!USERNAME_RE.test(username)) return 'Use de 3 a 20 caracteres: letras, números, _ . ou -';
  // O servidor de autenticação valida o e-mail sintético e recusa pontos nestas posições.
  if (/^\.|\.$|\.\./.test(username)) return 'O usuário não pode começar ou terminar com ponto, nem ter pontos seguidos.';
  return null;
}

async function loadAccount() {
  const { data, error } = await supabase.rpc('get_my_account');
  if (error) throw error;
  account = data;
  authEvents.dispatchEvent(new Event('change'));
}

async function enterAccount(uid) {
  await useCloud(uid);
  await loadAccount();
}

export async function initAuth() {
  useGuest();
  if (!isCloudEnabled) return;
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && account) {
      account = null;
      useGuest();
      authEvents.dispatchEvent(new Event('change'));
    }
  });
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    try {
      await enterAccount(data.session.user.id);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }
}

export async function signUp(username, password) {
  const { data, error } = await supabase.auth.signUp({
    email: syntheticEmail(username),
    password,
    options: { data: { username } },
  });
  if (error) {
    if (error.code === 'user_already_exists' || /already registered/i.test(error.message)) {
      throw new Error('Este nome de usuário já existe.');
    }
    throw error;
  }
  if (!data.session) throw new Error('Cadastro sem sessão: desative "Confirm email" no Supabase.');
  await enterAccount(data.user.id);
  await offerMigration();
}

export async function signIn(username, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: syntheticEmail(username), password });
  if (error) {
    if (error.code === 'invalid_credentials' || /invalid login/i.test(error.message)) {
      throw new Error('Usuário ou senha incorretos.');
    }
    throw error;
  }
  await enterAccount(data.user.id);
  await offerMigration();
}

export async function signOut() {
  await flushWrites();
  await supabase.auth.signOut();
  account = null;
  useGuest();
  authEvents.dispatchEvent(new Event('change'));
}

async function offerMigration() {
  const count = guestVoteCount();
  if (!count) return;
  const answer = await choose('Votos de visitante', `Este navegador tem ${count} voto(s) de visitante. Levar para a sua conta?`, [
    { label: 'Levar, manter os da conta em conflitos', value: 'keep', primary: true },
    { label: 'Levar e sobrescrever a conta', value: 'overwrite' },
    { label: 'Agora não', value: 'no' },
  ]);
  if (answer !== 'keep' && answer !== 'overwrite') return;
  const { error } = await supabase.rpc('migrate_guest_votes', {
    p_votes: guestVotesPayload(), p_overwrite: answer === 'overwrite',
  });
  if (error) {
    toast(`Votos mantidos neste navegador. ${errorText(error)}`, 'error');
    return;
  }
  clearGuestState();
  await enterAccount(account.id);
  toast('Votos transferidos para a sua conta.');
}

export function openAuthDialog(initial = 'login') {
  if (!isCloudEnabled) {
    toast('Contas ainda não configuradas: preencha js/config.js.', 'error');
    return Promise.resolve();
  }
  return openDialog((close) => {
    let tab = initial;
    const root = h('div', { class: 'stack auth' });
    const render = () => {
      const isSignup = tab === 'signup';
      const user = h('input', { id: 'auth-user', autocomplete: 'username', maxlength: 20, required: true });
      const pass = h('input', {
        id: 'auth-pass', type: 'password', minlength: 8, required: true,
        autocomplete: isSignup ? 'new-password' : 'current-password',
      });
      const confirm = isSignup ? h('input', { id: 'auth-confirm', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }) : null;
      const error = h('p', { class: 'form-error', role: 'alert' });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, isSignup ? 'Criar conta' : 'Entrar');
      const toggle = h('button', {
        type: 'button', class: 'btn',
        onClick: (e) => {
          const show = pass.type === 'password';
          pass.type = show ? 'text' : 'password';
          if (confirm) confirm.type = pass.type;
          e.currentTarget.textContent = show ? 'Ocultar senha' : 'Exibir senha';
        },
      }, 'Exibir senha');

      const onSubmit = async (e) => {
        e.preventDefault();
        error.textContent = '';
        const name = user.value.trim();
        const problem = usernameError(name)
          ?? (pass.value.length < 8 ? 'A senha precisa de ao menos 8 caracteres.' : null)
          ?? (isSignup && pass.value !== confirm.value ? 'As senhas não coincidem.' : null);
        if (problem) {
          error.textContent = problem;
          return;
        }
        submit.disabled = true;
        try {
          close('ok');
          await (isSignup ? signUp(name, pass.value) : signIn(name, pass.value));
          toast(`Olá, ${getAccount().username}!`);
        } catch (err) {
          toast(err.message?.startsWith('Erro') ? err.message : (err.message ?? errorText(err)), 'error');
          openAuthDialog(tab);
        }
      };

      root.replaceChildren(
        h('div', { class: 'tabs' },
          h('button', { type: 'button', class: `tab ${!isSignup ? 'is-on' : ''}`, onClick: () => { tab = 'login'; render(); } }, 'Entrar'),
          h('button', { type: 'button', class: `tab ${isSignup ? 'is-on' : ''}`, onClick: () => { tab = 'signup'; render(); } }, 'Criar conta')),
        h('form', { class: 'stack', onSubmit, novalidate: true },
          h('label', { for: 'auth-user' }, 'Usuário'), user,
          h('label', { for: 'auth-pass' }, 'Senha'), pass,
          confirm && h('label', { for: 'auth-confirm' }, 'Confirmar senha'), confirm,
          toggle,
          isSignup && h('p', { class: 'warn' }, 'Não existe recuperação de senha. Guarde-a bem!'),
          error,
          h('div', { class: 'row' }, submit,
            h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'Cancelar'))),
      );
    };
    render();
    return root;
  });
}
