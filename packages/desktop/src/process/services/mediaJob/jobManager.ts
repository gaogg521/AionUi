/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Media job engine: owns the lifecycle of every image/video generation so that
 * a job outlives the tool call that started it.
 *
 * Why the main process owns this rather than the MCP subprocess:
 * a video task runs for minutes, and the agent CLI on the other side may time
 * out or be killed long before it finishes. The job keeps running here, the
 * asset still lands in the workspace, and the agent can pick the result back up
 * by id. See architecture doc §4.3 / decision D2.
 *
 * IO is injected (provider resolution, generation, persistence) so the state
 * machine itself is testable without a backend, a network, or a disk.
 */

import type { TProviderWithModel } from '@/common/config/storage';
import type { MediaGenOutcome, MediaProgressUpdate } from '@/common/media/types';
import { resolveMediaModelSpec } from '@/common/media/catalog';
import type { MediaJobRecord, MediaJobRequest, MediaJobSnapshot } from './types';
import { isTerminal } from './types';

/** Concurrent generations per provider. Low on purpose — image/video endpoints rate-limit hard. */
const DEFAULT_MAX_CONCURRENT_PER_PROVIDER = 2;

export type MediaJobExecutor = (input: {
  job: MediaJobRecord;
  provider: TProviderWithModel;
  signal: AbortSignal;
  onProgress: (update: MediaProgressUpdate) => void;
  onTaskSubmitted: (taskId: string) => void;
  resumeTaskId?: string;
}) => Promise<MediaGenOutcome>;

export type MediaJobManagerOptions = {
  /** Resolves a provider (including its credentials) at execution time. */
  resolveProvider: (providerId: string, model: string) => Promise<TProviderWithModel | null>;
  execute: MediaJobExecutor;
  loadJobs: () => Promise<MediaJobRecord[]>;
  saveJobs: (jobs: MediaJobRecord[]) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  maxConcurrentPerProvider?: number;
};

