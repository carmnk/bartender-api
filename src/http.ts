import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 10_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload?: string,
  ) {
    super(message);
  }
}

export function respond(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });

  res.end(JSON.stringify(data));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    size += buffer.byteLength;

    if (size > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        "Request body too large",
        Buffer.concat([...chunks, buffer])
          .subarray(0, MAX_BODY_BYTES)
          .toString("utf8"),
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
