# Pokémon Panela

Plataforma estática de avaliação de Pokémon e formas, com ranking global, ranking entre amigos e perfis públicos. Roda no GitHub Pages com Supabase como backend.

Sem configurar o Supabase, o site já funciona em modo visitante.

## Configuração do Supabase

1. Crie um projeto no [Supabase](https://supabase.com).
2. Em **Authentication > Sign In / Providers > Email**, desative **Confirm email**. Sem isso o cadastro por usuário não entra na conta.
3. No **SQL Editor**, execute `sql/schema_and_rls.sql` e depois `sql/catalog_seed.sql`.
4. Em **Project Settings > API**, copie a URL e a chave **anon** para `js/config.js`. Nunca use a `service_role`.
5. Crie uma conta pelo site e, no SQL Editor, torne-a administradora:

```sql
insert into public.user_roles (user_id, role)
select id, 'admin' from public.profiles where username_normalized = 'SEU_USUARIO_EM_MINUSCULAS';
```

Faça isso só no SQL Editor: o nome do administrador não deve ir para o repositório.

## Publicação no GitHub Pages

Envie o repositório para o GitHub e, em **Settings > Pages**, publique a raiz da branch principal. Em **Authentication > URL Configuration** do Supabase, informe a URL do site.

## Teste local

```
npx serve .
```

## Atualizar o catálogo

```
npm run build:catalog
```

Regrava `data/catalog.min.json` e `sql/catalog_seed.sql`; rode o seed de novo no Supabase. Formas descartadas ficam em `data/catalog-excluded.txt`. Para incluir uma forma especial, adicione-a ao mapa `SPECIAL` em `scripts/build-catalog.js`.

## Regras ajustáveis

Ficam na tabela `public.app_settings`:

| Coluna | Padrão | Função |
| --- | --- | --- |
| `min_qualified_votes` | 20 | Votos para a conta contar no ranking global |
| `bayes_weight` | 25 | Peso do prior bayesiano |
| `bayes_prior` | 3.0 | Média a priori; o recálculo admin a atualiza |
| `max_votes_per_minute` | 120 | Limite de votos por minuto |
| `max_votes_per_hour` | 2400 | Limite de votos por hora |

Depois de mudar `min_qualified_votes` ou `bayes_weight`, rode o recálculo no painel admin.

## Aviso

Projeto de fã, sem fins lucrativos e sem vínculo com Nintendo, Game Freak ou The Pokémon Company. Dados e sprites vêm da [PokéAPI](https://pokeapi.co).
