#!/usr/bin/env node
/**
 * Gera data/catalog.min.json e sql/catalog_seed.sql a partir da PokéAPI v2.
 * Uso: node scripts/build-catalog.js
 *
 * As respostas ficam em cache em .cache/pokeapi (fora do git), conforme a
 * política de uso justo da PokéAPI. Apague a pasta para forçar atualização.
 * Formas descartadas são listadas em data/catalog-excluded.txt para revisão.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://pokeapi.co/api/v2';
const CACHE = join(ROOT, '.cache', 'pokeapi');
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
const MAX_DEX = 1025;
const CONCURRENCY = 12;

const PARADOX = new Set([
  984, 985, 986, 987, 988, 989, 990, 991, 992, 993, 994, 995,
  1005, 1006, 1007, 1008, 1009, 1010, 1020, 1021, 1022, 1023,
]);

/** Formas especiais relevantes (nome PokéAPI → rótulo exibido). */
const SPECIAL = {
  'deoxys-attack': 'Ataque', 'deoxys-defense': 'Defesa', 'deoxys-speed': 'Velocidade',
  'rotom-heat': 'Calor', 'rotom-wash': 'Lavagem', 'rotom-frost': 'Gelo', 'rotom-fan': 'Ventilador', 'rotom-mow': 'Corte',
  'giratina-origin': 'Origem', 'shaymin-sky': 'Céu', 'darmanitan-zen': 'Zen',
  'tornadus-therian': 'Therian', 'thundurus-therian': 'Therian', 'landorus-therian': 'Therian', 'enamorus-therian': 'Therian',
  'kyurem-black': 'Preto', 'kyurem-white': 'Branco', 'keldeo-resolute': 'Resoluto', 'meloetta-pirouette': 'Pirueta',
  'greninja-ash': 'Ash', 'aegislash-blade': 'Lâmina', 'zygarde-10': '10%', 'zygarde-complete': 'Completo',
  'hoopa-unbound': 'Liberto', 'oricorio-pom-pom': 'Pom-Pom', 'oricorio-pau': "Pa'u", 'oricorio-sensu': 'Sensu',
  'lycanroc-midnight': 'Meia-Noite', 'lycanroc-dusk': 'Crepúsculo', 'wishiwashi-school': 'Cardume',
  'necrozma-dusk': 'Juba Crepuscular', 'necrozma-dawn': 'Asas do Amanhecer', 'necrozma-ultra': 'Ultra',
  'toxtricity-low-key': 'Grave', 'eiscue-noice': 'Sem Gelo', 'morpeko-hangry': 'Faminto',
  'zacian-crowned': 'Coroado', 'zamazenta-crowned': 'Coroado', 'urshifu-rapid-strike': 'Golpe Fluido',
  'calyrex-ice': 'Cavaleiro Glacial', 'calyrex-shadow': 'Cavaleiro Espectral', 'ursaluna-bloodmoon': 'Lua de Sangue',
  'maushold-family-of-three': 'Família de Três', 'palafin-hero': 'Herói',
  'tatsugiri-droopy': 'Caído', 'tatsugiri-stretchy': 'Esticado', 'dudunsparce-three-segment': 'Três Segmentos',
  'gimmighoul-roaming': 'Andarilho', 'ogerpon-wellspring-mask': 'Máscara Nascente',
  'ogerpon-hearthflame-mask': 'Máscara Fornalha', 'ogerpon-cornerstone-mask': 'Máscara Fundamento',
  'terapagos-terastal': 'Terastal', 'terapagos-stellar': 'Estelar',
  'dialga-origin': 'Origem', 'palkia-origin': 'Origem',
  'castform-sunny': 'Sol', 'castform-rainy': 'Chuva', 'castform-snowy': 'Neve',
  'wormadam-sandy': 'Areia', 'wormadam-trash': 'Lixo',
  'basculin-blue-striped': 'Listras Azuis', 'basculin-white-striped': 'Listras Brancas',
  'basculegion-female': 'Fêmea', 'indeedee-female': 'Fêmea', 'meowstic-female': 'Fêmea', 'oinkologne-female': 'Fêmea',
  'eternatus-eternamax': 'Eternamax', 'floette-eternal': 'Flor Eterna', 'magearna-original': 'Cor Original',
  'zarude-dada': 'Papai', 'mimikyu-busted': 'Desmascarado',
  'cramorant-gulping': 'Engolindo', 'cramorant-gorging': 'Engasgando',
  'squawkabilly-blue-plumage': 'Plumagem Azul', 'squawkabilly-yellow-plumage': 'Plumagem Amarela',
  'squawkabilly-white-plumage': 'Plumagem Branca',
};

