import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = new URL('../build/client-package/', import.meta.url);
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const source = {
  upstream: 'https://github.com/night-slayer18/leetcode-cli',
  upstreamRevision: '282096f5c3952ae0e94a704adac344ec73c7732b',
  fork: 'https://github.com/MaybeLL/leetcode-cli',
  forkRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
};
const pkg = {
  name: '@maybell/leetcode-client',
  version: '3.5.2-pi.2',
  type: 'module',
  description: 'Library-only LeetCode client for Pi; derived from night-slayer18/leetcode-cli',
  main: './client.js',
  types: './client.d.ts',
  exports: { '.': { types: './client.d.ts', import: './client.js' } },
  files: ['client.js', 'client.d.ts', 'LICENSE', 'README.md', 'SOURCE.json'],
  license: 'Apache-2.0',
  repository: { type: 'git', url: 'https://github.com/MaybeLL/leetcode-cli.git' },
  engines: { node: '>=22.19.0' },
  dependencies: Object.fromEntries(
    ['got', 'zod'].map((name) => [name, lock.packages[`node_modules/${name}`].version])
  ),
};
await writeFile(new URL('package.json', directory), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(new URL('SOURCE.json', directory), JSON.stringify(source, null, 2) + '\n');
await copyFile(new URL('../LICENSE', import.meta.url), new URL('LICENSE', directory));
await copyFile(new URL('../docs/sdk.md', import.meta.url), new URL('README.md', directory));
