import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config/env.js";
import { ConversationRelayHandler } from "./twilio/conversationRelayHandler.js";
import { logger } from "./utils/logger.js";

const relayHandler = new ConversationRelayHandler();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "docproxy-voice-ai-node",
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({
  noServer: true
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ai/conversation") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    void relayHandler.handleConnection(ws);
  });
});

server.listen(config.PORT, () => {
  logger.info("Voice AI Node service listening", {
    port: config.PORT,
    nodeEnv: config.NODE_ENV,
    publicWsUrl: config.PUBLIC_WS_URL
  });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