export class MediaJobManager {
  private readonly jobs = new Map<string, MediaJobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runningByProvider = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly completionWaiters = new Map<string, Array<(job: MediaJobSnapshot) => void>>();
  private readonly listeners = new Set<(job: MediaJobSnapshot) => void>();
  private readonly maxConcurrentPerProvider: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: MediaJobManagerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? defaultNewId;
    this.maxConcurrentPerProvider = options.maxConcurrentPerProvider ?? DEFAULT_MAX_CONCURRENT_PER_PROVIDER;
  }

  /** Subscribe to every job state change (used to fan out to the renderer). */
  onJobUpdate(listener: (job: MediaJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getJob(id: string): MediaJobSnapshot | undefined {
    return this.jobs.get(id);
  }

  listJobs(): MediaJobSnapshot[] {
    return [...this.jobs.values()].toSorted((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Restore jobs from disk and resume the recoverable ones.
   *
   * A job is only resumable when a remote task id was persisted: that task was
   * already accepted (and paid for) upstream, so re-polling is both safe and
   * necessary. Anything that died before submission is failed rather than
   * silently re-submitted — a duplicate charge is worse than a clear error.
   */
  async restore(): Promise<{ resumed: number; failed: number }> {
    const stored = await this.options.loadJobs();
    let resumed = 0;
    let failed = 0;

    for (const job of stored) {
      this.jobs.set(job.id, job);
      if (isTerminal(job.status)) continue;

      if (job.remoteTaskId) {
        job.status = 'polling';
        job.updatedAt = this.now();
        resumed++;
        this.enqueue(job.id);
      } else {
        job.status = 'failed';
        job.error = 'Interrupted before the request was submitted; run it again.';
        job.updatedAt = this.now();
        failed++;
      }
    }

    await this.persist();
    this.pump();
    return { resumed, failed };
  }

  /** Create a job and start it (subject to the per-provider concurrency cap). */
  create(request: MediaJobRequest): MediaJobSnapshot {
    const timestamp = this.now();
    const job: MediaJobRecord = {
      id: this.newId(),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...request,
    };
    this.jobs.set(job.id, job);
    void this.persist();
    this.emit(job);
    this.enqueue(job.id);
    this.pump();
    return job;
  }

  /** Resolve once the job reaches a terminal state (already-terminal resolves immediately). */
  waitForCompletion(id: string): Promise<MediaJobSnapshot> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`Unknown media job: ${id}`));
    if (isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const waiters = this.completionWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.completionWaiters.set(id, waiters);
    });
  }

  /**
   * Cancel a job. Aborts the in-flight request if it is running; a queued job
   * is dropped before it ever starts.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || isTerminal(job.status)) return false;

    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);

    this.controllers.get(id)?.abort();
    this.finish(job, { status: 'cancelled', error: 'cancelled' });
    return true;
  }

  /** Abort every in-flight job without marking them failed (app shutdown). */
  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  // ===== internals =====

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
  }

  /** Start as many queued jobs as the concurrency caps allow. */
  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const id = this.queue[i];
      const job = this.jobs.get(id);
      if (!job || isTerminal(job.status)) {
        this.queue.splice(i, 1);
        continue;
      }
      const running = this.runningByProvider.get(job.providerId) ?? 0;
      if (running >= this.maxConcurrentPerProvider) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      void this.run(job);
    }
  }

  private async run(job: MediaJobRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.runningByProvider.set(job.providerId, (this.runningByProvider.get(job.providerId) ?? 0) + 1);

    try {
      const provider = await this.options.resolveProvider(job.providerId, job.model);
      if (!provider) {
        this.finish(job, {
          status: 'failed',
          error: `Provider "${job.providerId}" is no longer configured; re-select an image/video model in Settings > Tools.`,
        });
        return;
      }

      // Catalog data can change between runs (app upgrade); recompute rather
      // than trusting the id stored with the job.
      const spec = resolveMediaModelSpec(job.kind, provider, job.model);
      if (spec && job.specId && spec.id !== job.specId) {
        job.specId = spec.id;
      }

      const resumeTaskId = job.remoteTaskId;
      this.update(job, { status: resumeTaskId ? 'polling' : 'pending' });

      const outcome = await this.options.execute({
        job,
        provider,
        signal: controller.signal,
        resumeTaskId,
        onProgress: (update) => this.onProgress(job, update),
        onTaskSubmitted: (taskId) => this.onTaskSubmitted(job, taskId),
      });

      if (controller.signal.aborted) {
        // cancel() already settled the record.
        return;
      }

      if (outcome.success) {
        this.finish(job, { status: 'done', assets: outcome.assets });
      } else {
        this.finish(job, {
          status: outcome.error === 'timeout' ? 'timeout' : 'failed',
          error: outcome.error || outcome.text,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.finish(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.controllers.delete(job.id);
      const running = (this.runningByProvider.get(job.providerId) ?? 1) - 1;
      if (running <= 0) this.runningByProvider.delete(job.providerId);
      else this.runningByProvider.set(job.providerId, running);
      this.pump();
    }
  }

  private onProgress(job: MediaJobRecord, update: MediaProgressUpdate): void {
    const status =
      update.stage === 'downloading' || update.stage === 'saving'
        ? 'downloading'
        : update.stage === 'submitted' || update.stage === 'queued' || update.stage === 'running'
          ? job.remoteTaskId
            ? 'polling'
            : 'submitted'
          : job.status;
    this.update(job, { progress: update, status });
  }

  private onTaskSubmitted(job: MediaJobRecord, taskId: string): void {
    // Persist immediately: between submission and the first poll is exactly the
    // window where a crash would orphan a task the user already paid for.
    this.update(job, { remoteTaskId: taskId, status: 'polling' });
  }

  private update(job: MediaJobRecord, patch: Partial<MediaJobRecord>): void {
    Object.assign(job, patch, { updatedAt: this.now() });
    void this.persist();
    this.emit(job);
  }

  private finish(job: MediaJobRecord, patch: Partial<MediaJobRecord>): void {
    this.update(job, patch);
    const waiters = this.completionWaiters.get(job.id);
    if (waiters) {
      this.completionWaiters.delete(job.id);
      for (const resolve of waiters) resolve(job);
    }
  }

  private emit(job: MediaJobRecord): void {
    const snapshot: MediaJobSnapshot = { ...job };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken subscriber must not take the engine down.
      }
    }
  }

  private persist(): Promise<void> {
    return this.options.saveJobs([...this.jobs.values()]).catch((error) => {
      console.warn('[mediaJobManager] failed to persist jobs:', error);
    });
  }
}

let idCounter = 0;
function defaultNewId(): string {
  idCounter += 1;
  return `mj-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
