import { describe, expect, test } from "bun:test";
import { redisOptionsFromUrl } from "./index";

describe("redisOptionsFromUrl", () => {
  test("reads host, port and credentials from a Redis Cloud URL", () => {
    const options = redisOptionsFromUrl("redis://default:p%40ss@redis-17490.example.com:17490");
    expect(options).toMatchObject({
      host: "redis-17490.example.com",
      port: 17490,
      username: "default",
      password: "p@ss",
      maxRetriesPerRequest: null,
    });
    expect(options).not.toHaveProperty("tls");
  });

  test("rediss:// turns on TLS", () => {
    expect(redisOptionsFromUrl("rediss://default:x@host.example.com:6380")).toMatchObject({ tls: {}, port: 6380 });
  });

  test("the port defaults to 6379 and a numeric path is the db", () => {
    expect(redisOptionsFromUrl("redis://localhost")).toMatchObject({ host: "localhost", port: 6379 });
    expect(redisOptionsFromUrl("redis://localhost/2")).toMatchObject({ db: 2 });
  });

  test("a missing or wrong URL fails with a clear message", () => {
    expect(() => redisOptionsFromUrl(undefined)).toThrow("REDIS_URL is not set");
    expect(() => redisOptionsFromUrl("  ")).toThrow("REDIS_URL is not set");
    expect(() => redisOptionsFromUrl("not a url")).toThrow("not a valid URL");
    expect(() => redisOptionsFromUrl("https://example.com")).toThrow("redis:// or rediss://");
  });
});
