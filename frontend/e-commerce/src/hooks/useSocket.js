// src/socket/socket.js
import { io as clientIo } from "socket.io-client";

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:5000";

// Create a singleton Socket.io client
export const io = clientIo(SOCKET_URL, {
  autoConnect: true,
  transports: ["websocket"],
});

// Optional: log connection status for debugging
io.on("connect", () => {
  console.log("Socket connected:", io.id);
});

io.on("disconnect", (reason) => {
  console.log("Socket disconnected:", reason);
});
