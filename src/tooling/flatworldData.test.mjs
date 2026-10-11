import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFlatworldFile } from '../../server/providers/flatworldData.js';

const base = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'fwdata-'));
const dir = path.join(base, 'tiles');
mkdirSync(path.join(dir, 'etopo', '0', '0'), { recursive: true });
writeFileSync(path.join(dir, 'etopo', '0', '0', '0.png'), 'png');
writeFileSync(path.join(dir, '.env'), 'SECRET=1');
writeFileSync(path.join(base, 'outside.png'), 'nope');
symlinkSync(path.join(base, 'outside.png'), path.join(dir, 'link.png'));

test('serves a tile inside the data directory', () => {
  const r = resolveFlatworldFile(dir, '/etopo/0/0/0.png');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/png');
});

test('refuses traversal, dotfiles, malformed encoding and unknown types', () => {
  for (const url of [
    '/../outside.png',
    '/%2e%2e/outside.png',
    '/.env',
    '/etopo/%E0%A4%A',
    '/etopo/0/0/0.txt',
    '/etopo\\0.png',
  ]) {
    assert.notEqual(resolveFlatworldFile(dir, url).status, 200, url);
  }
});

test('does not follow symlinks out of the data directory', () => {
  assert.equal(resolveFlatworldFile(dir, '/link.png').status, 404);
});
