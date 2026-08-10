/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit-level coverage for the thin MCP shell itself: request shaping,
 * response formatting, and the "service unavailable" branches. A tiny fake
 * TCP server stands in for the main-process job service so the real framing
 * code in `sendTcpRequest` runs, without depending on `mediaJob`'s real job
 * engine (that round trip is `mediaMcpServer.integration.test.ts`'s job).
 *
 * `MEDIA_MCP_PORT` is read once at module load time, so each scenario that
 * needs a different port (or no port at all) resets the module registry and
 * re-imports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';

type Frame = Record<string, unknown>;

/** A fake main-process media service speaking the real 4-byte-length-prefixed protocol. */
function startFakeMediaService(
  respond: (request: Frame) => Frame | Frame[]
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const len = buffer.readUInt32BE(0);
          if (buffer.length < 4 + len) break;
          const json = buffer.subarray(4, 4 + len).toString('utf-8');
          buffer = buffer.subarray(4 + len);
          const request = JSON.parse(json) as Frame;
          const frames = ([] as Frame[]).concat(respond(request));
          for (const frame of frames) {
            const body = Buffer.from(JSON.stringify(frame), 'utf-8');
            const header = Buffer.alloc(4);
            header.writeUInt32BE(body.length, 0);
            socket.write(Buffer.concat([header, body]));
          }
          socket.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

describe('imageGenServer (thin shell)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('with the media service unavailable (MEDIA_MCP_PORT unset)', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.stubEnv('MEDIA_MCP_PORT', '');
    });

    it('requirePort reports the service as unavailable', async () => {
      const { requirePort } = await import('@process/resources/builtinMcp/imageGenServer');
      expect(requirePort()).toContain('media generation service is not available');
    });

    it('handleImageGeneration fails fast without attempting a connection', async () => {
      const { handleImageGeneration } = await import('@process/resources/builtinMcp/imageGenServer');
      const result = await handleImageGeneration({ prompt: 'a cat' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('MEDIA_MCP_PORT is unset');
    });

    it('handleMediaJobStatus fails fast without attempting a connection', async () => {
      const { handleMediaJobStatus } = await import('@process/resources/builtinMcp/imageGenServer');
      const result = await handleMediaJobStatus({});
      expect(result.isError).toBe(true);
    });
  });

  describe('with a real (fake) media service listening', () => {
    let close: () => Promise<void>;

    async function withService(respond: (request: Frame) => Frame | Frame[]) {
      const service = await startFakeMediaService(respond);
      close = service.close;
      vi.resetModules();
      vi.stubEnv('MEDIA_MCP_PORT', String(service.port));
      return import('@process/resources/builtinMcp/imageGenServer');
    }

    afterEach(async () => {
      await close?.();
    });

    it('renderJob lists saved assets, the job id/status line, and any error', async () => {
      const { renderJob } = await withService(() => ({ type: 'result', success: true }));
      const text = renderJob(
        {
          jobId: 'job-1',
          kind: 'image',
          status: 'done',
          assets: [{ filePath: '/ws/img-1.png', relativePath: 'img-1.png', mimeType: 'image/png', kind: 'image' }],
        },
        'fallback'
      );
      expect(text).toContain('Generated image saved to: /ws/img-1.png');
      expect(text).toContain('(job job-1, status done)');
    });

    it('renderJob falls back to the provided text when there is no job', async () => {
      const { renderJob } = await withService(() => ({ type: 'result', success: true }));
      expect(renderJob(undefined, 'no job data')).toBe('no job data');
    });

    it('handleImageGeneration maps tool args to a generate request and renders a successful job', async () => {
      let seenRequest: Frame | undefined;
      const { handleImageGeneration } = await withService((request) => {
        seenRequest = request;
        return {
          type: 'result',
          success: true,
          job: { jobId: 'job-2', kind: 'image', status: 'done', assets: [] },
        };
      });

      const result = await handleImageGeneration({
        prompt: 'a red bicycle',
        image_uris: ['ref.png'],
        size: '1024x1024',
        aspect_ratio: '1:1',
        n: 2,
        quality: 'hd',
        seed: 7,
        negative_prompt: 'blurry',
      });

      expect(seenRequest).toMatchObject({
        op: 'generate',
        kind: 'image',
        prompt: 'a red bicycle',
        inputUris: ['ref.png'],
        params: {
          size: '1024x1024',
          aspectRatio: '1:1',
          n: 2,
          quality: 'hd',
          seed: 7,
          negativePrompt: 'blurry',
        },
      });
      // Never a model-supplied workspace_dir — only the shell's own trusted cwd (see #3906).
      expect(seenRequest).toHaveProperty('workspaceDir');
      expect((seenRequest as Frame).workspace_dir).toBeUndefined();
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('(job job-2, status done)');
    });

    it('handleVideoGeneration passes first_frame_image as the sole input URI', async () => {
      let seenRequest: Frame | undefined;
      const { handleVideoGeneration } = await withService((request) => {
        seenRequest = request;
        return { type: 'result', success: true, job: { jobId: 'job-3', kind: 'video', status: 'done' } };
      });

      await handleVideoGeneration({ prompt: 'a flying cat', first_frame_image: 'first.png', duration_seconds: 5 });

      expect(seenRequest).toMatchObject({
        op: 'generate',
        kind: 'video',
        inputUris: ['first.png'],
        params: expect.objectContaining({ firstFrameImage: 'first.png', durationSeconds: 5 }),
      });
    });

    it('handleImageGeneration surfaces a job-level failure, including the job id for follow-up', async () => {
      const { handleImageGeneration } = await withService(() => ({
        type: 'result',
        success: false,
        error: 'rate limited',
        job: { jobId: 'job-4', kind: 'image', status: 'failed', error: 'rate limited' },
      }));

      const result = await handleImageGeneration({ prompt: 'a cat' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error generating image: rate limited (job job-4)');
    });

    it('handleMediaJobStatus renders a single job when job_id is given', async () => {
      const { handleMediaJobStatus } = await withService(() => ({
        type: 'result',
        success: true,
        job: { jobId: 'job-5', kind: 'video', status: 'polling' },
      }));

      const result = await handleMediaJobStatus({ job_id: 'job-5' });

      expect(result.content[0].text).toContain('(job job-5, status polling)');
    });

    it('handleMediaJobStatus lists recent jobs when no job_id is given', async () => {
      const { handleMediaJobStatus } = await withService(() => ({
        type: 'result',
        success: true,
        jobs: [
          { jobId: 'a', kind: 'image', status: 'done' },
          { jobId: 'b', kind: 'video', status: 'failed', error: 'timeout' },
        ],
      }));

      const result = await handleMediaJobStatus({});

      expect(result.content[0].text).toBe('- a [image] done\n- b [video] failed — timeout');
    });

    it('handleMediaJobStatus reports "no jobs yet" for an empty list', async () => {
      const { handleMediaJobStatus } = await withService(() => ({ type: 'result', success: true, jobs: [] }));

      const result = await handleMediaJobStatus({});

      expect(result.content[0].text).toBe('No media generation jobs yet.');
    });
  });

  it('reports a clear connection error, mentioning the job-status fallback, when nothing is listening', async () => {
    // Bind a real server to grab a free port, then close it immediately —
    // guarantees ECONNREFUSED rather than guessing at an unused port number.
    const probe = await startFakeMediaService(() => ({ type: 'result', success: true }));
    await probe.close();

    vi.resetModules();
    vi.stubEnv('MEDIA_MCP_PORT', String(probe.port));
    const { handleImageGeneration } = await import('@process/resources/builtinMcp/imageGenServer');

    const result = await handleImageGeneration({ prompt: 'a cat' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one_media_job_status');
  });
});
