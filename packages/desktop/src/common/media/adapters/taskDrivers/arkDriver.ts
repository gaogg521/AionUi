/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Volcano Ark content-generation task API (Seedance video, Jimeng images).
 *
 * The provider is already configured for chat at `.../api/v3`, which is also
 * the task API root — only the path is appended, so credentials carry over.
 *
 * Ark encodes generation options as text suffixes on the prompt content part
 * (`--resolution 720p --dur 5`) rather than as JSON fields, which is why this
 * driver builds a decorated prompt instead of a parameters object.
 */

import { ensureVersionedBaseUrl } from '../baseUrl';
import {
  readJsonOrThrow,
  type TaskDriver,
  type TaskPollContext,
  type TaskPollResult,
  type TaskResultItem,
  type TaskSubmitContext,
} from './types';

/**
 * Ark's own root (`.../api/v3`) already carries a version segment, so for a
 * native provider this is a no-op. The normalization matters for the other way
 * users reach Seedance: an OpenAI-compatible gateway (LiteLLM and friends) that
 * proxies the task API. Those roots are configured for chat without a version
 * segment, and the gateway's front proxy only routes the versioned path — the
 * unversioned one comes back as a bare 405/404 that names no cause. Same
 * failure the images path hit on a real LiteLLM deployment.
 */
const apiRoot = (baseUrl: string): string => {
  return ensureVersionedBaseUrl(baseUrl) || 'https://ark.cn-beijing.volces.com/api/v3';
};

const headers = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`,
});

function decoratePrompt(ctx: TaskSubmitContext): string {
  const flags: string[] = [];
  if (ctx.params.resolution) flags.push(`--resolution ${ctx.params.resolution}`);
  if (ctx.params.durationSeconds) flags.push(`--dur ${ctx.params.durationSeconds}`);
  if (ctx.params.aspectRatio) flags.push(`--ratio ${ctx.params.aspectRatio}`);
  if (ctx.params.seed !== undefined) flags.push(`--seed ${ctx.params.seed}`);
  return flags.length > 0 ? `${ctx.prompt} ${flags.join(' ')}` : ctx.prompt;
}

export const arkDriver: TaskDriver = {
  id: 'ark-task',

  async submit(ctx: TaskSubmitContext): Promise<{ taskId: string }> {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: decoratePrompt(ctx) }];

    const firstFrame = ctx.params.firstFrameImage || ctx.inputs[0];
    if (firstFrame) {
      content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
    }
    if (ctx.params.lastFrameImage) {
      content.push({ type: 'image_url', image_url: { url: ctx.params.lastFrameImage }, role: 'last_frame' });
    }

    const response = await fetch(`${apiRoot(ctx.baseUrl)}/contents/generations/tasks`, {
      method: 'POST',
      headers: headers(ctx.apiKey),
      body: JSON.stringify({ model: ctx.model, content }),
      signal: ctx.signal,
    });

    const payload = await readJsonOrThrow(response, 'Ark task submission');
    const taskId = payload.id as string | undefined;
    if (!taskId) {
      throw new Error(`Ark task submission returned no id: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return { taskId };
  },

  async poll(ctx: TaskPollContext, taskId: string): Promise<TaskPollResult> {
    const response = await fetch(`${apiRoot(ctx.baseUrl)}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: headers(ctx.apiKey),
      signal: ctx.signal,
    });

    const payload = await readJsonOrThrow(response, 'Ark task poll');
    const status = String(payload.status || '').toLowerCase();
    const error = payload.error as { message?: string } | undefined;

    switch (status) {
      case 'queued':
        return { state: 'pending' };
      case 'running':
        return { state: 'running' };
      case 'succeeded': {
        const items: TaskResultItem[] = [];
        const content = payload.content as
          | { video_url?: string; image_url?: string; data?: Array<{ url?: string; b64_json?: string }> }
          | undefined;
        if (content?.video_url) items.push({ url: content.video_url });
        if (content?.image_url) items.push({ url: content.image_url });
        for (const entry of content?.data ?? []) {
          if (entry.url) items.push({ url: entry.url });
          else if (entry.b64_json) items.push({ b64: entry.b64_json });
        }
        if (items.length === 0) {
          return { state: 'failed', error: 'Ark reported success but returned no content' };
        }
        return { state: 'succeeded', items };
      }
      case 'failed':
      case 'cancelled':
      case 'canceled':
        return { state: 'failed', error: error?.message || `Ark task ${status}` };
      default:
        return { state: 'running' };
    }
  },

  async cancel(ctx: TaskPollContext, taskId: string): Promise<void> {
    await fetch(`${apiRoot(ctx.baseUrl)}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      headers: headers(ctx.apiKey),
    }).catch(() => {
      // Best effort: the job is already being torn down locally.
    });
  },
};
