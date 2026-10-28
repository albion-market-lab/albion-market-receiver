import { resolve } from "node:path";
import { createCollectorListener } from "./listener.js";

const host = "127.0.0.1";
const port = 8787;
const outputDirectory = resolve(process.env.POC_OUTPUT_DIR ?? "var/collector-events");
const server = createCollectorListener({ outputDirectory });

server.listen(port, host, () => {
  console.log(`Collector listener ready at http://${host}:${port}/marketorders.ingest`);
});

function stop(): void {
  server.close((error) => {
    if (error) {
      console.error("Failed to stop collector listener");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
