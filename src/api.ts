import type { RequestListener } from "node:http";
import type { Bartender } from "./bartender.js";
import { HttpError, readBody, respond } from "./http.js";
import { audit } from "./audit.js";

export function createApiHandler(bartender: Bartender): RequestListener {
  return async (req, res) => {
    let payload: unknown = null;

    try {
      // GET /status
      if (req.method === "GET" && req.url === "/status") {
        return respond(res, 200, bartender.status());
      }

      // POST /order
      if (req.method === "POST" && req.url === "/order") {
        const rawBody = await readBody(req);

        // Preserve raw input for auditing if JSON parsing fails.
        payload = rawBody;

        if (!rawBody.trim()) {
          throw new HttpError(400, "Request body is empty");
        }

        try {
          payload = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, "Invalid JSON");
        }

        // Validate request body.
        if (
          !payload ||
          typeof payload !== "object" ||
          !("customerId" in payload) ||
          typeof payload.customerId !== "string" ||
          !payload.customerId.trim() ||
          !("drinkType" in payload) ||
          (payload.drinkType !== "BEER" && payload.drinkType !== "DRINK")
        ) {
          return respond(res, 400, { error: "Invalid order" });
        }

        // Validate idempotency key.
        const key = req.headers["idempotency-key"];

        if (typeof key !== "string" || !key.trim()) {
          return respond(res, 400, {
            error: "Idempotency-Key header required",
          });
        }

        // Submit order.
        const result = bartender.order(
          {
            customerId: payload.customerId,
            drinkType: payload.drinkType,
          },
          key,
        );

        switch (result.result) {
          case "accepted":
          case "duplicate":
            return respond(res, 200, {
              orderId: result.order.id,
              status: result.order.status,
            });

          case "capacity_exceeded":
            return respond(res, 429, {
              error: "Bartender at capacity",
            });

          case "idempotency_conflict":
            return respond(res, 409, {
              error: "Idempotency key already used for another order",
            });
        }
      }

      // Unknown endpoint.
      return respond(res, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        // Preserve the available body when readBody() rejects a request.
        if (error.payload !== undefined) {
          payload = error.payload;
        }

        return respond(res, error.status, {
          error: error.message,
        });
      }

      console.error(error);

      return respond(res, 500, {
        error: "Internal server error",
      });
    } finally {
      // Audit every handled HTTP request, including rejected requests.
      audit({
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        payload,
        status: res.statusCode,
      });
    }
  };
}
