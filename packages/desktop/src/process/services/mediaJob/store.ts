/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Job persistence. A flat JSON file is enough at this scale (single desktop
 * user, a handful of concurrent generations) and avoids adding a second SQLite
 * database — this app has a history of WAL corruption, so new stores are not
 * introduced without a reason.
 *
 * Writes are atomic (temp file + rename) and serialized through a promise
 * chain, so a crash mid-write cannot leave a truncated file that would lose
 * every in-flight job.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isTerminal, type MediaJobRecord } from './types';

/** Terminal jobs older than this are dropped on load — the assets stay on disk. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap so a runaway session cannot grow the file without bound. */
const MAX_RECORDS = 500;

type PersistedShape = {
  version: 1;
  jobs: MediaJobRecord[];
};

/**
 * Drop stale terminal jobs and cap the total. Pure — the caller supplies `now`
 * so this is deterministic under test.
 */
export function pruneJobs(jobs: MediaJobRecord[], now: number): MediaJobRecord[] {
  const kept = jobs.filter((job) => !isTerminal(job.status) || now - job.updatedAt <= TERMINAL_RETENTION_MS);
  if (kept.length <= MAX_RECORDS) return kept;
  // Keep unfinished work first, then the most recently touched.
  return kept
    .toSorted((a, b) => {
      const aTerminal = isTerminal(a.status) ? 1 : 0;
      const bTerminal = isTerminal(b.status) ? 1 : 0;
      if (aTerminal !== bTerminal) return aTerminal - bTerminal;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_RECORDS);
}

export class MediaJobStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(now = Date.now()): Promise<MediaJobRecord[]> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShape;
      if (!parsed || !Array.isArray(parsed.jobs)) return [];
      return pruneJobs(parsed.jobs, now);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // A corrupt file must not block startup: media jobs are not critical
        // state, and refusing to boot over them would be a worse failure.
        console.warn('[mediaJobStore] failed to read job file, starting empty:', error);
      }
      return [];
    }
  }

  /** Queue an atomic full-file write. Resolves once this write lands. */
  save(jobs: MediaJobRecord[], now = Date.now()): Promise<void> {
    const payload: PersistedShape = { version: 1, jobs: pruneJobs(jobs, now) };
    const next = this.writeChain.then(() => this.writeAtomic(payload));
    // Keep the chain alive even if one write fails.
    this.writeChain = next.catch(() => {
      // Swallowed here only to keep the chain usable; the caller still sees it.
    });
    return next;
  }

  private async writeAtomic(payload: PersistedShape): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.promises.rename(tempPath, this.filePath);
  }
}
