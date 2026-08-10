/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Base URL normalization shared by every adapter that appends a media path to a
 * provider's chat `base_url`.
 *
 * Renderer-safe (no Node.js imports).
 */

/**
 * Ensure the base URL carries an API version segment.
 *
 * Chat and media paths are not equally forgiving about this. Gateways commonly
 * route `/chat/completions` with or without the version prefix, so a provider
 * whose `base_url` omits `/v1` works fine for chat and the user has no reason to
 * suspect anything — but the media path then resolves to `/images/generations`
 * (or `/contents/generations/tasks`) and the gateway's front-end proxy rejects
 * it with a bare 405 that says nothing about the cause. (Reproduced against a
 * real LiteLLM deployment: `/images/generations` → 405 from nginx,
 * `/v1/images/generations` → served.)
 *
 * Anything that already ends in a version segment is left untouched — which is
 * what keeps this a no-op for vendor-native roots such as Ark's
 * `.../api/v3` or OpenAI's `/v1` — as are Azure-style deployment URLs, which
 * have their own path shape.
 */
export function ensureVersionedBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (/\/v\d+(beta)?$/i.test(trimmed)) return trimmed;
  if (/\/openai\/deployments\//i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
