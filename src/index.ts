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
export type { paths as TradingPaths, components as TradingComponents } from './types/trading-api';

// Market Data API types
export type { paths as MarketDataPaths, components as MarketDataComponents } from './types/market-data-api';

// Broker API types
export type { paths as BrokerPaths, components as BrokerComponents } from './types/broker-api';

// AuthX API types
export type { paths as AuthXPaths, components as AuthXComponents } from './types/authx';

// Re-export trading API types as default for backward compatibility
export type { paths, components } from './types/trading-api';

/**
 * Base configuration for Alpaca API client
 */
export interface AlpacaConfig {
  /** API key for authentication */
  apiKey: string;
  /** API secret for authentication */
  apiSecret: string;
  /** Paper trading or live environment */
  paper?: boolean;
  /** Custom base URL (optional) */
  baseUrl?: string;
}

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
 * Gets the appropriate base URL for API requests
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
 * Simple Alpaca API client
 */
export class AlpacaClient {
  private config: AlpacaConfig;
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: AlpacaConfig) {
    this.config = config;
    this.baseUrl = getBaseUrl(config);
    this.headers = createAuthHeaders(config);
  }

  /**
   * Make a GET request to the Alpaca API
   */
  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a POST request to the Alpaca API
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a DELETE request to the Alpaca API
   */
  async delete<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a PATCH request to the Alpaca API
   */
  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }
}
