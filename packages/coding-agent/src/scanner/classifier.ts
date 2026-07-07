// @jawere/coding-agent — File classifier for the codebase scanner

export function classifyFile(filename: string, dir: string): string {
  const name = filename.toLowerCase();

  if (name.includes('.test.') || name.includes('.spec.')) return 'test';
  if (name.endsWith('.d.ts')) return 'types';
  if (dir.includes('/convex/')) return 'backend';
  if (dir.includes('/src/')) {
    if (name.includes('config') || name.includes('env')) return 'config';
    if (name.includes('test') || name.includes('spec')) return 'test';
    if (name.includes('prompt')) return 'prompt';
    if (name.includes('tool')) return 'core';
    if (name.includes('agent')) return 'core';
    if (name.includes('index')) return 'core';
    if (name.includes('crypto') || name.includes('encrypt')) return 'security';
    return 'core';
  }
  if (dir.includes('/scripts/') || dir.includes('/bin/')) {
    if (name.includes('build')) return 'build';
    return 'entry';
  }
  if (name === 'package.json') return 'config';
  if (name === 'tsconfig.json') return 'config';
  if (name.endsWith('.json')) return 'config';
  if (name.endsWith('.md')) return 'docs';
  if (name.includes('readme')) return 'docs';
  if (name.includes('.gitignore')) return 'config';
  if (name.includes('docker')) return 'container';
  if (name.includes('.env')) return 'secret';
  if (dir.includes('/.github/')) return 'ci';

  return 'other';
}
