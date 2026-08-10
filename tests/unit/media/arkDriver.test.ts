/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { arkDriver } from '@/common/media/adapters/taskDrivers/arkDriver';
import type { TaskPollContext, TaskSubmitContext } from '@/common/media/adapters/taskDrivers/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const baseCtx = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'sk-ark-test', model: 'seedance-1-0' };

describe('arkDriver', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('submit', () => {
    it('encodes video params as prompt suffix flags and posts to the tasks endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'task-123' }));
      vi.stubGlobal('fetch', fetchMock);

      const ctx: TaskSubmitContext = {
        ...baseCtx,
        prompt: 'a flying cat',
        inputs: [],
        params: { resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', seed: 7 },
      };

      const result = await arkDriver.submit(ctx);

      expect(result).toEqual({ taskId: 'task-123' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
      expect(init.headers.Authorization).toBe('Bearer sk-ark-test');
      const body = JSON.parse(init.body);
      expect(body.content[0].text).toBe('a flying cat --resolution 720p --dur 5 --ratio 16:9 --seed 7');
    });

    it('sends the prompt unmodified when no decorating params are set', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'task-123' }));
      vi.stubGlobal('fetch', fetchMock);

      await arkDriver.submit({ ...baseCtx, prompt: 'a mountain', inputs: [], params: {} });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.content[0].text).toBe('a mountain');
      expect(body.content).toHaveLength(1);
    });

    it('attaches the first input as first_frame and an explicit lastFrameImage as last_frame', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'task-123' }));
      vi.stubGlobal('fetch', fetchMock);

      await arkDriver.submit({
        ...baseCtx,
        prompt: 'animate this',
        inputs: ['https://cdn.example.com/first.png'],
        params: { lastFrameImage: 'https://cdn.example.com/last.png' },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.content).toEqual([
        { type: 'text', text: 'animate this' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/first.png' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/last.png' }, role: 'last_frame' },
      ]);
    });

    it('falls back to the default Ark host when baseUrl is empty', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'task-123' }));
      vi.stubGlobal('fetch', fetchMock);

      await arkDriver.submit({ ...baseCtx, baseUrl: '', prompt: 'x', inputs: [], params: {} });

      expect(fetchMock.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    });

    it('throws when the response carries no task id', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' })));

      await expect(arkDriver.submit({ ...baseCtx, prompt: 'x', inputs: [], params: {} })).rejects.toThrow(
        'Ark task submission returned no id'
      );
    });
  });

  describe('poll', () => {
    const pollCtx: TaskPollContext = baseCtx;

    it('maps queued/running to pending/running poll states', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'queued' })));
      expect(await arkDriver.poll(pollCtx, 'task-1')).toEqual({ state: 'pending' });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'running' })));
      expect(await arkDriver.poll(pollCtx, 'task-1')).toEqual({ state: 'running' });
    });

    it('treats an unrecognized status as still running rather than failing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'some-new-status' })));
      expect(await arkDriver.poll(pollCtx, 'task-1')).toEqual({ state: 'running' });
    });

    it('extracts video_url, image_url, and content.data entries on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            status: 'succeeded',
            content: {
              video_url: 'https://cdn.example.com/out.mp4',
              data: [{ url: 'https://cdn.example.com/extra.png' }, { b64_json: 'abc123' }],
            },
          })
        )
      );

      const result = await arkDriver.poll(pollCtx, 'task-1');

      expect(result).toEqual({
        state: 'succeeded',
        items: [
          { url: 'https://cdn.example.com/out.mp4' },
          { url: 'https://cdn.example.com/extra.png' },
          { b64: 'abc123' },
        ],
      });
    });

    it('fails when Ark reports success but the content is empty', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'succeeded', content: {} })));

      const result = await arkDriver.poll(pollCtx, 'task-1');

      expect(result).toEqual({ state: 'failed', error: 'Ark reported success but returned no content' });
    });

    it.each(['failed', 'cancelled', 'canceled'])('maps a terminal "%s" status to a failed poll result', async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ status, error: { message: 'vendor says no' } }))
      );

      expect(await arkDriver.poll(pollCtx, 'task-1')).toEqual({ state: 'failed', error: 'vendor says no' });
    });

    it('falls back to a generic message when a failed status carries no error detail', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'failed' })));

      expect(await arkDriver.poll(pollCtx, 'task-1')).toEqual({ state: 'failed', error: 'Ark task failed' });
    });
  });

  describe('cancel', () => {
    it('sends a DELETE request for the task', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);

      await arkDriver.cancel(baseCtx, 'task-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('swallows a failed cancel request rather than throwing (best effort)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      await expect(arkDriver.cancel(baseCtx, 'task-1')).resolves.toBeUndefined();
    });
  });
});
