/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SettingsTabNavigateProvider } from '@/renderer/components/settings/SettingsModal/settingsViewContext';

const hooks = vi.hoisted(() => ({
  modelListWithImage: [] as unknown[],
  mcpServers: [] as unknown[],
  getClientBusinessSetting: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/base/AionSelect', () => {
  const Select = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { default: Object.assign(Select, { OptGroup: Select, Option: Select }) };
});

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: () => <div>TalkToButlerButton</div>,
}));

vi.mock('@/renderer/pages/settings/components/AddMcpServerModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/ToolsSettings/McpServerItem', () => ({
  default: () => null,
}));

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({
  default: () => ({ modelListWithImage: hooks.modelListWithImage }),
}));

vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({
    mcpServers: hooks.mcpServers,
    extensionMcpServers: [],
    saveMcpServers: vi.fn(() => Promise.resolve()),
    setMcpServers: vi.fn(),
    isMcpServersLoading: false,
  }),
  useMcpConnection: () => ({ testingServers: {}, handleTestMcpConnection: vi.fn(), handleTestMcpConnections: vi.fn() }),
  useMcpModal: () => ({
    showMcpModal: false,
    editingMcpServer: undefined,
    deleteConfirmVisible: false,
    serverToDelete: undefined,
    mcpCollapseKey: [],
    showAddMcpModal: vi.fn(),
    showEditMcpModal: vi.fn(),
    hideMcpModal: vi.fn(),
    showDeleteConfirm: vi.fn(),
    hideDeleteConfirm: vi.fn(),
    toggleServerCollapse: vi.fn(),
  }),
  useMcpServerCRUD: () => ({
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: vi.fn(),
    handleEditMcpServer: vi.fn(),
    handleDeleteMcpServer: vi.fn(),
  }),
  useMcpOAuth: () => ({
    oauthStatus: {},
    loggingIn: {},
    checkOAuthStatus: vi.fn(),
    markLoginRequired: vi.fn(),
    clearLoginRequired: vi.fn(),
    login: vi.fn(),
  }),
  useMountedMessage: (m: unknown) => m,
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: hooks.getClientBusinessSetting,
  setClientBusinessSetting: vi.fn(() => Promise.resolve()),
  removeClientBusinessSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {},
}));

import ToolsModalContent from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';

describe('ToolsModalContent video model settings', () => {
  beforeEach(() => {
    hooks.modelListWithImage = [];
    hooks.mcpServers = [];
    hooks.getClientBusinessSetting.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the video generation section heading', async () => {
    render(<ToolsModalContent />);

    await waitFor(() => expect(screen.getByText('settings.videoGeneration')).toBeInTheDocument());
    expect(screen.getByText('settings.videoGenerationModel')).toBeInTheDocument();
  });

  it('lists only catalog-supported video models (Ark Seedance), filtering out models without a driver yet', async () => {
    hooks.modelListWithImage = [
      {
        id: 'ark-provider',
        platform: 'openai',
        name: 'Volcano Ark',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        api_key: 'sk-ark',
        models: ['seedance-1-0-pro', 'kling-v1'],
      },
      {
        id: 'gateway-provider',
        platform: 'openai',
        name: 'Gateway',
        base_url: 'https://gateway.example.com/v1',
        api_key: 'sk-gateway',
        models: ['sora-2'],
      },
    ];

    render(<ToolsModalContent />);

    // Supported: resolves to an implemented Form C driver (ark-task).
    await waitFor(() => expect(screen.getByText('seedance-1-0-pro')).toBeInTheDocument());

    // Not yet supported: catalog entries exist but no driver ships yet (kling / sora).
    expect(screen.queryByText('kling-v1')).not.toBeInTheDocument();
    expect(screen.queryByText('sora-2')).not.toBeInTheDocument();
  });

  it('keeps the video model list independent from the image model list', async () => {
    // A provider whose only model is video-capable (Seedance has no image
    // counterpart in the catalog) must not show up in the image generation
    // card's option list, and the image card falls back to its own guide.
    hooks.modelListWithImage = [
      {
        id: 'ark-provider',
        platform: 'openai',
        name: 'Volcano Ark',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        api_key: 'sk-ark',
        models: ['seedance-1-0-pro'],
      },
    ];
    const navigateToTab = vi.fn();

    render(
      <SettingsTabNavigateProvider value={navigateToTab}>
        <ToolsModalContent />
      </SettingsTabNavigateProvider>
    );

    await waitFor(() => expect(screen.getByText('seedance-1-0-pro')).toBeInTheDocument());

    // No image-capable model in the fixture, so the image card still falls
    // back to its empty-state guide (rendered as a link since a navigator was provided).
    const links = screen.getAllByText('settings.goToModelSettings');
    expect(links.length).toBeGreaterThanOrEqual(1);
  });
});
