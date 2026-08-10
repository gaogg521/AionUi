/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MediaApiForm, MediaProviderAdapter } from '../types';
import { ChatMultimodalAdapter } from './chatMultimodalAdapter';
import { OpenAiImagesAdapter } from './openaiImagesAdapter';
import { TaskPollAdapter } from './taskPollAdapter';

const ADAPTERS: Partial<Record<MediaApiForm, MediaProviderAdapter>> = {
  A: new OpenAiImagesAdapter(),
  B: new ChatMultimodalAdapter(),
  C: new TaskPollAdapter(),
};

export const getMediaAdapter = (form: MediaApiForm): MediaProviderAdapter | undefined => ADAPTERS[form];

export { ChatMultimodalAdapter } from './chatMultimodalAdapter';
export { OpenAiImagesAdapter } from './openaiImagesAdapter';
export { TaskPollAdapter } from './taskPollAdapter';
