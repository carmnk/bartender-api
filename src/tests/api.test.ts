import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Bartender } from "../bartender.js";
import { createApiHandler } from "../api.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withServer(
  test: (
    baseUrl: string,
    bartender: Bartender,
    logs: string[],
  ) => Promise<void>,
  preparationMs = 1000,
): Promise<void> {
  const bartender = new Bartender(preparationMs);
  const server = createServer(createApiHandler(bartender));
  const logs: string[] = [];

  const logMock = mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  try {
    server.listen(0);
    await once(server, "listening");

    const address = server.address();

    if (!address || typeof address === "string") {
      assert.fail("Expected a TCP server address");
    }

    await test(`http://127.0.0.1:${address.port}`, bartender, logs);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logMock.mock.restore();
  }
}

function postOrder(
  baseUrl: string,
  body: unknown,
  key?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key !== undefined ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Bartender HTTP API", () => {
  describe("POST /order", () => {
    it("accepts a valid order and returns its ID and status", async () => {
      await withServer(async (baseUrl) => {
        const response = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "BEER" },
          "order-1",
        );

        assert.equal(response.status, 200);

        const body = await response.json();

        assert.equal(body.status, "PREPARING");
        assert.equal(typeof body.orderId, "string");
        assert.ok(body.orderId.length > 0);
      });
    });

    it("returns the same order ID for an idempotent retry", async () => {
      await withServer(async (baseUrl) => {
        const request = {
          customerId: "customer-1",
          drinkType: "BEER",
        };

        const first = await postOrder(baseUrl, request, "order-1");
        const duplicate = await postOrder(baseUrl, request, "order-1");

        assert.equal(first.status, 200);
        assert.equal(duplicate.status, 200);

        const firstBody = await first.json();
        const duplicateBody = await duplicate.json();

        assert.equal(firstBody.orderId, duplicateBody.orderId);
        assert.equal(duplicateBody.status, "PREPARING");
      });
    });

    it("returns HTTP 409 when an idempotency key is reused with different data", async () => {
      await withServer(async (baseUrl) => {
        const first = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "BEER" },
          "order-1",
        );

        assert.equal(first.status, 200);

        const conflict = await postOrder(
          baseUrl,
          { customerId: "customer-2", drinkType: "BEER" },
          "order-1",
        );

        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), {
          error: "Idempotency key already used for another order",
        });
      });
    });

    it("returns HTTP 429 when beer capacity is exceeded", async () => {
      await withServer(async (baseUrl) => {
        const request = (customerId: string) => ({
          customerId,
          drinkType: "BEER",
        });

        const first = await postOrder(
          baseUrl,
          request("customer-1"),
          "order-1",
        );

        const second = await postOrder(
          baseUrl,
          request("customer-2"),
          "order-2",
        );

        const third = await postOrder(
          baseUrl,
          request("customer-3"),
          "order-3",
        );

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(third.status, 429);

        assert.deepEqual(await third.json(), {
          error: "Bartender at capacity",
        });
      });
    });

    it("returns HTTP 429 when a DRINK occupies full capacity", async () => {
      await withServer(async (baseUrl) => {
        const first = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "DRINK" },
          "order-1",
        );

        const second = await postOrder(
          baseUrl,
          { customerId: "customer-2", drinkType: "BEER" },
          "order-2",
        );

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
      });
    });

    it("accepts a previously rejected order after capacity becomes available", async () => {
      await withServer(async (baseUrl) => {
        const first = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "DRINK" },
          "order-1",
        );

        assert.equal(first.status, 200);

        const blocked = await postOrder(
          baseUrl,
          { customerId: "customer-2", drinkType: "BEER" },
          "order-2",
        );

        assert.equal(blocked.status, 429);

        await sleep(100);

        const retry = await postOrder(
          baseUrl,
          { customerId: "customer-2", drinkType: "BEER" },
          "order-2",
        );

        assert.equal(retry.status, 200);
        assert.equal((await retry.json()).status, "PREPARING");
      }, 30);
    });

    it("returns HTTP 400 when the idempotency key is missing", async () => {
      await withServer(async (baseUrl) => {
        const response = await postOrder(baseUrl, {
          customerId: "customer-1",
          drinkType: "BEER",
        });

        assert.equal(response.status, 400);

        assert.deepEqual(await response.json(), {
          error: "Idempotency-Key header required",
        });
      });
    });

    it("returns HTTP 400 for invalid order data", async () => {
      await withServer(async (baseUrl) => {
        const invalidBodies = [
          null,
          [],
          {},
          { drinkType: "BEER" },
          { customerId: "", drinkType: "BEER" },
          { customerId: "   ", drinkType: "BEER" },
          { customerId: 123, drinkType: "BEER" },
          { customerId: "customer-1" },
          { customerId: "customer-1", drinkType: "WINE" },
          { customerId: "customer-1", drinkType: null },
        ];

        for (const body of invalidBodies) {
          const response = await postOrder(baseUrl, body, "invalid-order");

          assert.equal(
            response.status,
            400,
            `Expected 400 for ${JSON.stringify(body)}`,
          );

          assert.deepEqual(await response.json(), {
            error: "Invalid order",
          });
        }
      });
    });

    it("returns HTTP 400 for malformed JSON", async () => {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "order-1",
          },
          body: '{"customerId":',
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          error: "Invalid JSON",
        });
      });
    });

    it("returns HTTP 400 for an empty request body", async () => {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "order-1",
          },
          body: "",
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          error: "Request body is empty",
        });
      });
    });

    it("returns HTTP 413 for oversized request bodies", async () => {
      await withServer(async (baseUrl, bartender) => {
        const response = await postOrder(
          baseUrl,
          {
            customerId: "x".repeat(20_000),
            drinkType: "BEER",
          },
          "oversized-order",
        );

        assert.equal(response.status, 413);
        assert.deepEqual(await response.json(), {
          error: "Request body too large",
        });

        assert.deepEqual(bartender.status().servedOrders, []);
      });
    });

    it("returns SERVED when retrying an already completed order", async () => {
      await withServer(async (baseUrl) => {
        const request = {
          customerId: "customer-1",
          drinkType: "BEER",
        };

        const first = await postOrder(baseUrl, request, "order-1");

        assert.equal(first.status, 200);

        const firstBody = await first.json();

        await sleep(100);

        const duplicate = await postOrder(baseUrl, request, "order-1");

        assert.equal(duplicate.status, 200);

        const duplicateBody = await duplicate.json();

        assert.equal(duplicateBody.orderId, firstBody.orderId);
        assert.equal(duplicateBody.status, "SERVED");
      }, 30);
    });
  });

  describe("GET /status", () => {
    it("returns empty lists when no orders have been served", async () => {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/status`);

        assert.equal(response.status, 200);

        assert.deepEqual(await response.json(), {
          servedOrders: [],
          uniqueCustomers: [],
        });
      });
    });

    it("excludes orders that are still preparing", async () => {
      await withServer(async (baseUrl) => {
        const order = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "BEER" },
          "order-1",
        );

        assert.equal(order.status, 200);

        const response = await fetch(`${baseUrl}/status`);

        assert.equal(response.status, 200);

        assert.deepEqual(await response.json(), {
          servedOrders: [],
          uniqueCustomers: [],
        });
      });
    });

    it("reports served orders and unique customers", async () => {
      await withServer(async (baseUrl) => {
        const first = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "BEER" },
          "order-1",
        );

        const second = await postOrder(
          baseUrl,
          { customerId: "customer-1", drinkType: "BEER" },
          "order-2",
        );

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);

        const firstOrder = await first.json();
        const secondOrder = await second.json();

        await sleep(100);

        const response = await fetch(`${baseUrl}/status`);

        assert.equal(response.status, 200);

        const body = await response.json();

        assert.equal(body.servedOrders.length, 2);
        assert.deepEqual(body.uniqueCustomers, ["customer-1"]);

        assert.deepEqual(
          body.servedOrders.map((order: { id: string }) => order.id),
          [firstOrder.orderId, secondOrder.orderId],
        );

        for (const order of body.servedOrders) {
          assert.equal(order.status, "SERVED");
          assert.equal(typeof order.startedAt, "string");
          assert.equal(typeof order.servedAt, "string");
          assert.ok(Date.parse(order.servedAt) >= Date.parse(order.startedAt));
        }
      }, 30);
    });
  });

  describe("routing", () => {
    it("returns HTTP 404 for unknown endpoints", async () => {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/unknown`);

        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {
          error: "Not found",
        });
      });
    });

    it("returns HTTP 404 for unsupported methods", async () => {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/order`, {
          method: "GET",
        });

        assert.equal(response.status, 404);
      });
    });
  });

  describe("auditing", () => {
    it("logs successful requests with timestamp, method, URL, payload and status", async () => {
      await withServer(async (baseUrl, _bartender, logs) => {
        const request = {
          customerId: "customer-1",
          drinkType: "BEER",
        };

        const response = await postOrder(baseUrl, request, "order-1");

        assert.equal(response.status, 200);
        assert.equal(logs.length, 1);

        const audit = JSON.parse(logs[0]);

        assert.ok(Number.isFinite(Date.parse(audit.timestamp)));
        assert.equal(audit.method, "POST");
        assert.equal(audit.url, "/order");
        assert.deepEqual(audit.payload, request);
        assert.equal(audit.status, 200);
      });
    });

    it("logs malformed JSON requests with their raw payload", async () => {
      await withServer(async (baseUrl, _bartender, logs) => {
        const rawBody = '{"customerId":';

        const response = await fetch(`${baseUrl}/order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "order-1",
          },
          body: rawBody,
        });

        assert.equal(response.status, 400);
        assert.equal(logs.length, 1);

        const audit = JSON.parse(logs[0]);

        assert.equal(audit.method, "POST");
        assert.equal(audit.url, "/order");
        assert.equal(audit.payload, rawBody);
        assert.equal(audit.status, 400);
      });
    });

    it("limits the audited payload of oversized requests", async () => {
      await withServer(async (baseUrl, _bartender, logs) => {
        const response = await postOrder(
          baseUrl,
          {
            customerId: "x".repeat(20_000),
            drinkType: "BEER",
          },
          "oversized-order",
        );

        assert.equal(response.status, 413);
        assert.equal(logs.length, 1);

        const audit = JSON.parse(logs[0]);

        assert.equal(audit.status, 413);
        assert.equal(typeof audit.payload, "string");

        assert.ok(
          Buffer.byteLength(audit.payload, "utf8") <= 10_000,
          "Audited payload must not exceed 10 KB",
        );
      });
    });

    it("logs requests to unknown endpoints", async () => {
      await withServer(async (baseUrl, _bartender, logs) => {
        const response = await fetch(`${baseUrl}/unknown`);

        assert.equal(response.status, 404);
        assert.equal(logs.length, 1);

        const audit = JSON.parse(logs[0]);

        assert.equal(audit.method, "GET");
        assert.equal(audit.url, "/unknown");
        assert.equal(audit.payload, null);
        assert.equal(audit.status, 404);
      });
    });

    it("writes audit records to a file when enabled", async () => {
      const directory = mkdtempSync(join(tmpdir(), "bartender-audit-"));
      const filePath = join(directory, "audit.jsonl");

      const previousValue = process.env.AUDIT_LOG_FILE;
      process.env.AUDIT_LOG_FILE = filePath;

      try {
        await withServer(async (baseUrl) => {
          const response = await postOrder(
            baseUrl,
            {
              customerId: "customer-1",
              drinkType: "BEER",
            },
            "order-1",
          );

          assert.equal(response.status, 200);

          const content = readFileSync(filePath, "utf8");
          const lines = content.trim().split("\n");

          assert.equal(lines.length, 1);

          const entry = JSON.parse(lines[0]);

          assert.equal(entry.method, "POST");
          assert.equal(entry.url, "/order");
          assert.equal(entry.status, 200);
          assert.deepEqual(entry.payload, {
            customerId: "customer-1",
            drinkType: "BEER",
          });
        });
      } finally {
        if (previousValue === undefined) {
          delete process.env.AUDIT_LOG_FILE;
        } else {
          process.env.AUDIT_LOG_FILE = previousValue;
        }

        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
  describe("concurrent requests", () => {
    it("handles many simultaneous orders without exceeding capacity", async () => {
      await withServer(async (baseUrl) => {
        const requests = Array.from({ length: 50 }, (_, i) =>
          postOrder(
            baseUrl,
            {
              customerId: `customer-${i}`,
              drinkType: "BEER",
            },
            `order-${i}`,
          ),
        );

        const responses = await Promise.all(requests);

        const accepted = responses.filter((r) => r.status === 200);
        const rejected = responses.filter((r) => r.status === 429);

        assert.equal(accepted.length, 2);
        assert.equal(rejected.length, 48);

        const acceptedBodies = await Promise.all(accepted.map((r) => r.json()));

        assert.equal(
          new Set(acceptedBodies.map((body) => body.orderId)).size,
          2,
        );

        await sleep(100);

        const statusResponse = await fetch(`${baseUrl}/status`);
        const status = await statusResponse.json();

        assert.equal(status.servedOrders.length, 2);
        assert.equal(status.uniqueCustomers.length, 2);

        const nextOrder = await postOrder(
          baseUrl,
          { customerId: "customer-next", drinkType: "DRINK" },
          "order-next",
        );

        assert.equal(nextOrder.status, 200);
      }, 30);
    });
  });
});
