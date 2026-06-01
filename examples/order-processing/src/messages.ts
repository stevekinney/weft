import { query, signal, update } from '@lostgradient/weft';

import type { AddItemInput, AddItemResult, CancelOrderInput, OrderStatus } from './model';

export const addItemUpdate = update<AddItemInput, AddItemResult>('addItem');
export const cancelOrderSignal = signal<CancelOrderInput>('cancelOrder');
export const orderStatusQuery = query<void, OrderStatus>('orderStatus');
