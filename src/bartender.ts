import { randomUUID } from "node:crypto";

// Types defined by the assignment.
export type DrinkType = "BEER" | "DRINK";

export type OrderRequestBody = { customerId: string; drinkType: DrinkType };

// Data on server per Order
export interface OrderData extends OrderRequestBody {
  id: string;
  startedAt: string;
  servedAt?: string;
  status: "PREPARING" | "SERVED";
}

export type OrderResponse =
  | { result: "accepted"; order: OrderData }
  | { result: "duplicate"; order: OrderData }
  | { result: "capacity_exceeded" }
  | { result: "idempotency_conflict" };
type IdempotencyResult = Extract<
  OrderResponse,
  { result: "duplicate" | "idempotency_conflict" }
>;

// Bartender class
export class Bartender {
  private readonly orders = new Map<string, OrderData>();

  constructor(private readonly preparationMs = 5000) {
    if (!Number.isFinite(preparationMs) || preparationMs <= 0) {
      throw new Error("Preparation duration must be positive");
    }
  }

  // capacity logic
  private canPrepareDrink(drinkType: DrinkType): boolean {
    const activeOrders = [...this.orders.values()].filter(
      (order) => order.status === "PREPARING",
    );
    if (activeOrders.length === 0) {
      return true;
    }

    return (
      activeOrders.length < 2 &&
      activeOrders.every((order) => order.drinkType === "BEER") &&
      drinkType === "BEER"
    );
  }
  // Idempotency logic
  private checkIdempotency(
    request: OrderRequestBody,
    key: string,
  ): IdempotencyResult | null {
    const existing = this.orders.get(key);

    if (!existing) {
      return null;
    }

    if (
      existing.customerId !== request.customerId ||
      existing.drinkType !== request.drinkType
    ) {
      return { result: "idempotency_conflict" };
    }

    return { result: "duplicate", order: { ...existing } };
  }

  // handling orders
  private finishOrder(key: string): void {
    const order = this.orders.get(key);

    if (!order || order.status !== "PREPARING") {
      return;
    }

    order.status = "SERVED";
    order.servedAt = new Date().toISOString();
  }
  private startOrder(request: OrderRequestBody, key: string): OrderData {
    const order: OrderData = {
      id: randomUUID(),
      ...request,
      status: "PREPARING",
      startedAt: new Date().toISOString(),
    };

    this.orders.set(key, order);

    setTimeout(() => {
      this.finishOrder(key);
    }, this.preparationMs);

    return order;
  }

  order(request: OrderRequestBody, idempotencyKey: string): OrderResponse {
    // Check idempotency before checking capacity.
    const existingOrderResult = this.checkIdempotency(request, idempotencyKey);
    if (existingOrderResult) {
      return existingOrderResult;
    }

    // check capacity
    if (!this.canPrepareDrink(request.drinkType)) {
      return { result: "capacity_exceeded" };
    }

    // start order
    const order = this.startOrder(request, idempotencyKey);
    return { result: "accepted", order: { ...order } };
  }

  status() {
    const servedOrders = [...this.orders.values()]
      .filter((order) => order.status === "SERVED")
      .map((order) => ({ ...order }));

    const uniqueCustomers = [
      ...new Set(servedOrders.map((order) => order.customerId)),
    ];

    return {
      servedOrders,
      uniqueCustomers,
    };
  }
}
