/**
 * Alpaca API TypeScript Client
 *
 * This module provides TypeScript types and utilities for the Alpaca Markets API.
 * The types are automatically generated from the official OpenAPI specifications.
 *
 * @see https://docs.alpaca.markets/
 */

// Export generated types from all API schemas
// To generate types, run: bun run generate

// Trading API types
export type {
  paths as TradingPaths,
  components as TradingComponents,
  operations as TradingOperations,
} from './types/trading-api';

// Market Data API types
export type { paths as MarketDataPaths, components as MarketDataComponents } from './types/market-data-api';

// Broker API types
export type { paths as BrokerPaths, components as BrokerComponents } from './types/broker-api';

// AuthX API types
export type { paths as AuthXPaths, components as AuthXComponents } from './types/authx';

// Re-export trading API types as default for backward compatibility
export type { paths, components } from './types/trading-api';

// Runtime endpoint catalog — a queryable index of every operation across all
// four APIs, derived on demand from the live OpenAPI specs (cached on disk) and
// used to discover and invoke endpoints dynamically.
export { loadCatalog, buildCatalog, SPEC_SOURCES } from './build-catalog';
export type {
  Catalog,
  Operation,
  ApiMeta,
  AuthStrategy,
  CatalogParameter,
  CatalogRequestBody,
} from './catalog-types';

/**
 * Base configuration for Alpaca API client
 */
export type AlpacaConfig = {
  /** API key for authentication */
  apiKey: string;
  /** API secret for authentication */
  apiSecret: string;
  /** Paper trading or live environment (applies to Trading & Broker endpoints) */
  paper?: boolean;
  /** Custom Trading API base URL (optional) */
  baseUrl?: string;
  /** Custom Market Data API base URL (optional) */
  dataBaseUrl?: string;
};

/**
 * Creates authenticated headers for Alpaca API requests
 */
export function createAuthHeaders(config: AlpacaConfig): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.apiKey,
    'APCA-API-SECRET-KEY': config.apiSecret,
    'Content-Type': 'application/json',
  };
}

/**
 * Gets the Trading API base URL for the configured environment.
 */
export function getBaseUrl(config: AlpacaConfig): string {
  if (config.baseUrl) {
    return config.baseUrl;
  }
  return config.paper
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
}

/**
 * Gets the Market Data API base URL.
 *
 * Market data is served from a dedicated host that is independent of the
 * paper/live distinction, so it is resolved separately from {@link getBaseUrl}.
 */
export function getDataBaseUrl(config: AlpacaConfig): string {
  return config.dataBaseUrl ?? 'https://data.alpaca.markets';
}

/**
 * Simple Alpaca API client
 */
export class AlpacaClient {
  private config: AlpacaConfig;
  private baseUrl: string;
  private dataBaseUrl: string;
  private headers: Record<string, string>;

  constructor(config: AlpacaConfig) {
    this.config = config;
    this.baseUrl = getBaseUrl(config);
    this.dataBaseUrl = getDataBaseUrl(config);
    this.headers = createAuthHeaders(config);
  }

  /**
   * Performs an authenticated request and parses the JSON response.
   *
   * Handles empty bodies (e.g. `204 No Content` returned by order cancellation)
   * and surfaces the Alpaca error payload when a request fails.
   */
  private async request<T>(method: string, baseUrl: string, path: string, body?: object): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`
      );
    }

    // No body to parse (204 No Content, or an explicitly empty response).
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Make a GET request to the Trading API
   */
  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', this.baseUrl, path);
  }

  /**
   * Make a POST request to the Trading API
   */
  post<T>(path: string, body: object): Promise<T> {
    return this.request<T>('POST', this.baseUrl, path, body);
  }

  /**
   * Make a DELETE request to the Trading API
   */
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', this.baseUrl, path);
  }

  /**
   * Make a PATCH request to the Trading API
   */
  patch<T>(path: string, body: object): Promise<T> {
    return this.request<T>('PATCH', this.baseUrl, path, body);
  }

  /**
   * Make a GET request to the Market Data API (https://data.alpaca.markets).
   *
   * Use this for `/v2/stocks/...`, `/v2/crypto/...`, and other market-data
   * endpoints, which are served from a different host than the Trading API.
   */
  getData<T>(path: string): Promise<T> {
    return this.request<T>('GET', this.dataBaseUrl, path);
  }
}