const SPECIAL_ORIGIN = {
  'greninja-ash': 7, 'zygarde-10': 7, 'zygarde-complete': 7, 'ursaluna-bloodmoon': 9,
};

/** Gigantamax com o mesmo design de outra entrada do catálogo. */
const GMAX_DUPLICATES = new Set(['toxtricity-low-key-gmax']);

const REGION = {
  alola: ['Alola', 7], galar: ['Galar', 8], hisui: ['Hisui', 8], paldea: ['Paldea', 9],
};

const PALDEA_TAUROS = {
  'tauros-paldea-combat-breed': 'Paldea, Combate',
  'tauros-paldea-blaze-breed': 'Paldea, Fogo',
  'tauros-paldea-aqua-breed': 'Paldea, Água',
};

const titleCase = (s) => s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');

/** Devolve {category, label, origin} ou null quando a variedade não é elegível. */
function classify(name, speciesSlug, speciesGen) {
  if (/-totem/.test(name)) return null;
  if (SPECIAL[name]) {
    return { category: 'special', label: SPECIAL[name], origin: SPECIAL_ORIGIN[name] ?? speciesGen };
  }
  if (/-gmax$/.test(name)) {
    if (GMAX_DUPLICATES.has(name)) return null;
    const rest = name.slice(speciesSlug.length).replace(/^-/, '').replace(/-?gmax$/, '');
    const extra = rest && !/^(amped|single-strike)$/.test(rest) ? ` ${titleCase(rest)}` : '';
    return { category: 'gmax', label: `Gigantamax${extra}`, origin: 8 };
  }
  if (/-primal$/.test(name)) return { category: 'primal', label: 'Primal', origin: 6 };
  const mega = name.match(/-mega(?:-([a-z]+))?$/);
  if (mega) {
    return { category: 'mega', label: mega[1] ? `Mega ${mega[1].toUpperCase()}` : 'Mega', origin: 6 };
  }
  if (PALDEA_TAUROS[name]) return { category: 'regional', label: PALDEA_TAUROS[name], origin: 9 };
  if (name === 'darmanitan-galar-standard') return { category: 'regional', label: 'Galar', origin: 8 };
  if (name === 'darmanitan-galar-zen') return { category: 'regional', label: 'Galar, Zen', origin: 8 };
  const region = name.match(/-(alola|galar|hisui|paldea)$/);
  if (region && !/^pikachu-/.test(name)) {
    const [label, origin] = REGION[region[1]];
    return { category: 'regional', label, origin };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const file = join(CACHE, `${createHash('sha1').update(url).digest('hex')}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* sem cache */ }
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'pokemon-panela-catalog-builder' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await writeFile(file, text);
      return JSON.parse(text);
    } catch (err) {
      if (attempt >= 5) throw new Error(`${url}: ${err.message}`);
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
      done += 1;
      if (done % 200 === 0) console.log(`  ${done}/${items.length}`);
    }
  }));
  return out;
}

const idFromUrl = (url) => Number(url.match(/\/(\d+)\/?$/)[1]);
const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

function spritePath(pokemon) {
  const url = pokemon.sprites.front_default
    ?? pokemon.sprites.other?.['official-artwork']?.front_default
    ?? pokemon.sprites.other?.home?.front_default;
  if (!url || !url.startsWith(SPRITE_BASE)) return null;
  return url.slice(SPRITE_BASE.length);
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(ROOT, 'data'), { recursive: true });

  console.log('Espécies...');
  const dexNumbers = Array.from({ length: MAX_DEX }, (_, i) => i + 1);
  const speciesList = await pool(dexNumbers, (id) => fetchJson(`${API}/pokemon-species/${id}`));

  const jobs = [];
  for (const species of speciesList) {
    for (const v of species.varieties) jobs.push({ species, isDefault: v.is_default, url: v.pokemon.url, name: v.pokemon.name });
  }

  const excluded = [];
  const selected = [];
  for (const job of jobs) {
    const sg = idFromUrl(job.species.generation.url);
    const form = job.isDefault ? { category: 'base', label: null, origin: sg } : classify(job.name, job.species.name, sg);
    if (form) selected.push({ ...job, form, sg });
    else excluded.push(job.name);
  }

  console.log(`Variedades selecionadas: ${selected.length}`);
  const entries = await pool(selected, async ({ species, url, form, sg }) => {
    const p = await fetchJson(url);
    let origin = form.origin;
    if (form.category === 'mega' && p.forms[0]) {
      const f = await fetchJson(p.forms[0].url);
      if (/legends-za|mega-dimension/.test(f.version_group?.name ?? '')) origin = 9;
    }
    const en = species.names.find((n) => n.language.name === 'en')?.name ?? titleCase(species.name);
    const klass = species.is_mythical ? 'mythical'
      : species.is_legendary ? 'legendary'
        : PARADOX.has(species.id) ? 'paradox' : null;
    const sprite = spritePath(p);
    if (!sprite) console.warn(`  sem sprite: ${p.name}`);
    return {
      id: p.id,
      dex: species.id,
      name: form.label ? `${en} (${form.label})` : en,
      slug: p.name,
      sg,
      og: origin,
      cat: form.category,
      cls: klass,
      types: p.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
      sprite: sprite === `${p.id}.png` ? undefined : sprite ?? undefined,
    };
  });

  entries.sort((a, b) => a.dex - b.dex || (a.cat === 'base' ? -1 : b.cat === 'base' ? 1 : a.id - b.id));

  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw new Error('pokemon_id duplicado no catálogo');
  const bases = entries.filter((e) => e.cat === 'base');
  if (bases.length !== MAX_DEX) throw new Error(`esperadas ${MAX_DEX} formas base, obtidas ${bases.length}`);

  await writeFile(join(ROOT, 'data', 'catalog.min.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    spriteBase: SPRITE_BASE,
    entries,
  }));
  await writeFile(join(ROOT, 'data', 'catalog-excluded.txt'), `${excluded.sort().join('\n')}\n`);

  const rows = entries.map((e) => `(${[
    e.id, e.dex, sqlText(e.slug), sqlText(e.name), e.sg, e.og, sqlText(e.cat),
    e.cls ? sqlText(e.cls) : 'null', sqlText(e.types[0]), e.types[1] ? sqlText(e.types[1]) : 'null',
  ].join(',')})`);
  await writeFile(join(ROOT, 'sql', 'catalog_seed.sql'), `-- GERADO por scripts/build-catalog.js. Não edite à mão.
-- Execute depois de schema_and_rls.sql. Idempotente; preserva is_active.
insert into public.pokemon_catalog
  (pokemon_id, dex_number, slug, name, species_generation, origin_generation, form_category, species_class, type_1, type_2)
values
${rows.join(',\n')}
on conflict (pokemon_id) do update set
  dex_number = excluded.dex_number, slug = excluded.slug, name = excluded.name,
  species_generation = excluded.species_generation, origin_generation = excluded.origin_generation,
  form_category = excluded.form_category, species_class = excluded.species_class,
  type_1 = excluded.type_1, type_2 = excluded.type_2;
`);

  const counts = {};
  for (const e of entries) counts[e.cat] = (counts[e.cat] ?? 0) + 1;
  console.log('Total:', entries.length, counts, 'Excluídas:', excluded.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
