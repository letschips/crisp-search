// Run against an explicitly selected, running Obsidian vault after deploying this build.
// Does not write notes or change the real licence. Opens the search panel and updates its query.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [vault, output] = process.argv.slice(2);
if (!vault || !output) throw new Error('Usage: npm run test:host -- <vault-name> <evidence-directory>');
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const run = (...args) => execFileSync('obsidian', [`vault=${vault}`, ...args], { encoding: 'utf8', timeout: 30_000 });
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const state = JSON.parse(run('eval', 'code=JSON.stringify((()=>{const p=app.plugins.plugins["crisp-search"];return {version:p?.manifest.version,ready:p?.ready,licensed:p?.licensed}})())').replace(/^=>\s*/, '').trim());
if (state.version !== manifest.version || !state.ready || !state.licensed) throw new Error(`Deploy and wait for indexing first: ${JSON.stringify(state)}`);
if (run('eval', 'code=!!document.querySelector(".crisp-search-panel")').includes('false')) run('command', 'id=crisp-search:open');
const source = readFileSync(fileURLToPath(new URL('./host-probe.js', import.meta.url)), 'utf8');
const result = JSON.parse(run('eval', `code=${source}`).replace(/^=>\s*/, '').trim());
writeFileSync(resolve(directory, 'host-regression.json'), JSON.stringify(result, null, 2) + '\n');
run('dev:screenshot', `path=${resolve(directory, 'host-regression.png')}`);
console.log(JSON.stringify(result, null, 2));
if (result.checks.some(check => !check.pass)) process.exitCode = 1;
