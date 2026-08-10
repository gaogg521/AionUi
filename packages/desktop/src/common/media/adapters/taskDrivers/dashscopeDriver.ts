/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alibaba DashScope async task API (Tongyi WanX images and video).
 *
 * Credentials come from the provider the user already configured for chat
 * (`dashscope.aliyuncs.com/compatible-mode/v1`); only the path changes, so no
 * re-configuration is needed. Submission is opt-in async via the
 * `X-DashScope-Async` header, then a shared `/api/v1/tasks/{id}` poll endpoint.
 */

import {
  readJsonOrThrow,
  stripCompatSuffix,
  toStarSize,
  type TaskDriver,
  type TaskPollContext,
  type TaskPollResult,
  type TaskResultItem,
  type TaskSubmitContext,
} from './types';

const IMAGE_PATH = '/api/v1/services/aigc/text2image/image-synthesis';
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';

const apiRoot = (baseUrl: string): string => {
  const root = stripCompatSuffix(baseUrl);
  return root || 'https://dashscope.aliyuncs.com';
};

const headers = (apiKey: string, async: boolean): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`,
  ...(async ? { 'X-DashScope-Async': 'enable' } : {}),
});

export const dashscopeDriver: TaskDriver = {
  id: 'dashscope-task',

  async submit(ctx: TaskSubmitContext): Promise<{ taskId: string }> {
    const isVideo = ctx.kind === 'video';
    const input: Record<string, unknown> = { prompt: ctx.prompt };
    if (ctx.params.negativePrompt) input.negative_prompt = ctx.params.negativePrompt;
    if (ctx.inputs.length > 0) {
      // WanX takes a single conditioning image; for video it is the first frame.
      input[isVideo ? 'img_url' : 'ref_img'] = ctx.params.firstFrameImage || ctx.inputs[0];
    }

    const parameters: Record<string, unknown> = {};
    const size = toStarSize(ctx.params.size);
    if (size) parameters.size = size;
    if (ctx.params.n && ctx.params.n > 1) parameters.n = ctx.params.n;
    if (ctx.params.seed !== undefined) parameters.seed = ctx.params.seed;
    if (ctx.params.resolution) parameters.resolution = ctx.params.resolution;
    if (ctx.params.durationSeconds) parameters.duration = ctx.params.durationSeconds;

    const response = await fetch(`${apiRoot(ctx.baseUrl)}${isVideo ? VIDEO_PATH : IMAGE_PATH}`, {
      method: 'POST',
      headers: headers(ctx.apiKey, true),
      body: JSON.stringify({ model: ctx.model, input, parameters }),
      signal: ctx.signal,
    });

    const payload = await readJsonOrThrow(response, 'DashScope task submission');
    const output = payload.output as { task_id?: string } | undefined;
    const taskId = output?.task_id;
    if (!taskId) {
      throw new Error(`DashScope task submission returned no task_id: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return { taskId };
  },

  async poll(ctx: TaskPollContext, taskId: string): Promise<TaskPollResult> {
    const response = await fetch(`${apiRoot(ctx.baseUrl)}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: headers(ctx.apiKey, false),
      signal: ctx.signal,
    });

    const payload = await readJsonOrThrow(response, 'DashScope task poll');
    const output = (payload.output ?? {}) as {
      task_status?: string;
      results?: Array<{ url?: string; b64_image?: string; message?: string }>;
      video_url?: string;
      message?: string;
    };

    switch ((output.task_status || '').toUpperCase()) {
      case 'PENDING':
        return { state: 'pending' };
      case 'RUNNING':
        return { state: 'running' };
      case 'SUCCEEDED': {
        const items: TaskResultItem[] = [];
        for (const result of output.results ?? []) {
          if (result.url) items.push({ url: result.url });
          else if (result.b64_image) items.push({ b64: result.b64_image });
        }
        if (output.video_url) items.push({ url: output.video_url });
        if (items.length === 0) {
          return { state: 'failed', error: 'DashScope reported success but returned no results' };
        }
        return { state: 'succeeded', items };
      }
      case 'FAILED':
      case 'CANCELED':
      case 'CANCELLED':
        return { state: 'failed', error: output.message || `DashScope task ${output.task_status}` };
      default:
        // Unknown status: treat as still running rather than failing the job —
        // the shared timeout is the backstop.
        return { state: 'running' };
    }
  },

  async cancel(ctx: TaskPollContext, taskId: string): Promise<void> {
    await fetch(`${apiRoot(ctx.baseUrl)}/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: headers(ctx.apiKey, false),
    }).catch(() => {
      // Best effort: the job is already being torn down locally.
    });
  },
};
