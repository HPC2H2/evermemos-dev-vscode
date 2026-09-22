import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { API_PATHS, createClient, EvermemConfig, getPreferredApiVersion, orderPaths, requestWithRetry, throwIfCancelled } from './config';
import { t } from './i18n';

export type Memory = Record<string, unknown>;
export interface MemoryPage {
  memories: Memory[];
  pending: Memory[];
  total: number;
  hasMore: boolean;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function unwrap(data: unknown, allowFailedStatus = false): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(t('invalidResponse'));
  }
  let result = record(data);
  // Both {result: ...} and {success: true, data: {result: ...}} are supported.
  for (let depth = 0; depth < 4; depth++) {
    if (result.success === false || result.status === 'error' || (!allowFailedStatus && result.status === 'failed')) {
      throw new Error(t('serverRejected'));
    }
    const nested = result.result ?? result.data;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      return result;
    }
    result = record(nested);
  }
  return result;
}

export function normalizeMemories(data: unknown): MemoryPage {
  const result = unwrap(data);
  if (result.memories !== undefined && !Array.isArray(result.memories)) {
    throw new Error(t('invalidResponse'));
  }
  const memories: Memory[] = [];
  for (const entry of (result.memories || []) as unknown[]) {
    const group = record(entry);
    const entries = Array.isArray(entry) ? entry : Array.isArray(group.episodic_memory) ? group.episodic_memory : [entry];
    for (const memory of entries) {
      if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
        memories.push(record(memory));
      }
    }
  }
  return {
    memories,
    pending: Array.isArray(result.pending_messages) ? result.pending_messages.map(record) : [],
    total: typeof result.total_count === 'number' ? result.total_count : memories.length,
    hasMore: result.has_more === true,
  };
}

export function memoryScope(): Record<string, string | string[] | undefined> {
  const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;
  return { user_id: vscode.env.machineId || 'vscode-user', group_id: groupId, group_ids: groupId ? [groupId] : undefined };
}

interface Route { method: 'GET' | 'POST' | 'DELETE'; path: string; queryBody?: boolean }
const routes = new Map<string, string>();
export function clearApiRouteCache(): void { routes.clear(); }
const routeId = (route: Route) => `${route.method} ${route.path} ${!!route.queryBody}`;
const unavailable = (error: unknown) => axios.isAxiosError(error) && [404, 405].includes(error.response?.status || 0);

export class MemoryApi {
  private readonly client: AxiosInstance;
  private readonly preferred: 'v0' | 'v1';
  constructor(private readonly config: EvermemConfig) {
    this.client = createClient(config);
    this.preferred = getPreferredApiVersion(config.apiBaseUrl);
  }

  private async request(operation: string, candidates: Route[], payload: Record<string, unknown>, signal?: AbortSignal, readOnly = true): Promise<unknown> {
    const cacheKey = `${this.client.defaults.baseURL}|${this.preferred}|${operation}`;
    const cached = routes.get(cacheKey);
    const ordered = [...candidates].sort((a, b) => Number(routeId(b) === cached) - Number(routeId(a) === cached));
    let lastError: unknown;
    for (const route of ordered) {
      throwIfCancelled(signal);
      try {
        const response = await requestWithRetry(() => this.client.request({
          method: route.method, url: route.path, signal,
          ...(route.method === 'GET' || route.queryBody ? { params: payload } : { data: payload }),
        }), readOnly ? 2 : 0, 1000, signal);
        unwrap(response.data, operation === 'status');
        if (routes.size >= 32 && !routes.has(cacheKey)) { routes.clear(); }
        routes.set(cacheKey, routeId(route));
        return response.data;
      } catch (error) {
        if (!unavailable(error)) {
          throw error;
        }
        if (routeId(route) === cached) { routes.delete(cacheKey); }
        lastError = error;
      }
    }
    throw lastError || new Error(t('endpointMissing'));
  }

  async add(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    // A timed-out write may already have succeeded. Never automatically replay it.
    return this.request('add', orderPaths(API_PATHS.MEMORIES, this.preferred).map(path => ({ method: 'POST', path })), payload, signal, false);
  }

  async list(page = 1, pageSize = 100, signal?: AbortSignal): Promise<MemoryPage> {
    const data = await this.request('list', orderPaths(API_PATHS.MEMORIES, this.preferred).map(path => ({ method: 'GET', path })), {
      ...memoryScope(), memory_type: 'episodic_memory', include_metadata: true, page, page_size: pageSize,
    }, signal);
    return normalizeMemories(data);
  }

  async search(query: string, signal?: AbortSignal): Promise<MemoryPage> {
    if (!query.trim()) { return this.list(1, 100, signal); }
    const candidates: Route[] = orderPaths(API_PATHS.MEMORIES_SEARCH, this.preferred).flatMap(path => [
      { method: 'GET' as const, path }, { method: 'POST' as const, path },
    ]);
    try {
      return normalizeMemories(await this.request('search', candidates, {
        ...memoryScope(), query: query.trim(), include_metadata: true, top_k: 100,
      }, signal));
    } catch (error) {
      if (unavailable(error)) { throw new Error(t('searchUnavailable')); }
      throw error;
    }
  }

  async delete(memoryId: string): Promise<void> {
    const paths = orderPaths(API_PATHS.MEMORIES, this.preferred);
    const candidates: Route[] = paths.map(path => ({ method: 'DELETE', path }));
    candidates.push(...paths.map(path => ({ method: 'DELETE' as const, path, queryBody: true })));
    const scope = memoryScope();
    await this.request('delete', candidates, { event_id: memoryId, user_id: scope.user_id, group_id: scope.group_id }, undefined, false);
  }

  async status(requestId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return unwrap(await this.request('status', orderPaths(API_PATHS.REQUEST_STATUS, this.preferred).map(path => ({ method: 'GET', path })), { request_id: requestId }, signal), true);
  }
}
