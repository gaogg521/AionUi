/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskDriver } from './types';
import { dashscopeDriver } from './dashscopeDriver';
import { arkDriver } from './arkDriver';

const DRIVERS: TaskDriver[] = [dashscopeDriver, arkDriver];

export const getTaskDriver = (endpointStyle?: string): TaskDriver | undefined =>
  endpointStyle ? DRIVERS.find((driver) => driver.id === endpointStyle) : undefined;

/**
 * Ids of every implemented driver. Must stay in sync with
 * `catalog/resolve.ts:IMPLEMENTED_ENDPOINT_STYLES`, which is what stops the
 * settings picker offering a vendor we cannot actually call. A test asserts the
 * two lists agree, so adding a driver without updating the catalog fails CI.
 */
export const REGISTERED_DRIVER_IDS: readonly string[] = DRIVERS.map((driver) => driver.id);

export type { TaskDriver, TaskPollContext, TaskPollResult, TaskResultItem, TaskSubmitContext } from './types';
