/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MediaJobStore, pruneJobs } from '@process/services/mediaJob/store';
import type { MediaJobRecord } from '@process/services/mediaJob/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function job(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    kind: 'image',
    status: 'done',
    prompt: 'a cat',
    params: {},
    inputUris: [],
    providerId: 'provider-1',
    model: 'dall-e-3',
    workspaceDir: '/ws',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

let cleanupDirs: string[] = [];

function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aionui-media-job-store-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  cleanupDirs = [];
});

describe('pruneJobs', () => {
  it('drops terminal jobs older than the retention window but keeps recent ones', () => {
    const stale = job({ id: 'stale', status: 'done', updatedAt: NOW - 8 * DAY_MS });
    const fresh = job({ id: 'fresh', status: 'done', updatedAt: NOW - 1 * DAY_MS });

    const kept = pruneJobs([stale, fresh], NOW);

    expect(kept.map((j) => j.id)).toEqual(['fresh']);
  });

  it('never drops a non-terminal job, no matter how old', () => {
    const oldButRunning = job({ id: 'still-running', status: 'polling', updatedAt: NOW - 30 * DAY_MS });

    expect(pruneJobs([oldButRunning], NOW).map((j) => j.id)).toEqual(['still-running']);
  });

  it('caps at 500 records, keeping unfinished work first, then most recently touched', () => {
    const running = job({ id: 'running', status: 'polling', updatedAt: NOW });
    const many = Array.from({ length: 500 }, (_, i) =>
      job({ id: `terminal-${i}`, status: 'done', updatedAt: NOW - i * 1000 })
    );

    const kept = pruneJobs([...many, running], NOW);

    expect(kept).toHaveLength(500);
    expect(kept[0].id).toBe('running'); // unfinished work sorts first
    expect(kept.map((j) => j.id)).toContain('terminal-0'); // most recently touched terminal jobs win over older ones
    expect(kept.map((j) => j.id)).not.toContain('terminal-499'); // oldest terminal job is the one dropped
  });
});

describe('MediaJobStore.load', () => {
  it('returns an empty array when the file does not exist yet', async () => {
    const dir = createDir();
    const store = new MediaJobStore(join(dir, 'nonexistent', 'media-jobs.json'));

    await expect(store.load(NOW)).resolves.toEqual([]);
  });

  it('returns an empty array and does not throw on a corrupt file', async () => {
    const dir = createDir();
    const filePath = join(dir, 'media-jobs.json');
    writeFileSync(filePath, 'not valid json {{{');
    const store = new MediaJobStore(filePath);

    await expect(store.load(NOW)).resolves.toEqual([]);
  });

  it('returns an empty array when the persisted shape has no jobs array', async () => {
    const dir = createDir();
    const filePath = join(dir, 'media-jobs.json');
    writeFileSync(filePath, JSON.stringify({ version: 1 }));
    const store = new MediaJobStore(filePath);

    await expect(store.load(NOW)).resolves.toEqual([]);
  });

  it('loads and prunes persisted jobs', async () => {
    const dir = createDir();
    const filePath = join(dir, 'media-jobs.json');
    const stale = job({ id: 'stale', status: 'done', updatedAt: NOW - 30 * DAY_MS });
    const fresh = job({ id: 'fresh', status: 'done', updatedAt: NOW });
    writeFileSync(filePath, JSON.stringify({ version: 1, jobs: [stale, fresh] }));
    const store = new MediaJobStore(filePath);

    const loaded = await store.load(NOW);

    expect(loaded.map((j) => j.id)).toEqual(['fresh']);
  });
});

describe('MediaJobStore.save', () => {
  it('writes the file atomically, leaving no .tmp file behind', async () => {
    const dir = createDir();
    const filePath = join(dir, 'media-jobs.json');
    const store = new MediaJobStore(filePath);

    await store.save([job({ id: 'a' })], NOW);

    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted).toMatchObject({ version: 1, jobs: [expect.objectContaining({ id: 'a' })] });
    expect(() => readFileSync(`${filePath}.tmp`)).toThrow();
  });

  it('creates the parent directory if it does not exist yet', async () => {
    const dir = createDir();
    const filePath = join(dir, 'nested', 'deeper', 'media-jobs.json');
    const store = new MediaJobStore(filePath);

    await store.save([job({ id: 'a' })], NOW);

    expect(JSON.parse(readFileSync(filePath, 'utf-8')).jobs).toHaveLength(1);
  });

  it('serializes concurrent saves so the file always reflects a complete write', async () => {
    const dir = createDir();
    const filePath = join(dir, 'media-jobs.json');
    const store = new MediaJobStore(filePath);

    await Promise.all([
      store.save([job({ id: 'first' })], NOW),
      store.save([job({ id: 'second' })], NOW),
      store.save([job({ id: 'third' })], NOW),
    ]);

    // Whichever write landed last, the file is always fully-formed JSON for
    // exactly one of the calls — never a torn write from two overlapping ones.
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted.jobs).toHaveLength(1);
    expect(['first', 'second', 'third']).toContain(persisted.jobs[0].id);
  });

  it('reports the failure to the caller but keeps the write chain usable for the next save', async () => {
    const dir = createDir();
    // A path whose "directory" segment is actually a plain file: mkdir(dir,
    // {recursive:true}) fails with ENOTDIR, a reliable cross-platform way to
    // make the write itself fail without mocking fs.
    const blockerFile = join(dir, 'not-a-directory');
    writeFileSync(blockerFile, 'x');
    const badStore = new MediaJobStore(join(blockerFile, 'media-jobs.json'));

    await expect(badStore.save([job({ id: 'a' })], NOW)).rejects.toThrow();
    // A failed save must not wedge that store's write chain: a second save on
    // the SAME instance, once the path is fixed, still has to resolve.
    const filePath = join(dir, 'media-jobs.json');
    (badStore as unknown as { filePath: string }).filePath = filePath;
    await expect(badStore.save([job({ id: 'b' })], NOW)).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).jobs).toHaveLength(1);
  });
});
