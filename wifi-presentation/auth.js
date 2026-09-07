// ============================================================
// auth.js
// ============================================================
// Signup / login for participants, backed by MySQL.
//
// Passwords: hashed with bcrypt before ever touching the
// database -- the plain password is never stored anywhere.
//
// Sessions: JWTs. On successful signup/login we hand back a
// signed token; the client stores it (e.g. localStorage) and
// sends it back as "Authorization: Bearer <token>" on requests
// that need to know who's asking, or as socket.handshake.auth.token
// when opening a Socket.IO connection (see server.js's io.use()
// middleware, which calls verifyToken() below).
//
// NOTE ON SCOPE: this file only handles identity (accounts +
// sessions). It does not yet touch XP/levels/badges/quiz
// results -- `user_progress` rows are created with defaults at
// signup so the data model is ready, but nothing reads/writes
// real progress yet. That's an intentionally separate next step.
// ============================================================

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = "7d";
const SALT_ROUNDS = 10;

// Keep usernames simple and URL/JS-safe: 3-30 chars, letters/
// numbers/underscores only.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;

if (!JWT_SECRET) {
  console.warn(
    "[auth] WARNING: JWT_SECRET is not set in .env. Using a random " +
      "in-memory secret for this run -- all existing sessions will be " +
      "invalidated every time the server restarts. Set JWT_SECRET in " +
      ".env for real use."
  );
}
const EFFECTIVE_SECRET =
  JWT_SECRET || require("crypto").randomBytes(32).toString("hex");

function validateCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return "Username and password are required.";
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-30 characters (letters, numbers, underscores only).";
  }
  if (password.length < 6) {
    return "Password must be at least 6 characters.";
  }
  return null;
}

function issueToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    EFFECTIVE_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// --------------------------------------------------------
// POST /api/auth/signup  { username, password }
// --------------------------------------------------------
router.post("/signup", async (req, res) => {
  const { username, password } = req.body || {};
  const validationError = validateCredentials(username, password);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [existing] = await connection.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "That username is already taken." });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await connection.beginTransaction();
    const [result] = await connection.query(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, passwordHash]
    );
    const userId = result.insertId;

    await connection.query(
      `INSERT INTO user_progress (user_id, xp, level, badges, quiz_results)
       VALUES (?, 0, 1, JSON_ARRAY(), JSON_ARRAY())`,
      [userId]
    );
    await connection.commit();

    const token = issueToken({ id: userId, username });
    console.log(`[auth] new account created: ${username} (id ${userId})`);
    res.status(201).json({ token, username });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
        /* ignore rollback failure */
      }
    }
    console.error("[auth] signup error:", err);
    res.status(500).json({ error: "Something went wrong creating your account." });
  } finally {
    if (connection) connection.release();
  }
});

// --------------------------------------------------------
// POST /api/auth/login  { username, password }
// --------------------------------------------------------
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE username = ?",
      [username]
    );
    if (rows.length === 0) {
      // Same error for "no such user" and "wrong password" so we
      // don't leak which usernames exist.
      return res.status(401).json({ error: "Incorrect username or password." });
    }

    const user = rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }

    const token = issueToken(user);
    console.log(`[auth] ${user.username} logged in.`);
    res.json({ token, username: user.username });
  } catch (err) {
    console.error("[auth] login error:", err);
    res.status(500).json({ error: "Something went wrong logging you in." });
  }
});

// --------------------------------------------------------
// Middleware: verifies "Authorization: Bearer <token>" (HTTP
// requests) and attaches { userId, username } to req.user. Use
// this to protect any future route that requires being logged in.
// --------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }

  try {
    req.user = jwt.verify(token, EFFECTIVE_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
}

// --------------------------------------------------------
// GET /api/auth/me  (requires auth)
// Handy for testing the DB design end-to-end: proves a token maps
// back to a real user + their (currently empty) progress row. Also
// used by viewer-auth.js on page load to check a saved token is
// still valid before trusting it.
// --------------------------------------------------------
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.username, p.xp, p.level, p.badges, p.quiz_results
       FROM users u
       JOIN user_progress p ON p.user_id = u.id
       WHERE u.id = ?`,
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("[auth] /me error:", err);
    res.status(500).json({ error: "Could not load profile." });
  }
});

// --------------------------------------------------------
// Used by server.js's Socket.IO middleware (io.use(...)) to
// verify a viewer's token BEFORE letting their socket connection
// through at all -- this is the piece that actually enforces
// "no login, no presentation," since it runs server-side and
// can't be bypassed by editing client-side JS.
//
// Throws if the token is missing/invalid/expired -- server.js
// wraps this in try/catch and rejects the connection on failure.
// --------------------------------------------------------
function verifyToken(token) {
  return jwt.verify(token, EFFECTIVE_SECRET);
}

module.exports = { router, requireAuth, verifyToken };