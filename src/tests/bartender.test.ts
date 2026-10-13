import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bartender } from "../bartender.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Bartender", () => {
  describe("capacity", () => {
    it("accepts two beers concurrently", () => {
      const bartender = new Bartender(100);

      const first = bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      const second = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      if (second.result !== "accepted") {
        assert.fail(`Expected accepted, got ${second.result}`);
      }

      assert.equal(first.order.status, "PREPARING");
      assert.equal(second.order.status, "PREPARING");
      assert.notEqual(first.order.id, second.order.id);
    });

    it("rejects a third beer when two are preparing", () => {
      const bartender = new Bartender(100);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      const third = bartender.order(
        { customerId: "customer-3", drinkType: "BEER" },
        "order-3",
      );

      assert.equal(third.result, "capacity_exceeded");
    });

    it("rejects a drink while preparing a beer", () => {
      const bartender = new Bartender(100);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      const drink = bartender.order(
        { customerId: "customer-2", drinkType: "DRINK" },
        "order-2",
      );

      assert.equal(drink.result, "capacity_exceeded");
    });

    it("rejects another order while preparing a drink", () => {
      const bartender = new Bartender(100);

      const first = bartender.order(
        { customerId: "customer-1", drinkType: "DRINK" },
        "order-1",
      );

      const beer = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      const drink = bartender.order(
        { customerId: "customer-3", drinkType: "DRINK" },
        "order-3",
      );

      assert.equal(first.result, "accepted");
      assert.equal(beer.result, "capacity_exceeded");
      assert.equal(drink.result, "capacity_exceeded");
    });

    it("releases capacity after preparation finishes", async () => {
      const bartender = new Bartender(20);

      const first = bartender.order(
        { customerId: "customer-1", drinkType: "DRINK" },
        "order-1",
      );

      assert.equal(first.result, "accepted");

      const blocked = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      assert.equal(blocked.result, "capacity_exceeded");

      await sleep(50);

      // Rejected orders do not reserve their idempotency keys.
      const second = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      assert.equal(second.result, "accepted");
    });

    it("releases one beer slot while another beer is preparing", async () => {
      const bartender = new Bartender(200);

      const first = bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      assert.equal(first.result, "accepted");

      await sleep(100);

      const second = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      assert.equal(second.result, "accepted");

      await sleep(120);

      // First beer has finished, but the second is still preparing.
      const third = bartender.order(
        { customerId: "customer-3", drinkType: "BEER" },
        "order-3",
      );

      assert.equal(third.result, "accepted");

      // A DRINK still cannot start while beers are being prepared.
      const drink = bartender.order(
        { customerId: "customer-4", drinkType: "DRINK" },
        "order-4",
      );

      assert.equal(drink.result, "capacity_exceeded");
    });
  });

  describe("idempotency", () => {
    it("does not prepare the same order twice", () => {
      const bartender = new Bartender(100);

      const request = {
        customerId: "customer-1",
        drinkType: "BEER" as const,
      };

      const first = bartender.order(request, "order-1");
      const duplicate = bartender.order(request, "order-1");

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      if (duplicate.result !== "duplicate") {
        assert.fail(`Expected duplicate, got ${duplicate.result}`);
      }

      assert.equal(first.order.id, duplicate.order.id);
    });

    it("recognizes duplicates even when at capacity", () => {
      const bartender = new Bartender(100);

      const request = {
        customerId: "customer-1",
        drinkType: "DRINK" as const,
      };

      const first = bartender.order(request, "order-1");

      // A DRINK occupies the bartender's full capacity.
      const duplicate = bartender.order(request, "order-1");

      assert.equal(first.result, "accepted");
      assert.equal(duplicate.result, "duplicate");
    });

    it("rejects reuse of an idempotency key with different drink types", () => {
      const bartender = new Bartender(100);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      const conflict = bartender.order(
        { customerId: "customer-1", drinkType: "DRINK" },
        "order-1",
      );

      assert.equal(conflict.result, "idempotency_conflict");
    });

    it("rejects reuse of an idempotency key by another customer", () => {
      const bartender = new Bartender(100);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "shared-key",
      );

      const conflict = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "shared-key",
      );

      assert.equal(conflict.result, "idempotency_conflict");
    });

    it("allows multiple distinct orders from the same customer", () => {
      const bartender = new Bartender(100);

      const request = {
        customerId: "customer-1",
        drinkType: "BEER" as const,
      };

      const first = bartender.order(request, "order-1");
      const second = bartender.order(request, "order-2");

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      if (second.result !== "accepted") {
        assert.fail(`Expected accepted, got ${second.result}`);
      }

      assert.notEqual(first.order.id, second.order.id);
    });

    it("recognizes duplicates after an order has been served", async () => {
      const bartender = new Bartender(20);

      const request = {
        customerId: "customer-1",
        drinkType: "BEER" as const,
      };

      const first = bartender.order(request, "order-1");

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      await sleep(50);

      const duplicate = bartender.order(request, "order-1");

      if (duplicate.result !== "duplicate") {
        assert.fail(`Expected duplicate, got ${duplicate.result}`);
      }

      assert.equal(first.order.id, duplicate.order.id);
      assert.equal(duplicate.order.status, "SERVED");
    });
  });

  describe("order lifecycle", () => {
    it("transitions an order from PREPARING to SERVED", async () => {
      const bartender = new Bartender(20);

      const request = {
        customerId: "customer-1",
        drinkType: "BEER" as const,
      };

      const first = bartender.order(request, "order-1");

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      assert.equal(first.order.status, "PREPARING");
      assert.equal(first.order.servedAt, undefined);
      assert.ok(Number.isFinite(Date.parse(first.order.startedAt)));

      await sleep(50);

      const duplicate = bartender.order(request, "order-1");

      if (duplicate.result !== "duplicate") {
        assert.fail(`Expected duplicate, got ${duplicate.result}`);
      }

      assert.equal(duplicate.order.status, "SERVED");
      assert.ok(duplicate.order.servedAt);

      assert.ok(
        Date.parse(duplicate.order.servedAt) >=
          Date.parse(first.order.startedAt),
      );

      // The original response must not change after preparation finishes.
      assert.equal(first.order.status, "PREPARING");
      assert.equal(first.order.servedAt, undefined);
    });
  });

  describe("status", () => {
    it("does not include preparing orders", () => {
      const bartender = new Bartender(100);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      const status = bartender.status();

      assert.deepEqual(status.servedOrders, []);
      assert.deepEqual(status.uniqueCustomers, []);
    });

    it("reports served orders and deduplicates customers", async () => {
      const bartender = new Bartender(20);

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-1",
      );

      bartender.order(
        { customerId: "customer-1", drinkType: "BEER" },
        "order-2",
      );

      await sleep(50);

      const status = bartender.status();

      assert.equal(status.servedOrders.length, 2);
      assert.deepEqual(status.uniqueCustomers, ["customer-1"]);

      assert.ok(
        status.servedOrders.every((order) => order.status === "SERVED"),
      );

      assert.ok(
        status.servedOrders.every((order) => order.servedAt !== undefined),
      );

      assert.notEqual(status.servedOrders[0].id, status.servedOrders[1].id);
    });
  });

  describe("state protection", () => {
    it("does not expose mutable internal order state", () => {
      const bartender = new Bartender(100);

      const request = {
        customerId: "customer-1",
        drinkType: "DRINK" as const,
      };

      const first = bartender.order(request, "order-1");

      if (first.result !== "accepted") {
        assert.fail(`Expected accepted, got ${first.result}`);
      }

      // Attempt to manipulate the returned object.
      first.order.status = "SERVED";
      first.order.servedAt = new Date().toISOString();

      // The bartender must still consider the DRINK in preparation.
      const second = bartender.order(
        { customerId: "customer-2", drinkType: "BEER" },
        "order-2",
      );

      assert.equal(second.result, "capacity_exceeded");

      const duplicate = bartender.order(request, "order-1");

      if (duplicate.result !== "duplicate") {
        assert.fail(`Expected duplicate, got ${duplicate.result}`);
      }

      assert.equal(duplicate.order.status, "PREPARING");
      assert.equal(duplicate.order.servedAt, undefined);
    });
  });

  describe("configuration", () => {
    it("rejects invalid preparation durations", () => {
      for (const duration of [0, -1, NaN, Infinity, -Infinity]) {
        assert.throws(
          () => new Bartender(duration),
          /Preparation duration must be positive/,
        );
      }
    });
  });
});