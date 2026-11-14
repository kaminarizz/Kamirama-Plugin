// Node.js 20+ — checks only what the distribution repo publishes.
// The source tree stays private, so CI cannot rebuild; it verifies that every
// manifest entry still resolves to a loadable bundle.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const forbidden = [
  /\b(?:require|process|Buffer|__dirname|__filename)\b/,
  /\bnode:/,
  /\b(?:fs|path|crypto)\.(?:readFile|writeFile|createHash|randomBytes|join|resolve)\b/,
];
// Public TMDB fallback key plus AniStream's public session fields.
const allowedHex = new Set([
  '6e2d6390c077578d7dc25ba6312f72f1',
  '00cf8bc56d484f61a93d5f9368d1c114',
  'c3d63d63e2444c13a9b9e1b7d0929103',
]);

const errors = [];
const fail = (message) => errors.push(message);

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  for (const field of ['name', 'version', 'description', 'author']) {
    if (!String(manifest?.[field] || '').trim()) fail(`Campo obrigatório ausente: ${field}.`);
  }
  if (!Array.isArray(manifest?.scrapers) || !manifest.scrapers.length) {
    fail('manifest.scrapers deve ter pelo menos um provider.');
  }

  const ids = new Set();
  const files = new Set();
  for (const scraper of manifest?.scrapers || []) {
    const label = scraper?.id || '<sem id>';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(scraper?.id || ''))) fail(`${label}: id inválido.`);
    if (ids.has(scraper?.id)) fail(`${label}: id duplicado.`);
    ids.add(scraper?.id);
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(scraper?.version || ''))) fail(`${label}: version deve ser semver.`);
    if (!String(scraper?.name || '').trim()) fail(`${label}: name é obrigatório.`);
    if (!Array.isArray(scraper?.supportedTypes) || !scraper.supportedTypes.length) fail(`${label}: supportedTypes é obrigatório.`);

    const filename = String(scraper?.filename || '');
    if (!/^providers\/[a-z0-9][a-z0-9-]*\.js$/.test(filename)) fail(`${label}: filename inválido.`);
    if (files.has(filename)) fail(`${label}: filename duplicado.`);
    files.add(filename);

    const location = path.join(root, filename);
    try {
      await stat(location);
    } catch {
      fail(`${label}: bundle ausente (${filename}).`);
      continue;
    }
    const bundle = await readFile(location, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(bundle)) fail(`${label}: referência incompatível com o QuickJS (${pattern}).`);
    }
    const hex = bundle.match(/\b[a-f0-9]{32}\b/gi) || [];
    if (hex.some((value) => !allowedHex.has(value.toLowerCase()))) fail(`${label}: chave TMDB não autorizada.`);

    const module = { exports: {} };
    const sandbox = {
      module,
      exports: module.exports,
      console: { log() {}, warn() {}, error() {} },
      URL,
      URLSearchParams,
      TextEncoder,
      atob,
      btoa,
      crypto: globalThis.crypto,
    };
    try {
      vm.runInNewContext(bundle, sandbox, { timeout: 1000, filename });
    } catch (error) {
      fail(`${label}: o bundle não inicializa (${error.message}).`);
      continue;
    }
    if (typeof module.exports?.getStreams !== 'function') fail(`${label}: o bundle não exporta getStreams.`);
    if (scraper.hasSettings === true && typeof module.exports?.onSettings !== 'function') {
      fail(`${label}: manifest declara hasSettings, mas o bundle não exporta onSettings.`);
    }
  }

  if (errors.length) {
    console.error(`Validação falhou (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ publicado: manifest válido (${manifest.scrapers.length} providers; bundles carregáveis)`);
}

main().catch((error) => {
  console.error(`Validação falhou: ${error.message}`);
  process.exitCode = 1;
});
