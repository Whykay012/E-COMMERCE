
const { createLogger, format, transports } = require("winston");
require("winston-daily-rotate-file");

const level = process.env.LOG_LEVEL || "info";

const rotateTransport = new transports.DailyRotateFile({
  dirname: process.env.LOG_DIR || "logs",
  filename: "%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "14d",
});

const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    rotateTransport,
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
