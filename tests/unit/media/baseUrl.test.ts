/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ensureVersionedBaseUrl } from '@/common/media/adapters/baseUrl';

describe('ensureVersionedBaseUrl', () => {
  // Reproduced against a real LiteLLM gateway: a provider configured without
  // /v1 works for chat but the media paths 405 at the proxy, with an error
  // that says nothing about the cause.
  it('appends /v1 when the base url has no version segment', () => {
    expect(ensureVersionedBaseUrl('https://litellm-internal.example.com/')).toBe(
      'https://litellm-internal.example.com/v1'
    );
    expect(ensureVersionedBaseUrl('https://gw.example.com')).toBe('https://gw.example.com/v1');
  });

  it('leaves an existing version segment alone', () => {
    expect(ensureVersionedBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(ensureVersionedBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(ensureVersionedBaseUrl('https://x.example.com/v1beta')).toBe('https://x.example.com/v1beta');
  });

  // The Ark task driver appends its path to this root. Ark's native root already
  // carries /api/v3, so normalization must not double-version it.
  it('leaves a vendor-native versioned root alone', () => {
    expect(ensureVersionedBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3'
    );
    expect(ensureVersionedBaseUrl('https://ark.cn-beijing.volces.com/api/v3/')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3'
    );
  });

  it('leaves Azure deployment urls alone', () => {
    const azure = 'https://acct.openai.azure.com/openai/deployments/my-dep';
    expect(ensureVersionedBaseUrl(azure)).toBe(azure);
  });

  it('tolerates an empty base url', () => {
    expect(ensureVersionedBaseUrl('')).toBe('');
  });
});
