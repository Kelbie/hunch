import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'hunch-package-'));
const run = (bin, args, cwd = temp) => execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], join(root, 'packages/cli')));
  run('npm', ['init', '-y']);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed[0].filename)]);
  const bin = join(temp, 'node_modules/@kelbie/hunch/dist/bin.js');
  if (!run(process.execPath, [bin, '--version']).includes('0.11.0')) throw new Error('Version command failed');
  const appHelp = run(process.execPath, [bin, 'app', '--help']);
  if (!appHelp.includes('register') || !appHelp.includes('connect')) throw new Error('App setup subcommands missing');
  // A flag the command does not take must be refused, not silently ignored.
  let rejected = '';
  try { run(process.execPath, [bin, 'init', '--facet', 'edit']); }
  catch (e) { rejected = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  if (!rejected.includes("unknown option '--facet'")) throw new Error('Per-command options are not enforced');
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  writeFileSync(join(temp, 'consumer.ts'), 'import {defineConfig,noul} from "@kelbie/hunch"; export default defineConfig({rules:{r:["warn",noul({instructions:"Does `hunk` hide a failure?",when:/catch/})]}});');
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2024', 'consumer.ts']);
  const rust = join(temp, 'rust'); mkdirSync(rust); writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"');
  writeFileSync(join(rust, 'package.json'), '{"devDependencies":{"@kelbie/hunch":"0.11.0"}}');
  run('git', ['init', '--quiet'], rust);
  run(process.execPath, [bin, 'init', '--cwd', rust]);
  if (!existsSync(join(rust, 'hunch.toml'))) throw new Error('Cargo project did not receive TOML config');
  const originalRustConfig = readFileSync(join(rust, 'hunch.toml'), 'utf8');
  run(process.execPath, [bin, 'init', '--github', '--cwd', rust]);
  if (readFileSync(join(rust, 'hunch.toml'), 'utf8') !== originalRustConfig) throw new Error('Workflow setup changed existing policy');
  let refused = false;
  try { run(process.execPath, [bin, 'init', '--github', '--cwd', rust]); } catch (error) { refused = error.status === 2; }
  if (!refused || readFileSync(join(rust, 'hunch.toml'), 'utf8') !== originalRustConfig) throw new Error('Repeated setup did not preserve files');
  const general = join(temp, 'python'); mkdirSync(general); run('git', ['init', '--quiet'], general);
  writeFileSync(join(general, 'pyproject.toml'), '[project]\nname="fixture"');
  run(process.execPath, [bin, 'init', '--github', '--cwd', general]);
  if (!existsSync(join(general, 'hunch.toml'))) throw new Error('General project did not receive TOML config');
  if (/include\s*=/.test(readFileSync(join(general, 'hunch.toml'), 'utf8'))) throw new Error('General project received a language filter');
  const generalNpm = join(temp, 'general-npm'); mkdirSync(generalNpm); run('git', ['init', '--quiet'], generalNpm);
  writeFileSync(join(generalNpm, 'package.json'), '{}');
  run(process.execPath, [bin, 'init', '--preset', 'general', '--github', '--cwd', generalNpm]);
  if (!existsSync(join(generalNpm, 'hunch.toml'))) throw new Error('--preset general ignored in npm consumer');
  const ts = join(temp, 'typescript'); mkdirSync(ts); run('git', ['init', '--quiet'], ts);
  run(process.execPath, [bin, 'init', '--preset', 'ts', '--github', '--cwd', ts]);
  if (!existsSync(join(ts, '.github/workflows/hunch.yml'))) throw new Error('GitHub workflow was not created');
  // A synthetic direct key is used with an empty diff; this executes no model requests.
  writeFileSync(join(ts, 'hunch.config.ts'), 'export default {provider:"typesafe",agentsMd:false,rules:{r:["warn","Preserve failure"]}};');
  writeFileSync(join(ts, 'empty.diff'), '');
  const report = execFileSync(process.execPath, [bin, 'check', '--diff', join(ts, 'empty.diff'), '--reporter', 'json', '--cwd', ts], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: 'synthetic-no-network' } });
  const parsed = JSON.parse(report);
  if (!parsed.complete || parsed.stats.requests !== 0) throw new Error('Packed review failed');
  console.log('Packed npm artifact: Node CLI, standalone dependencies, TypeScript declarations, Rust/TS init, and offline report passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
