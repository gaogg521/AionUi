/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Media job types. See docs/specs/media-generation/architecture.zh-CN.md §4.3.
 */

import type { MediaAsset, MediaGenParams, MediaKind, MediaProgressUpdate } from '@/common/media/types';

export type MediaJobStatus =
  | 'pending'
  | 'submitted'
  | 'polling'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/** Statuses that will never change again without a new job. */
export const TERMINAL_STATUSES: readonly MediaJobStatus[] = ['done', 'failed', 'cancelled', 'timeout'];

export const isTerminal = (status: MediaJobStatus): boolean => TERMINAL_STATUSES.includes(status);

/**
 * Persisted job record.
 *
 * Deliberately holds NO api_key: credentials are re-resolved from the provider
 * store at execution time, so a leaked jobs file cannot leak keys and a rotated
 * key is picked up by a recovered job.
 */
export type MediaJobRecord = {
  id: string;
  kind: MediaKind;
  status: MediaJobStatus;
  prompt: string;
  params: MediaGenParams;
  inputUris: string[];
  /** Provider the job was created against; api_key is resolved fresh each run. */
  providerId: string;
  model: string;
  /** Catalog spec id, for diagnostics and to detect catalog drift on recovery. */
  specId?: string;
  /** Remote task id (Form C). Its presence is what makes a job recoverable. */
  remoteTaskId?: string;
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  assets?: MediaAsset[];
  error?: string;
  progress?: MediaProgressUpdate;
};

export type MediaJobSnapshot = Readonly<MediaJobRecord>;

/** Everything needed to create a job, before an id or timestamps exist. */
export type MediaJobRequest = {
  kind: MediaKind;
  prompt: string;
  params: MediaGenParams;
  inputUris: string[];
  providerId: string;
  model: string;
  specId?: string;
  workspaceDir: string;
};
