/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Form C adapter — submit, poll, download.
 *
 * Everything vendor-specific lives in a driver (taskDrivers/); this file owns
 * the parts that must behave identically everywhere: backoff, timeout,
 * cancellation, resume-after-restart, and persisting results to disk.
 */

import { downloadUrlMediaAsset, isHttpUrl, resolveLocalInputPath, saveBase64MediaAsset } from '../mediaAssets';
import type { MediaAsset, MediaGenOutcome, MediaGenRequest, MediaProviderAdapter } from '../types';
import { getTaskDriver, type TaskPollContext, type TaskSubmitContext } from './taskDrivers';
import * as fs from 'fs';
import * as path from 'path';

/** Poll interval grows from the spec's base up to this ceiling. */
const MAX_INTERVAL_MS = 15_000;
const BACKOFF_FACTOR = 1.35;
/** Consecutive transient poll errors tolerated before giving up. */
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class TaskPollAdapter implements MediaProviderAdapter {
  readonly form = 'C' as const;

  async generate(req: MediaGenRequest): Promise<MediaGenOutcome> {
    const { spec, provider, workspaceDir, signal, prompt, params, kind } = req;

    if (!spec) {
      return {
        success: false,
        assets: [],
        text: 'Error: async generation requires a catalog entry.',
        error: 'no-spec',
      };
    }
    const driver = getTaskDriver(spec.endpointStyle);
    if (!driver) {
      return {
        success: false,
        assets: [],
        text: `Error: no task driver for endpoint style "${spec.endpointStyle}".`,
        error: 'no-driver',
      };
    }

    const pollCtx: TaskPollContext = {
      kind,
      model: provider.use_model,
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      spec,
      signal,
    };

    try {
      let taskId = req.resumeTaskId;

      if (!taskId) {
        req.onProgress?.({ stage: 'preparing' });
        const inputs = await normalizeInputs(req.inputUris, workspaceDir);
        const submitCtx: TaskSubmitContext = { ...pollCtx, prompt, params, inputs };
        const submitted = await driver.submit(submitCtx);
        taskId = submitted.taskId;
        // Hand the id up before the first poll: a crash after submission but
        // before persistence would orphan a task the user already paid for.
        req.onTaskSubmitted?.(taskId);
        req.onProgress?.({ stage: 'submitted', taskId });
      } else {
        req.onProgress?.({ stage: 'running', taskId, message: 'resumed after restart' });
      }

      const items = await this.pollUntilDone(driver, pollCtx, taskId, req);

      req.onProgress?.({ stage: 'downloading', taskId });
      const assets: MediaAsset[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.b64) assets.push(await saveBase64MediaAsset(kind, item.b64, workspaceDir, i));
        else if (item.url) assets.push(await downloadUrlMediaAsset(kind, item.url, workspaceDir, i));
      }

      if (assets.length === 0) {
        return {
          success: false,
          assets: [],
          text: 'Task succeeded but produced no downloadable result.',
          error: 'empty-result',
        };
      }

      req.onProgress?.({ stage: 'saving', taskId });
      return { success: true, assets, text: `${kind === 'video' ? 'Video' : 'Image'} generated successfully.` };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        return { success: false, assets: [], text: 'Generation was cancelled.', error: 'cancelled' };
      }
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message === 'timeout';
      return {
        success: false,
        assets: [],
        text: isTimeout
          ? `Generation timed out after ${Math.round((spec.polling?.timeoutMs ?? 0) / 1000)}s. The remote task may still finish; check the job status later.`
          : `Error generating ${kind}: ${message}`,
        error: isTimeout ? 'timeout' : message,
      };
    }
  }

  private async pollUntilDone(
    driver: NonNullable<ReturnType<typeof getTaskDriver>>,
    ctx: TaskPollContext,
    taskId: string,
    req: MediaGenRequest
  ) {
    const intervalBase = req.spec?.polling?.intervalMs ?? 3000;
    const timeoutMs = req.spec?.polling?.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    let interval = intervalBase;
    let consecutiveErrors = 0;

    for (;;) {
      if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (Date.now() > deadline) {
        // Best-effort remote cancel so the vendor stops billing a task nobody
        // is waiting for any more.
        await driver.cancel?.(ctx, taskId).catch(() => {
          // Best effort — we are failing the job regardless.
        });
        throw new Error('timeout');
      }

      await sleep(interval, req.signal);

      let result;
      try {
        result = await driver.poll(ctx, taskId);
        consecutiveErrors = 0;
      } catch (error) {
        if (isAbortError(error)) throw error;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw error;
        // A transient network blip must not discard a task already paid for.
        interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * BACKOFF_FACTOR));
        continue;
      }

      switch (result.state) {
        case 'succeeded':
          return result.items;
        case 'failed':
          throw new Error(result.error);
        case 'running':
          req.onProgress?.({ stage: 'running', taskId, percent: result.percent });
          break;
        case 'pending':
          req.onProgress?.({ stage: 'queued', taskId });
          break;
      }

      interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * BACKOFF_FACTOR));
    }
  }
}

/**
 * Task APIs fetch conditioning images by URL server-side, so local files have
 * to travel as data URLs.
 */
async function normalizeInputs(inputUris: string[], workspaceDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const uri of inputUris) {
    if (isHttpUrl(uri)) {
      out.push(uri);
      continue;
    }
    const fullPath = await resolveLocalInputPath(uri, workspaceDir);
    const buffer = await fs.promises.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    out.push(`data:${mime};base64,${buffer.toString('base64')}`);
  }
  return out;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted');
}
