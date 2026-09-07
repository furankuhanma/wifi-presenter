// ============================================================
// db.js
// ============================================================
// A single shared MySQL connection pool, used by auth.js (and
// later, whatever reads/writes XP/badges/quiz progress).
//
// A pool (rather than one long-lived connection) means multiple
// requests can talk to the DB at once without waiting on each
// other, and it automatically reconnects if a connection drops.
// ============================================================

require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "wifi_presentation",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;