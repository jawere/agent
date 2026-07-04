import { httpRouter } from "convex/server";
import { chatStream, chatSync } from "./chat.js";

const http = httpRouter();

http.route({
  path: "/api/chat",
  method: "POST",
  handler: chatStream,
});

http.route({
  path: "/api/chat-sync",
  method: "POST",
  handler: chatSync,
});

export default http;
