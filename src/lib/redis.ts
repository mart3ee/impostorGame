import { Redis } from "@upstash/redis";

type RedisLike = {
  get<T>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    options?: {
      ex?: number;
    },
  ): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
};

let redisClient: RedisLike;

const hasRedisEnv =
  typeof process !== "undefined" &&
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

const isProduction =
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "production";

if (hasRedisEnv) {
  redisClient = Redis.fromEnv() as unknown as RedisLike;
} else if (!isProduction) {
  const globalForRedisMemory = globalThis as unknown as {
    __impostorMemoryStore?: Map<
      string,
      {
        value: string;
        expiresAt?: number;
      }
    >;
  };

  const memory =
    globalForRedisMemory.__impostorMemoryStore ??
    new Map<
      string,
      {
        value: string;
        expiresAt?: number;
      }
    >();

  globalForRedisMemory.__impostorMemoryStore = memory;

  redisClient = {
    async get<T>(key: string): Promise<T | null> {
      const entry = memory.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        memory.delete(key);
        return null;
      }
      return entry.value as unknown as T;
    },
    async set(
      key: string,
      value: unknown,
      options?: {
        ex?: number;
      },
    ): Promise<unknown> {
      const stringValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const expiresAt =
        options?.ex != null ? Date.now() + options.ex * 1000 : undefined;
      memory.set(key, { value: stringValue, expiresAt });
      return 1;
    },
    async exists(key: string): Promise<number> {
      const entry = memory.get(key);
      if (!entry) {
        return 0;
      }
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        memory.delete(key);
        return 0;
      }
      return 1;
    },
    async del(key: string): Promise<unknown> {
      memory.delete(key);
      return 1;
    },
  };
} else {
  throw new Error(
    "Redis não está configurado. Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.",
  );
}

export const redis = redisClient;


