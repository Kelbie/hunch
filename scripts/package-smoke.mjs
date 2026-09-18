import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
  if (!run(process.execPath, [bin, '--version']).includes('0.1.0')) throw new Error('Version command failed');
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  writeFileSync(join(temp, 'consumer.ts'), 'import {defineConfig,noul} from "@kelbie/hunch"; export default defineConfig({rules:{r:["warn",noul({instructions:"Does `hunk` hide a failure?",when:/catch/})]}});');
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2024', 'consumer.ts']);
  const rust = join(temp, 'rust'); mkdirSync(rust); writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"');
  writeFileSync(join(rust, 'package.json'), '{"devDependencies":{"@kelbie/hunch":"0.1.0"}}');
  run('git', ['init', '--quiet'], rust);
  run(process.execPath, [bin, 'init', '--cwd', rust]);
  if (!existsSync(join(rust, 'hunch.toml'))) throw new Error('Cargo project did not receive TOML config');
  const ts = join(temp, 'typescript'); mkdirSync(ts); run('git', ['init', '--quiet'], ts);
  run(process.execPath, [bin, 'init', '--ts', '--cwd', ts]);
  // A synthetic direct key is used with an empty diff; this executes no model requests.
  writeFileSync(join(ts, 'hunch.config.ts'), 'export default {provider:"typesafe",agentsMd:false,rules:{r:["warn","Preserve failure"]}};');
  writeFileSync(join(ts, 'empty.diff'), '');
  const report = execFileSync(process.execPath, [bin, 'check', '--diff', join(ts, 'empty.diff'), '--reporter', 'json', '--cwd', ts], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: 'synthetic-no-network' } });
  const parsed = JSON.parse(report);
  if (!parsed.complete || parsed.stats.requests !== 0) throw new Error('Packed review failed');
  console.log('Packed npm artifact: Node CLI, standalone dependencies, TypeScript declarations, Rust/TS init, and offline report passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
