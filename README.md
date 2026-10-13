# Bartender API

A simple HTTP API simulating a bartender preparing beer and other drinks.

Implemented with TypeScript and Node.js using built-in HTTP modules, without additional runtime dependencies.

## Setup

Requires Node.js >= 22.9.0.

Install dependencies, build and start the server:

```bash
npm install
npm run build
npm start
```

Or for development:

```bash
npm install
npm run dev
```

## Configuration

Configuration can optionally be provided through a `.env` file (see `.env.example`).

The `.env` file is loaded automatically when starting the server. If no file is present, the application uses its default values.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `PREPARATION_SECONDS` | `5` | Preparation time per drink in seconds |
| `AUDIT_LOG_FILE` | Disabled | Optional file path for audit logging |


## API

### POST /order

Creates an order for one beer or non-beer drink.

The client must provide an `Idempotency-Key` header.

Example:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123" \
  -d '{"customerId":"customer-1","drinkType":"BEER"}'
```

Successful response (`200`):

```json
{
  "orderId": "generated-uuid",
  "status": "PREPARING"
}
```

Possible HTTP responses:

| Status | Description |
|---|---|
| 200 | Order accepted or existing order returned |
| 400 | Invalid request |
| 409 | Idempotency key already used for another order |
| 413 | Request body too large |
| 429 | Bartender at capacity |
| 404 | Unknown endpoint |

### GET /status

Returns all served orders and unique customers who have been served.

```bash
curl http://localhost:3000/status
```

Example response:

```json
{
  "servedOrders": [
    {
      "id": "generated-uuid",
      "customerId": "customer-1",
      "drinkType": "BEER",
      "status": "SERVED",
      "startedAt": "2026-10-13T10:00:00.000Z",
      "servedAt": "2026-10-13T10:00:05.000Z"
    }
  ],
  "uniqueCustomers": ["customer-1"]
}
```

## Implementation Notes

### Order handling

Each order represents one drink, as the given request body does not contain a quantity.

A customer can place multiple orders, including while another order is still being prepared.

The bartender can prepare up to two beers simultaneously or one non-beer drink exclusively. Both types cannot be prepared at the same time.

There is no queue. Orders are either accepted immediately or rejected with HTTP `429` when the bartender is at capacity.

Preparation is simulated asynchronously using a timer. After the configured preparation time, the order changes from `PREPARING` to `SERVED`.

### Idempotency

I chose to use an `Idempotency-Key` header provided by the client, rather than extending the given request body with an order ID.

Other approaches considered:

- **Deduplication by payload:** The payload is too simple to distinguish retries from legitimate new orders.
- **Time-based deduplication:** Could block legitimate follow-up orders.
- **One active order per customer:** Would prevent customers from placing multiple orders simultaneously.

Using the same key with the same order data returns the existing order. Using the same key with different data returns HTTP `409`.

Rejected orders do not reserve their idempotency keys.

### State management

All orders are stored in memory in a `Bartender` class.

The class handles capacity checks, idempotency and order lifecycle.

There is no persistent storage, so orders are lost when the server restarts.

### Auditing

Every handled HTTP request is logged with timestamp, method, URL, payload and response status.

Audit records are written to the console and can optionally be appended to a JSONL file using `AUDIT_LOG_FILE`.

Request bodies are limited to 10 KB. For oversized requests, only the first 10 KB are retained for auditing.

## Limitations

The implementation is intentionally kept simple for this assignment.

- Capacity checks currently scan the order history to find active orders. For larger histories, active orders could be maintained separately.
- The in-memory state is not shared across server instances.
- Very large preparation durations are not expected for this assignment and are limited by Node.js timer behavior.
- File-based audit logging does not implement log rotation or retention.
- Request bodies are only read for `POST /order`. Other endpoints are audited with `payload: null`.

## Tests

Unit tests cover the bartender logic, including capacity, idempotency and order lifecycle.

HTTP integration tests cover request validation, response codes, status reporting and auditing.

Run the tests:

```bash
npm test
```

Type-check:

```bash
npm run typecheck
```
