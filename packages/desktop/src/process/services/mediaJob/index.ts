/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process media generation service: owns the job engine and the TCP
 * endpoint the built-in MCP shell talks to.
 *
 * Protocol mirrors the other built-in MCP bridges (teamKnowledge / exportPdf):
 * 4-byte big-endian length header + UTF-8 JSON body. Unlike those, a media
 * connection stays open for the life of the request and may carry several
 * progress frames before the final result — video generation runs for minutes
 * and a silent socket looks indistinguishable from a hang.
 *
 * Credentials never travel to the subprocess: the shell only knows a port, and
 * this service resolves the provider (and its api_key) from the backend at
 * execution time.
 */

import net from 'net';
import path from 'path';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { ImageGenerationModelSetting } from '@/common/config/clientSettings';
import {
  resolveImageGenerationMcpEnv,
  type ImageGenerationMcpEnvResolveResult,
} from '@/common/config/imageGenerationMcpEnv';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { executeMediaGeneration } from '@/common/media';
import { resolveMediaModelSpec } from '@/common/media/catalog';
import type { MediaKind } from '@/common/media/types';
import { getConfigPath } from '@process/utils/utils';
import { MediaJobManager } from './jobManager';
import { MediaJobStore } from './store';
import type { MediaJobSnapshot } from './types';

const START_PORT = 19860;
const MAX_PORT_ATTEMPTS = 10;

/** Client-settings key per media kind. */
const SETTING_KEY: Record<MediaKind, string> = {
  image: 'tools.imageGenerationModel',
  video: 'tools.videoGenerationModel',
};

type GenerateRequest = {
  op?: 'generate';
  kind?: MediaKind;
  prompt?: string;
  params?: Record<string, unknown>;
  inputUris?: string[];
  workspaceDir?: string;
};

type StatusRequest = {
  op: 'status';
  jobId?: string;
};

type CancelRequest = {
  op: 'cancel';
  jobId: string;
};

type IncomingRequest = GenerateRequest | StatusRequest | CancelRequest;

let server: net.Server | null = null;
let currentPort = 0;
let manager: MediaJobManager | null = null;

// ===== provider resolution =====

async function fetchProviders(): Promise<IProvider[]> {
  try {
    const providers = await httpRequest('GET', '/api/providers');
    return Array.isArray(providers) ? (providers as IProvider[]) : [];
  } catch {
    return [];
  }
}

async function fetchSelection(kind: MediaKind): Promise<ImageGenerationModelSetting | undefined> {
  try {
    const settings = (await httpRequest('GET', '/api/settings/client')) as
      | Record<string, ImageGenerationModelSetting | undefined>
      | undefined;
    return settings?.[SETTING_KEY[kind]];
  } catch {
    return undefined;
  }
}

/**
 * Resolve the provider (with credentials) for a job. Re-resolved on every run
 * so a rotated key or a re-pointed provider is picked up by recovered jobs.
 */
async function resolveProvider(providerId: string, model: string): Promise<TProviderWithModel | null> {
  const providers = await fetchProviders();
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return null;
  const { models: _models, ...rest } = provider;
  return { ...rest, use_model: model };
}

/**
 * Resolve the currently selected provider+model for a kind.
 *
 * Returns one shape with optional fields rather than a discriminated union:
 * this project compiles without `strictNullChecks`, where narrowing a union by
 * a negated boolean discriminant does not work.
 */
type SelectedProvider = { provider?: TProviderWithModel; error?: string };

// `=== true` rather than truthiness: without `strictNullChecks` TypeScript only
// narrows a discriminated union on an explicit literal comparison. Same idiom as
// `logImageGenerationEnvResolution` in runBackendMigrations.
function describeResolutionFailure(result: ImageGenerationMcpEnvResolveResult): string {
  if (result.ok === true) return '';
  return result.message;
}

async function resolveSelectedProvider(kind: MediaKind): Promise<SelectedProvider> {
  const [selection, providers] = await Promise.all([fetchSelection(kind), fetchProviders()]);
  if (!selection) {
    return { error: `No ${kind} generation model is configured. Select one in Settings > Tools.` };
  }
  const resolution = resolveImageGenerationMcpEnv(selection, providers);
  if (resolution.ok) {
    const { models: _models, ...rest } = resolution.provider;
    return { provider: { ...rest, use_model: resolution.model } };
  }
  return { error: `${kind} generation model is not usable: ${describeResolutionFailure(resolution)}` };
}

// ===== engine =====

function getManager(): MediaJobManager {
  if (manager) return manager;
  const store = new MediaJobStore(path.join(getConfigPath(), 'media-jobs.json'));
  manager = new MediaJobManager({
    resolveProvider,
    loadJobs: () => store.load(),
    saveJobs: (jobs) => store.save(jobs),
    execute: async ({ job, provider, signal, onProgress, onTaskSubmitted, resumeTaskId }) =>
      executeMediaGeneration({
        kind: job.kind,
        prompt: job.prompt,
        params: job.params,
        inputUris: job.inputUris,
        provider,
        workspaceDir: job.workspaceDir,
        signal,
        onProgress,
        onTaskSubmitted,
        resumeTaskId,
      }),
  });
  return manager;
}

/** Public accessor so other main-process code (IPC bridge) can observe jobs. */
export function getMediaJobManager(): MediaJobManager {
  return getManager();
}

// ===== TCP framing =====

