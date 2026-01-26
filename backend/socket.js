const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./config"); 
// const User = require("./models/User"); // Uncomment if you need to fetch user data on connection

// Best Practice: Separate JWT authentication logic into a dedicated function.
const socketAuthMiddleware = async (socket, next) => {
  const token = socket.handshake.auth?.token;

  // Allow connection as a guest if no token is provided.
  if (!token) {
    socket.user = { isGuest: true };
    return next();
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Attach the decoded payload (e.g., { id: '...', role: '...' }) to the socket object
    socket.user = { 
      id: payload.id, 
      role: payload.role, 
      isGuest: false 
    };

    // OPTIONAL: If fetching user data is required:
    // const user = await User.findById(payload.id).select('-password');
    // if (!user) return next(new Error("User not found"));
    // socket.user = user; 

    // console.log(`[Socket Auth] Token validated for user: ${socket.user.id}`);
    next();

  } catch (err) {
    // Explicitly handle token errors (expired, invalid signature, malformed)
    console.error(`[Socket Auth Error] Token rejected: ${err.name} - ${err.message}`);
    // Reject the connection if a token was provided but is invalid
    return next(new Error("Invalid or expired token. Connection rejected."));
  }
};

/**
 * Initializes and configures the Socket.IO server.
 * @param {import('http').Server} server The HTTP server instance.
 * @param {object} opts Additional Socket.IO server options.
 * @returns {Server} The configured Socket.IO server instance.
 */
function initSocket(server, opts = {}) {
  // Use CLIENT_URL from process.env for CORS origin
  const io = new Server(server, {
    cors: { 
      // Use CLIENT_URL from the environment or default to localhost:3000
      origin: process.env.CLIENT_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    // Production-Ready: Disable serving the client file if you use a CDN
    serveClient: false, 
    // Use the path from the environment or default
    path: process.env.SOCKET_PATH || "/socket.io", 
    
    ...opts,
  });

  // Attach the authentication middleware
  io.use(socketAuthMiddleware);

  // Main connection handler
  io.on("connection", (socket) => {
    const userId = socket.user?.id || 'guest';
    const isGuest = socket.user?.isGuest;

    console.log(`[Socket Connected] ID: ${socket.id}, User: ${userId}, Type: ${isGuest ? 'GUEST' : 'AUTHENTICATED'}`);

    // Room per user ID (Best Practice for targeted notifications)
    if (!isGuest) {
      const userRoom = `user:${userId}`;
      socket.join(userRoom);
      // console.log(`[Socket Joined Room] User ${userId} joined room ${userRoom}`);
    }

    // You can add generic socket event handlers here if needed
    // socket.on("client:someEvent", (data) => { ... });

    socket.on("disconnect", reason => {
      console.log(`[Socket Disconnected] ID: ${socket.id}, User: ${userId}, Reason: ${reason}`);
    });
  });

  return io;
}

/**
 * Helper function to emit an event specifically to a single authenticated user.
 * @param {Server} io The Socket.IO server instance.
 * @param {string} userId The unique ID of the target user.
 * @param {string} event The name of the event to emit.
 * @param {any} payload The data payload to send.
 */
function emitToUser(io, userId, event, payload) {
  const userRoom = `user:${userId}`;
  // io.to will emit to all sockets connected under the given room name
  io.to(userRoom).emit(event, payload);
  // console.log(`[Emit Helper] Emitted event '${event}' to user room: ${userRoom}`);
}

module.exports = { initSocket, emitToUser };