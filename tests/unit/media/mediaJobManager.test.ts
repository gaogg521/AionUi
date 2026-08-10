/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaJobManager, type MediaJobExecutor } from '@process/services/mediaJob/jobManager';
import type { MediaJobRecord, MediaJobRequest } from '@process/services/mediaJob/types';
import type { TProviderWithModel } from '@/common/config/storage';

const provider: TProviderWithModel = {
  id: 'p1',
  platform: 'openai',
  name: 'OpenAI',
  base_url: 'https://api.openai.com/v1',
  api_key: 'sk-test',
  use_model: 'dall-e-3',
};

const request = (overrides: Partial<MediaJobRequest> = {}): MediaJobRequest => ({
  kind: 'image',
  prompt: 'a red square',
  params: {},
  inputUris: [],
  providerId: 'p1',
  model: 'dall-e-3',
  workspaceDir: '/tmp/ws',
  ...overrides,
});

/** A deferred promise so tests can hold a job in-flight deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildManager(options: {
  execute: MediaJobExecutor;
  stored?: MediaJobRecord[];
  resolveProvider?: (id: string, model: string) => Promise<TProviderWithModel | null>;
  maxConcurrentPerProvider?: number;
}) {
  const saved: MediaJobRecord[][] = [];
  let counter = 0;
  const manager = new MediaJobManager({
    resolveProvider: options.resolveProvider ?? (async () => provider),
    execute: options.execute,
    loadJobs: async () => options.stored ?? [],
    saveJobs: async (jobs) => {
      saved.push(jobs.map((job) => ({ ...job })));
    },
    newId: () => `job-${++counter}`,
    maxConcurrentPerProvider: options.maxConcurrentPerProvider,
  });
  return { manager, saved };
}

const okOutcome = { success: true, assets: [], text: 'done' };

describe('MediaJobManager', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs a job to completion and reports done', async () => {
    const { manager } = buildManager({ execute: async () => okOutcome });
    const job = manager.create(request());
    const finished = await manager.waitForCompletion(job.id);

    expect(finished.status).toBe('done');
    expect(manager.getJob(job.id)?.status).toBe('done');
  });

  it('marks the job failed when the provider is gone', async () => {
    const { manager } = buildManager({
      execute: async () => okOutcome,
      resolveProvider: async () => null,
    });
    const job = manager.create(request());
    const finished = await manager.waitForCompletion(job.id);

    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/no longer configured/i);
  });

  it('maps a timeout outcome to the timeout status, not a generic failure', async () => {
    const { manager } = buildManager({
      execute: async () => ({ success: false, assets: [], text: 'timed out', error: 'timeout' }),
    });
    const job = manager.create(request());
    expect((await manager.waitForCompletion(job.id)).status).toBe('timeout');
  });

  it('persists the remote task id as soon as it is issued', async () => {
    const gate = deferred<typeof okOutcome>();
    const { manager, saved } = buildManager({
      execute: async ({ onTaskSubmitted }) => {
        onTaskSubmitted('remote-task-1');
        return gate.promise;
      },
    });

    const job = manager.create(request());
    await vi.waitFor(() => expect(manager.getJob(job.id)?.remoteTaskId).toBe('remote-task-1'));
    // The id must already be on disk before the job finishes — that window is
    // exactly where a crash would orphan a paid-for task.
    expect(saved.at(-1)?.find((record) => record.id === job.id)?.remoteTaskId).toBe('remote-task-1');
    expect(manager.getJob(job.id)?.status).toBe('polling');

    gate.resolve(okOutcome);
    await manager.waitForCompletion(job.id);
  });

  it('honors the per-provider concurrency cap', async () => {
    const gates = [deferred<typeof okOutcome>(), deferred<typeof okOutcome>(), deferred<typeof okOutcome>()];
    let started = 0;
    const { manager } = buildManager({
      maxConcurrentPerProvider: 2,
      execute: async () => {
        const gate = gates[started];
        started++;
        return gate.promise;
      },
    });

    const jobs = [manager.create(request()), manager.create(request()), manager.create(request())];
    await vi.waitFor(() => expect(started).toBe(2));
    expect(started).toBe(2);

    gates[0].resolve(okOutcome);
    await manager.waitForCompletion(jobs[0].id);
    await vi.waitFor(() => expect(started).toBe(3));

    gates[1].resolve(okOutcome);
    gates[2].resolve(okOutcome);
    await Promise.all([manager.waitForCompletion(jobs[1].id), manager.waitForCompletion(jobs[2].id)]);
  });

  it('cancels a running job and aborts the in-flight request', async () => {
    let seenSignal: AbortSignal | undefined;
    const gate = deferred<typeof okOutcome>();
    const { manager } = buildManager({
      execute: async ({ signal }) => {
        seenSignal = signal;
        return gate.promise;
      },
    });

    const job = manager.create(request());
    await vi.waitFor(() => expect(seenSignal).toBeDefined());

    expect(manager.cancel(job.id)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect((await manager.waitForCompletion(job.id)).status).toBe('cancelled');
    gate.resolve(okOutcome);
  });

  it('drops a queued job on cancel without ever starting it', async () => {
    const gate = deferred<typeof okOutcome>();
    let started = 0;
    const { manager } = buildManager({
      maxConcurrentPerProvider: 1,
      execute: async () => {
        started++;
        return gate.promise;
      },
    });

    const running = manager.create(request());
    const queued = manager.create(request());
    await vi.waitFor(() => expect(started).toBe(1));

    expect(manager.cancel(queued.id)).toBe(true);
    expect(manager.getJob(queued.id)?.status).toBe('cancelled');

    gate.resolve(okOutcome);
    await manager.waitForCompletion(running.id);
    expect(started).toBe(1);
  });

  describe('restore', () => {
    const storedJob = (overrides: Partial<MediaJobRecord>): MediaJobRecord => ({
      id: 'old-1',
      kind: 'video',
      status: 'polling',
      prompt: 'a cat',
      params: {},
      inputUris: [],
      providerId: 'p1',
      model: 'seedance',
      workspaceDir: '/tmp/ws',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    });

    it('resumes a job that already has a remote task id', async () => {
      let resumedWith: string | undefined;
      const { manager } = buildManager({
        stored: [storedJob({ remoteTaskId: 'remote-9' })],
        execute: async ({ resumeTaskId }) => {
          resumedWith = resumeTaskId;
          return okOutcome;
        },
      });

      const result = await manager.restore();
      expect(result).toEqual({ resumed: 1, failed: 0 });
      await manager.waitForCompletion('old-1');
      // Resuming, not re-submitting: the upstream task was already paid for.
      expect(resumedWith).toBe('remote-9');
    });

    it('fails a job that died before submission instead of re-submitting it', async () => {
      const execute = vi.fn(async () => okOutcome);
      const { manager } = buildManager({
        stored: [storedJob({ status: 'pending', remoteTaskId: undefined })],
        execute,
      });

      const result = await manager.restore();
      expect(result).toEqual({ resumed: 0, failed: 1 });
      expect(manager.getJob('old-1')?.status).toBe('failed');
      expect(execute).not.toHaveBeenCalled();
    });

    it('leaves terminal jobs untouched', async () => {
      const { manager } = buildManager({
        stored: [storedJob({ id: 'done-1', status: 'done' })],
        execute: async () => okOutcome,
      });

      expect(await manager.restore()).toEqual({ resumed: 0, failed: 0 });
      expect(manager.getJob('done-1')?.status).toBe('done');
    });
  });
});