function writeTcpMessage(socket: net.Socket, data: unknown): void {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

function createTcpMessageReader(onMessage: (msg: unknown) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const bodyLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + bodyLen) break;
      const jsonStr = buffer.subarray(4, 4 + bodyLen).toString('utf-8');
      buffer = buffer.subarray(4 + bodyLen);
      try {
        onMessage(JSON.parse(jsonStr));
      } catch {
        // Malformed JSON — skip
      }
    }
  };
}

function publicJobView(job: MediaJobSnapshot) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    progress: job.progress,
    // Paths only — media bytes never cross this socket (architecture doc D6).
    assets: job.assets?.map((asset) => ({
      filePath: asset.filePath,
      relativePath: asset.relativePath,
      mimeType: asset.mimeType,
      kind: asset.kind,
    })),
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// ===== request handling =====

async function handleGenerate(socket: net.Socket, req: GenerateRequest): Promise<void> {
  const kind: MediaKind = req.kind === 'video' ? 'video' : 'image';
  const prompt = (req.prompt ?? '').trim();
  if (!prompt) {
    writeTcpMessage(socket, { type: 'result', success: false, error: 'prompt is required' });
    return;
  }

  const resolved = await resolveSelectedProvider(kind);
  const provider = resolved.provider;
  if (!provider) {
    writeTcpMessage(socket, { type: 'result', success: false, error: resolved.error });
    return;
  }

  const engine = getManager();
  const spec = resolveMediaModelSpec(kind, provider, provider.use_model);

  const job = engine.create({
    kind,
    prompt,
    params: (req.params ?? {}) as never,
    inputUris: req.inputUris ?? [],
    providerId: provider.id,
    model: provider.use_model,
    specId: spec?.id,
    workspaceDir: req.workspaceDir || process.cwd(),
  });

  // Stream progress while the job runs so a long video generation does not look
  // like a dead socket to the MCP client.
  const unsubscribe = engine.onJobUpdate((updated) => {
    if (updated.id !== job.id) return;
    writeTcpMessage(socket, { type: 'progress', job: publicJobView(updated) });
  });

  try {
    const finished = await engine.waitForCompletion(job.id);
    writeTcpMessage(socket, {
      type: 'result',
      success: finished.status === 'done',
      job: publicJobView(finished),
    });
  } finally {
    unsubscribe();
  }
}

function handleStatus(socket: net.Socket, req: StatusRequest): void {
  const engine = getManager();
  if (req.jobId) {
    const job = engine.getJob(req.jobId);
    writeTcpMessage(
      socket,
      job
        ? { type: 'result', success: true, job: publicJobView(job) }
        : { type: 'result', success: false, error: `Unknown job: ${req.jobId}` }
    );
    return;
  }
  writeTcpMessage(socket, {
    type: 'result',
    success: true,
    jobs: engine.listJobs().slice(0, 20).map(publicJobView),
  });
}

function handleCancel(socket: net.Socket, req: CancelRequest): void {
  const cancelled = getManager().cancel(req.jobId);
  writeTcpMessage(socket, {
    type: 'result',
    success: cancelled,
    ...(cancelled ? {} : { error: `Job ${req.jobId} is not running` }),
  });
}

function handleConnection(socket: net.Socket): void {
  const reader = createTcpMessageReader((msg) => {
    const req = (msg ?? {}) as IncomingRequest;
    const done = () => socket.end();
    const fail = (err: unknown) => {
      writeTcpMessage(socket, {
        type: 'result',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      socket.end();
    };

    switch (req.op) {
      case 'status':
        try {
          handleStatus(socket, req);
          done();
        } catch (err) {
          fail(err);
        }
        return;
      case 'cancel':
        try {
          handleCancel(socket, req);
          done();
        } catch (err) {
          fail(err);
        }
        return;
      default:
        handleGenerate(socket, req as GenerateRequest).then(done, fail);
    }
  });

  socket.on('data', reader);
  socket.on('error', () => {
    // Client disconnect — the job keeps running on purpose.
  });
  // No socket timeout: a video job legitimately outlives any fixed window, and
  // the job engine owns the real deadline.
  socket.setTimeout(0);
}

// ===== lifecycle =====

function listenOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tryServer = net.createServer(handleConnection);
    tryServer.once('error', () => resolve(false));
    tryServer.listen(port, '127.0.0.1', () => {
      server = tryServer;
      currentPort = port;
      resolve(true);
    });
  });
}

export async function startMediaMcpServer(): Promise<number> {
  if (server) return currentPort;
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const ok = await listenOnPort(START_PORT + i);
    if (ok) {
      const port = START_PORT + i;
      console.log(`[mediaMcpServer] Listening on 127.0.0.1:${port}`);
      // Pick up anything that was in flight when the app last closed. A task
      // already submitted upstream has been paid for; dropping it would be a
      // silent loss the user cannot recover.
      getManager()
        .restore()
        .then(({ resumed, failed }) => {
          if (resumed || failed) {
            console.log(`[mediaMcpServer] restored media jobs — resumed: ${resumed}, failed: ${failed}`);
          }
        })
        .catch((error) => console.warn('[mediaMcpServer] job restore failed:', error));
      return port;
    }
  }
  throw new Error(`[mediaMcpServer] No available port in range ${START_PORT}-${START_PORT + MAX_PORT_ATTEMPTS - 1}`);
}

export function getMediaMcpPort(): number {
  return currentPort;
}

export async function stopMediaMcpServer(): Promise<void> {
  manager?.shutdown();
  if (!server) return;
  await new Promise<void>((resolve) => {
    server!.close(() => {
      server = null;
      currentPort = 0;
      resolve();
    });
  });
}
