/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashscopeDriver } from '@/common/media/adapters/taskDrivers/dashscopeDriver';
import type { TaskPollContext, TaskSubmitContext } from '@/common/media/adapters/taskDrivers/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const baseCtx = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'sk-dashscope-test',
  model: 'wanx2.1-t2i-turbo',
};

describe('dashscopeDriver', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('submit', () => {
    it('submits an image request to the text2image endpoint with the async header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ output: { task_id: 'task-1' } }));
      vi.stubGlobal('fetch', fetchMock);

      const ctx: TaskSubmitContext = { ...baseCtx, kind: 'image', prompt: 'a cat', inputs: [], params: {} };
      const result = await dashscopeDriver.submit(ctx);

      expect(result).toEqual({ taskId: 'task-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis');
      expect(init.headers['X-DashScope-Async']).toBe('enable');
    });

    it('submits a video request to the video-synthesis endpoint, using img_url for the first frame', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ output: { task_id: 'task-2' } }));
      vi.stubGlobal('fetch', fetchMock);

      const ctx: TaskSubmitContext = {
        ...baseCtx,
        kind: 'video',
        prompt: 'animate this',
        inputs: ['https://cdn.example.com/first.png'],
        params: {},
      };
      await dashscopeDriver.submit(ctx);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
      const body = JSON.parse(init.body);
      expect(body.input.img_url).toBe('https://cdn.example.com/first.png');
      expect(body.input.ref_img).toBeUndefined();
    });

    it('prefers an explicit firstFrameImage over the raw inputs entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ output: { task_id: 'task-3' } }));
      vi.stubGlobal('fetch', fetchMock);

      await dashscopeDriver.submit({
        ...baseCtx,
        kind: 'video',
        prompt: 'x',
        inputs: ['https://cdn.example.com/fallback.png'],
        params: { firstFrameImage: 'https://cdn.example.com/explicit.png' },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.input.img_url).toBe('https://cdn.example.com/explicit.png');
    });

    it('throws when the response carries no task_id', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ output: {} })));

      await expect(
        dashscopeDriver.submit({ ...baseCtx, kind: 'image', prompt: 'x', inputs: [], params: {} })
      ).rejects.toThrow('DashScope task submission returned no task_id');
    });
  });

  describe('poll', () => {
    const pollCtx: TaskPollContext = baseCtx;

    it('maps PENDING/RUNNING to pending/running poll states', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: 'PENDING' } })));
      expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({ state: 'pending' });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: 'RUNNING' } })));
      expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({ state: 'running' });
    });

    it('treats an unrecognized status as still running rather than failing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: 'SOMETHING_NEW' } })));

      expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({ state: 'running' });
    });

    it('extracts url and b64_image results, plus a top-level video_url, on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            output: {
              task_status: 'SUCCEEDED',
              results: [{ url: 'https://cdn.example.com/out.png' }, { b64_image: 'abc123' }],
              video_url: 'https://cdn.example.com/out.mp4',
            },
          })
        )
      );

      const result = await dashscopeDriver.poll(pollCtx, 't1');

      expect(result).toEqual({
        state: 'succeeded',
        items: [
          { url: 'https://cdn.example.com/out.png' },
          { b64: 'abc123' },
          { url: 'https://cdn.example.com/out.mp4' },
        ],
      });
    });

    it('fails when DashScope reports success but returns no results', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: 'SUCCEEDED', results: [] } }))
      );

      expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({
        state: 'failed',
        error: 'DashScope reported success but returned no results',
      });
    });

    it.each(['FAILED', 'CANCELED', 'CANCELLED'])(
      'maps a terminal "%s" status to a failed poll result',
      async (status) => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: status, message: 'vendor says no' } }))
        );

        expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({ state: 'failed', error: 'vendor says no' });
      }
    );

    it('falls back to a generic message when a failed status carries no message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ output: { task_status: 'FAILED' } })));

      expect(await dashscopeDriver.poll(pollCtx, 't1')).toEqual({ state: 'failed', error: 'DashScope task FAILED' });
    });
  });

  describe('cancel', () => {
    it('posts to the cancel endpoint without the async header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await dashscopeDriver.cancel(baseCtx, 't1');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/t1/cancel');
      expect(init.headers['X-DashScope-Async']).toBeUndefined();
    });

    it('swallows a failed cancel request rather than throwing (best effort)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      await expect(dashscopeDriver.cancel(baseCtx, 't1')).resolves.toBeUndefined();
    });
  });
});
