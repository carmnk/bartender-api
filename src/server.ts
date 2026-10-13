import { createServer } from "node:http";
import { Bartender } from "./bartender.js";
import { createApiHandler } from "./api.js";

const preparationSeconds = Number(process.env.PREPARATION_SECONDS ?? 5);

if (!Number.isFinite(preparationSeconds) || preparationSeconds <= 0) {
  throw new Error("PREPARATION_SECONDS must be positive");
}

const bartender = new Bartender(preparationSeconds * 1000);

const server = createServer(createApiHandler(bartender));

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

server.on("error", (error) => {
  console.error("Failed to start HTTP server:", error);
  process.exitCode = 1;
});

server.listen(port, () => {
  console.log(`Bartender listening on http://localhost:${port}`);
});
