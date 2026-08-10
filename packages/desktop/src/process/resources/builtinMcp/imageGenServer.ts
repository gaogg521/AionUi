/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for media generation (images and video).
 *
 * This is a thin shell: it owns the tool surface and nothing else. Every call
 * is forwarded over TCP to the main-process media job service, which owns
 * provider credentials, the catalog dispatch, and the job lifecycle.
 *
 * Why the work does not happen here: a video task runs for minutes, while this
 * subprocess only lives as long as the MCP client keeps it. Running generation
 * in the main process lets a job outlive the tool call that started it — the
 * asset still lands in the workspace, and the agent can collect it later by id
 * via `one_media_job_status`.
 *
 * The script filename and server name are deliberately unchanged so already
 * installed configurations keep being recognized as the built-in server.
 *
 * TCP protocol: 4-byte big-endian length header + UTF-8 JSON body. The main
 * process may send several `progress` frames before the final `result` frame.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as net from 'node:net';
import { BUILTIN_IMAGE_GEN_NAME } from './constants';

const PORT = parseInt(process.env.MEDIA_MCP_PORT || '0', 10);

type AssetView = { filePath: string; relativePath: string; mimeType: string; kind: string };

type JobView = {
  jobId: string;
  kind: string;
  status: string;
  model?: string;
  progress?: { stage?: string; percent?: number; taskId?: string; message?: string };
  assets?: AssetView[];
  error?: string;
};

type ResultFrame = {
  type: 'result';
  success: boolean;
  job?: JobView;
  jobs?: JobView[];
  error?: string;
};

/**
 * Send one request and resolve with the final `result` frame, ignoring any
 * `progress` frames that arrive first. No socket timeout: the main process owns
 * the real deadline, and a video job legitimately runs for minutes.
 *
 * Exported so tests can point it at a real in-process TCP server rather than
 * mocking the framing protocol by hand.
 */
export function sendTcpRequest(request: unknown, port: number = PORT): Promise<ResultFrame> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const body = Buffer.from(JSON.stringify(request), 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      socket.write(Buffer.concat([header, body]));
    });
    socket.setTimeout(0);

    let buffer = Buffer.alloc(0);
    let settled = false;

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const bodyLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + bodyLen) break;
        const jsonStr = buffer.subarray(4, 4 + bodyLen).toString('utf-8');
        buffer = buffer.subarray(4 + bodyLen);
        let frame: { type?: string };
        try {
          frame = JSON.parse(jsonStr);
        } catch {
          continue;
        }
        if (frame.type === 'result') {
          settled = true;
          resolve(frame as ResultFrame);
          socket.end();
          return;
        }
        // progress frames: keep the connection warm, nothing to report back
        // through the MCP tool result (which can only be returned once).
      }
    });

    socket.on('end', () => {
      if (!settled) reject(new Error('media service closed the connection before returning a result'));
    });
    socket.on('error', (err: Error) => {
      if (!settled) reject(new Error(`cannot reach the media generation service: ${err.message}`));
    });
  });
}

export function requirePort(): string | null {
  if (PORT) return null;
  // Deliberately no fallback to the old in-process path: silently degrading to
  // a different execution path is how "works on my machine" bugs are born.
  return 'Error: the media generation service is not available (MEDIA_MCP_PORT is unset). Restart the app; if it persists, re-enable the image generation tool in Settings > Tools.';
}

/**
 * The text an agent actually receives. Exported for tests: this string is the
 * whole agent-facing contract, and the bug it now covers was invisible from
 * every other layer — the job carried the information, this function dropped it.
 */
export function renderJob(job: JobView | undefined, fallback: string): string {
  if (!job) return fallback;
  const lines: string[] = [];
  if (job.assets?.length) {
    for (const asset of job.assets) {
      lines.push(`Generated ${asset.kind} saved to: ${asset.filePath}`);
    }
  }
  lines.push(`(job ${job.jobId}, status ${job.status})`);
  if (job.error) lines.push(`Error: ${job.error}`);
  return lines.join('\n');
}

/**
 * Drives one generate/status call end to end. Extracted from `server.tool()`
 * so tests can exercise the whole request/response mapping — including the
 * "service unavailable" and "connection failed" branches — without spinning
 * up a real MCP stdio transport.
 */
