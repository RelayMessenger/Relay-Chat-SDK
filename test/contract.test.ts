import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  RELAY_API_VERSION,
  RELAY_WEBHOOK_EVENT_TYPES,
  RELAY_WEBHOOK_VERSION,
} from "../src/index.js";

const OPENAPI_SHA =
  "f62f431fc0daa48500926bf87753f81c3fdda25ab463b130ca97f2896367e0a5";

interface OpenApiDocument {
  components: {
    schemas: Record<string, Record<string, unknown>>;
  };
  paths: Record<string, Record<string, unknown>>;
  servers: Array<{ url: string }>;
}

describe("locked Relay Server contract", () => {
  it("uses the unchanged OpenAPI from Server 9b4d5bb32cc7", async () => {
    const source = await readFile(
      new URL("../contracts/relay-openapi.yaml", import.meta.url),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      OPENAPI_SHA,
    );
  });

  it("pins only public methods the adapter calls", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    expect(document.servers[0]?.url).toBe(
      "https://api.relayapp.im",
    );
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/messages"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["get", "post"]));
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/typing"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["post", "delete"]));
    expect(
      document.paths["/v1/chats/{chatId}/read"],
    ).toHaveProperty("post");
    expect(
      document.paths["/v1/messages/{messageId}/reactions"],
    ).toHaveProperty("post");
    expect(document.paths["/v1/attachments"]).toHaveProperty(
      "post",
    );
    expect(document.paths["/v1/messages/{messageId}"]).toHaveProperty(
      "get",
    );
    expect(document.paths["/v1/messages/{messageId}"]).not.toHaveProperty(
      "patch",
    );
    expect(document.paths["/v1/messages/{messageId}"]).not.toHaveProperty(
      "delete",
    );
  });

  it("keeps API/webhook versions and every event synchronized", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    const envelope = document.components.schemas.WebhookEnvelopeBase as {
      properties: {
        api_version: { enum: string[] };
        webhook_version: { enum: string[] };
      };
    };
    const events = document.components.schemas.WebhookEventType as {
      enum: string[];
    };
    expect(envelope.properties.api_version.enum).toEqual([
      RELAY_API_VERSION,
    ]);
    expect(envelope.properties.webhook_version.enum).toEqual([
      RELAY_WEBHOOK_VERSION,
    ]);
    expect(events.enum).toEqual([...RELAY_WEBHOOK_EVENT_TYPES]);
  });
});
