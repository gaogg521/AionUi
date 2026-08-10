/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Form C task drivers describe ONLY what differs between vendors: where to
 * submit, how to read a status response, where the result lives. The polling
 * loop, backoff, timeout, download and persistence are shared (taskPollAdapter).
 */

import type { MediaGenParams, MediaKind } from '../../types';
import type { MediaModelSpec } from '../../catalog/types';

export type TaskSubmitContext = {
  kind: MediaKind;
  prompt: string;
  params: MediaGenParams;
  /** Reference inputs already normalized to HTTP URLs or data URLs. */
  inputs: string[];
  model: string;
  /** Provider base_url exactly as configured (usually a chat endpoint). */
  baseUrl: string;
  apiKey: string;
  spec: MediaModelSpec;
  signal?: AbortSignal;
};

export type TaskPollContext = Omit<TaskSubmitContext, 'prompt' | 'params' | 'inputs'>;

/** One result item; exactly one of url/b64 is set. */
export type TaskResultItem = { url?: string; b64?: string };

export type TaskPollResult =
  | { state: 'pending' }
  | { state: 'running'; percent?: number }
  | { state: 'succeeded'; items: TaskResultItem[] }
  | { state: 'failed'; error: string };

export interface TaskDriver {
  readonly id: string;
  submit(ctx: TaskSubmitContext): Promise<{ taskId: string }>;
  poll(ctx: TaskPollContext, taskId: string): Promise<TaskPollResult>;
  /** Best-effort remote cancellation; absent when the vendor has no such endpoint. */
  cancel?(ctx: TaskPollContext, taskId: string): Promise<void>;
}

/** `1024x1024` → `1024*1024` (DashScope's spelling). */
export const toStarSize = (size?: string): string | undefined => size?.replace(/x/i, '*');

/** Strip an OpenAI-compatibility suffix to get the vendor's API root. */
export const stripCompatSuffix = (baseUrl: string): string =>
  baseUrl
    .replace(/\/+$/, '')
    .replace(/\/compatible-mode\/v1$/i, '')
    .replace(/\/v1$/i, '');

export async function readJsonOrThrow(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    // Include a short body slice: vendor task APIs put the actionable reason
    // (quota, unsupported size, content policy) there, not in the status text.
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // ignore
    }
    throw new Error(`${what} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