export async function runGeneration(kind: 'image' | 'video', payload: Record<string, unknown>) {
  const portError = requirePort();
  if (portError) {
    return { content: [{ type: 'text' as const, text: portError }], isError: true };
  }

  try {
    // Trusted workspace root: the MCP server inherits the agent process cwd,
    // which the backend sets to the conversation workspace. Never accept a
    // workspace path from the model (path traversal boundary) — there is no
    // `workspace_dir` tool parameter for this reason.
    const result = await sendTcpRequest({ op: 'generate', kind, workspaceDir: process.cwd(), ...payload });
    if (!result.success) {
      const detail = result.error || result.job?.error || 'generation failed';
      const jobRef = result.job ? ` (job ${result.job.jobId})` : '';
      return {
        content: [{ type: 'text' as const, text: `Error generating ${kind}: ${detail}${jobRef}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: renderJob(result.job, `${kind} generated.`) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error generating ${kind}: ${message}\n\nIf a job id was already issued, the work may still be running — check with one_media_job_status.`,
        },
      ],
      isError: true,
    };
  }
}

export type ImageGenerationToolArgs = {
  prompt: string;
  image_uris?: string[];
  size?: string;
  aspect_ratio?: string;
  n?: number;
  quality?: string;
  seed?: number;
  negative_prompt?: string;
};

export async function handleImageGeneration({
  prompt,
  image_uris,
  size,
  aspect_ratio,
  n,
  quality,
  seed,
  negative_prompt,
}: ImageGenerationToolArgs) {
  return runGeneration('image', {
    prompt,
    inputUris: image_uris ?? [],
    params: {
      size,
      aspectRatio: aspect_ratio,
      n,
      quality,
      seed,
      negativePrompt: negative_prompt,
    },
  });
}

export type VideoGenerationToolArgs = {
  prompt: string;
  first_frame_image?: string;
  last_frame_image?: string;
  duration_seconds?: number;
  resolution?: string;
  aspect_ratio?: string;
  camera?: string;
  seed?: number;
};

export async function handleVideoGeneration({
  prompt,
  first_frame_image,
  last_frame_image,
  duration_seconds,
  resolution,
  aspect_ratio,
  camera,
  seed,
}: VideoGenerationToolArgs) {
  return runGeneration('video', {
    prompt,
    inputUris: first_frame_image ? [first_frame_image] : [],
    params: {
      firstFrameImage: first_frame_image,
      lastFrameImage: last_frame_image,
      durationSeconds: duration_seconds,
      resolution,
      aspectRatio: aspect_ratio,
      camera,
      seed,
    },
  });
}

export async function handleMediaJobStatus({ job_id }: { job_id?: string }) {
  const portError = requirePort();
  if (portError) {
    return { content: [{ type: 'text' as const, text: portError }], isError: true };
  }
  try {
    const result = await sendTcpRequest({ op: 'status', jobId: job_id });
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error || 'lookup failed'}` }],
        isError: true,
      };
    }
    if (result.job) {
      return { content: [{ type: 'text' as const, text: renderJob(result.job, 'no job data') }] };
    }
    const jobs = result.jobs ?? [];
    if (jobs.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No media generation jobs yet.' }] };
    }
    const text = jobs
      .map((job) => `- ${job.jobId} [${job.kind}] ${job.status}${job.error ? ` — ${job.error}` : ''}`)
      .join('\n');
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function main() {
  const server = new McpServer({
    name: BUILTIN_IMAGE_GEN_NAME,
    version: '2.0.0',
  });

  server.tool(
    'aionui_image_generation',
    `REQUIRED tool for generating or editing images. You MUST use this tool for ANY image generation request.

CRITICAL: You (the AI assistant) CANNOT generate images directly. You MUST call this tool for:
- Creating/generating any new images from text descriptions
- Drawing, painting, or making any visual content
- Editing or modifying existing images

Primary Functions:
- Generate new images from English text descriptions
- Edit/modify existing images with English text prompts

IMPORTANT: All prompts must be in English for optimal results.

When to Use (MANDATORY):
- User asks to "generate", "create", "draw", "make", "paint" an image
- User asks for any visual content creation
- User asks to edit or modify an image
- User mentions @filename with image extensions (.jpg, .jpeg, .png, .gif, .webp, .bmp, .tiff, .svg)

Input Support:
- Multiple local file paths in array format: ["img1.jpg", "img2.png"]
- Multiple HTTP/HTTPS image URLs in array format
- Text prompts for generation or analysis
- Optional generation parameters (size, count, quality, seed, negative prompt) — support depends on the configured model; unsupported parameters are ignored (never retry just to change them)

Output:
- Saves generated/processed images to workspace with timestamp naming (all images when the model returns several)
- Returns image path(s) and a job id

IMPORTANT: When user provides multiple images, ALWAYS pass ALL images to the image_uris parameter as an array.`,
    {
      prompt: z
        .string()
        .describe(
          'The text prompt in English that must clearly specify the operation type: "Generate image: [description]" for creating new images, "Analyze image: [what to analyze]" for image recognition/analysis, or "Edit image: [modifications]" for image editing.'
        ),
      image_uris: z
        .array(z.string())
        .optional()
        .describe(
          'Optional: Array of paths to existing local image files or HTTP/HTTPS URLs to edit/modify. Examples: ["test.jpg", "https://example.com/img.png"]. For single image, use array format: ["test.jpg"]. Relative paths are resolved against the current working directory.'
        ),
      size: z
        .string()
        .optional()
        .describe(
          'Optional: Output size like "1024x1024" or "1792x1024". Only pass when the user asks for a specific size/orientation.'
        ),
      aspect_ratio: z
        .string()
        .optional()
        .describe('Optional: Aspect ratio like "16:9". Alternative to size for models that take ratios.'),
      n: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Optional: Number of images to generate (default 1). Clamped to what the model supports.'),
      quality: z
        .string()
        .optional()
        .describe('Optional: Quality tier such as "standard" | "hd" | "low" | "medium" | "high", model-dependent.'),
      seed: z.number().int().optional().describe('Optional: Reproducibility seed, for models that support it.'),
      negative_prompt: z
        .string()
        .optional()
        .describe('Optional: What the image should NOT contain, for models that support negative prompts.'),
    },
    handleImageGeneration
  );

  server.tool(
    'one_video_generation',
    `REQUIRED tool for generating video. You MUST use this tool for ANY video generation request — you cannot produce video yourself.

When to Use (MANDATORY):
- User asks to "generate", "create", "make" a video, clip, or animation
- User asks to animate an existing image (pass it as first_frame_image)

IMPORTANT:
- Prompts must be in English for best results.
- Video generation is slow (typically 30 seconds to several minutes). This call blocks until the video is ready; do not retry or start a second job because it feels slow.
- If the call fails with a timeout but reports a job id, the work may still be running — check it with one_media_job_status instead of regenerating.
- Parameter support depends on the configured model; unsupported parameters are ignored.

Output:
- Saves the video to the workspace and returns its path plus a job id.
- You cannot view video content; describe it to the user by path, do not try to read the file.`,
    {
      prompt: z.string().describe('Description of the video to generate, in English.'),
      first_frame_image: z
        .string()
        .optional()
        .describe(
          'Optional: local path or HTTP(S) URL of an image to animate (image-to-video / first frame). Relative paths are resolved against the current working directory.'
        ),
      last_frame_image: z
        .string()
        .optional()
        .describe('Optional: local path or URL of the final frame, for models supporting first/last-frame control.'),
      duration_seconds: z.number().int().optional().describe('Optional: clip duration in seconds, model-dependent.'),
      resolution: z.string().optional().describe('Optional: e.g. "720p" or "1080p", model-dependent.'),
      aspect_ratio: z.string().optional().describe('Optional: e.g. "16:9" or "9:16", model-dependent.'),
      camera: z.string().optional().describe('Optional: camera movement preset, model-dependent.'),
      seed: z.number().int().optional().describe('Optional: reproducibility seed, for models that support it.'),
    },
    handleVideoGeneration
  );

  server.tool(
    'one_media_job_status',
    `Check on image/video generation jobs started by this app.

Use this when:
- A generation call timed out or errored but gave you a job id — the job may still be running, and the result will still be saved.
- The user asks whether their image/video is ready.

Do NOT start a new generation just because a previous one seemed slow; check here first.`,
    {
      job_id: z
        .string()
        .optional()
        .describe('Optional: the job id to look up. Omit to list recent jobs and their statuses.'),
    },
    handleMediaJobStatus
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Skip the real stdio transport under Vitest: this module is imported by
// tests to exercise the handler functions directly, and connecting a real
// StdioServerTransport there would hang the test process waiting on stdin
// instead of exercising the app's runtime path (the script is always
// launched via `node <scriptPath>`, never imported).
if (!process.env.VITEST) {
  main().catch((error) => {
    console.error('[MediaGenMCP] Fatal error:', error);
    process.exit(1);
  });
}
