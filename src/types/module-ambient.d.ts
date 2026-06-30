declare module 'convict' {
  export interface Config<T = unknown> {
    get: (key?: string) => T;
    getProperties: () => T;
    validate: (options?: { allowed?: string }) => void;
    load: (obj: Record<string, unknown>) => void;
    loadFile: (path: string) => void;
    set: (key: string, value: unknown) => void;
  }
  export default function convict<T = unknown>(schema: T): Config<T>;
}

declare module 'geoip-lite' {
  export interface Location {
    country?: string;
    region?: string;
    eu?: string;
    timezone?: string;
    city?: string;
    lat?: number;
    lng?: number;
    ll?: [number, number];
  }
  export function lookup(ip: string): Location | null;
  const geoip: {
    lookup: (ip: string) => Location | null;
  };
  export default geoip;
}

declare module 'redlock' {
  export interface Lock {
    resources: string[];
    getKey: () => string;
    getTTL: () => number;
    extend: (ttl: number) => Promise<Lock>;
    release: () => Promise<boolean>;
  }
  export interface Settings {
    driftFactor?: number;
    retryCount?: number;
    retryDelay?: number;
    retryJitter?: number;
    automaticExtensionThreshold?: number;
  }
  export default class Redlock {
    constructor(clients: unknown[], settings?: Settings);
    acquire: (resources: string[], ttl: number) => Promise<Lock>;
    on(event: "error", listener: (error: Error) => void): void;
  }
}

declare module 'json2csv' {
  export class Parser {
    constructor(options?: unknown);
    parse(data: unknown): string;
    parse<T = unknown>(data: T[]): Promise<string> | string;
  }
  export default Parser;
}