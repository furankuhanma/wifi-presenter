// ============================================================
// server.js
// ============================================================
// This is the "brain" of the whole application.
//
// It does 5 main jobs now:
//   1. Serves the HTML/CSS/JS files to browsers (Express).
//   2. Keeps track of the ONE "official" current slide number.
//   3. Talks to every connected phone/laptop in real time (Socket.IO).
//   4. Makes sure only the presenter (who knows the PIN) can
//      change slides.
//   5. NEW: Runs live interactive Quizzes -- the presenter launches
//      a question, every connected viewer gets it at the same
//      instant, answers are graded server-side, XP/levels update
//      in the database, and the presenter sees live status plus a
//      results/leaderboard screen after each quiz.
//
// IMPORTANT CONCEPT:
// No phone ever decides the slide (or a quiz's correct answer) on
// its own. Every device just displays whatever the SERVER says,
// and every answer is graded by the SERVER. This is why late
// joiners always show correctly, and why nobody can cheat by
// editing their own browser's JS.
// ============================================================

require("dotenv").config(); // Loads variables from your .env file

const fs = require("fs");
const express = require("express");
const http = require("http");
const os = require("os"); // Built into Node.js -- used to find your local IP
const path = require("path");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const { startDnsServer } = require("./dns-server");
const authRoutes = require("./auth"); // signup/login routes + verifyToken
const pool = require("./db"); // NEW: needed here directly for XP/quiz writes

const app = express();
const server = http.createServer(app);
const io = new Server(server); // Attach Socket.IO to the same server

// ------------------------------------------------------------
// CONFIG (from .env, with safe fallback defaults)
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const PRESENTER_PIN = process.env.PRESENTER_PIN || "1234";
const DNS_PORT = process.env.DNS_PORT || 53;
const IMAGES_DIR = path.join(__dirname, "public", "images");
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null; // NEW, optional (for AI-generated quiz questions)

// ------------------------------------------------------------
// SLIDE IMAGE DISCOVERY
// ------------------------------------------------------------
function loadSlideImages() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.warn(`Warning: ${IMAGES_DIR} does not exist. No slides to show.`);
    return [];
  }

  const slideFilePattern = /^(?:slide-(\d+)|(\d+))\.(png|jpe?g|webp)$/i;

  const found = fs
    .readdirSync(IMAGES_DIR)
    .map((filename) => {
      const match = filename.match(slideFilePattern);
      if (!match) return null;
      const number = parseInt(match[1] ?? match[2], 10);
      return { filename, number };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);

  if (found.length === 0) {
    console.warn(
      `Warning: no files matching "slide-<number>.(png|jpg|jpeg|webp)" or ` +
        `"<number>.(png|jpg|jpeg|webp)" found in ${IMAGES_DIR}.\n` +
        `Expected e.g. slide-1.png / 1.png, slide-2.png / 2.png, ...`
    );
  }

  const seenNumbers = new Map();
  for (const f of found) {
    if (seenNumbers.has(f.number)) {
      console.warn(
        `Warning: both "${seenNumbers.get(f.number)}" and "${f.filename}" ` +
          `map to slide ${f.number}. Using "${f.filename}" (the last one found).`
      );
    }
    seenNumbers.set(f.number, f.filename);
  }

  return found.map((f) => `/images/${f.filename}`);
}

let slideImages = loadSlideImages();

// ------------------------------------------------------------
// LOCAL IP DETECTION
// ------------------------------------------------------------
function scoreCandidate(name, address) {
  const lowerName = name.toLowerCase();
  const isNamedLikeRealAdapter = /(wi-?fi|wlan|ethernet|en0|eth0)/i.test(lowerName);
  const isNamedLikeVirtualAdapter = /(wsl|vethernet|virtual|vmware|virtualbox|docker|loopback|hyper-v)/i.test(
    lowerName
  );

  const octets = address.split(".").map(Number);
  const in192168 = octets[0] === 192 && octets[1] === 168;
  const in10 = octets[0] === 10;
  const in172Private = octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;

  let score = 0;
  if (isNamedLikeRealAdapter) score += 100;
  if (isNamedLikeVirtualAdapter) score -= 100;
  if (in192168 || in10) score += 20;
  if (in172Private) score -= 20;
  return score;
}

function getLocalIPAddress() {
  if (process.env.HOST_IP) {
    return process.env.HOST_IP;
  }

  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  if (candidates.length === 0) return "localhost";

  candidates.sort(
    (a, b) => scoreCandidate(b.name, b.address) - scoreCandidate(a.name, a.address)
  );

  if (candidates.length > 1) {
    console.log("Multiple network adapters detected, picked the best guess:");
    candidates.forEach((c, i) => {
      console.log(`  ${i === 0 ? "-> " : "   "}${c.name}: ${c.address}`);
    });
    console.log("If that's wrong, set HOST_IP in your .env to override it.");
  }

  return candidates[0].address;
}

const LOCAL_IP = getLocalIPAddress();
const STUDENT_URL = `http://${LOCAL_IP}:${PORT}`;

// ------------------------------------------------------------
// PORT 80 REDIRECT (so people can skip typing ":3000")
// ------------------------------------------------------------
if (PORT !== 80) {
  const redirectServer = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://${LOCAL_IP}:${PORT}${req.url}` });
    res.end();
  });

  redirectServer.on("error", (err) => {
    console.error("[redirect] Could not start port-80 redirect server:", err.message);
    console.error(
      "[redirect] This just means people will need to type the port (e.g. http://presentation:3000). Nothing else is affected."
    );
  });

  redirectServer.listen(80, () => {
    console.log(`[redirect] Port 80 -> ${STUDENT_URL} redirect active (no ":${PORT}" needed).`);
  });
}

// ------------------------------------------------------------
// LOCAL DNS SERVER (captive portal, step 1)
// ------------------------------------------------------------
let dnsServer = null;
try {
  dnsServer = startDnsServer(LOCAL_IP, DNS_PORT);
  dnsServer.on("error", (err) => {
    console.error("[dns] Failed to start local DNS server:", err.message);
    console.error(
      "[dns] Captive-portal auto-redirect will not work, but the presentation itself will still run fine."
    );
    if (DNS_PORT < 1024) {
      console.error(
        "[dns] On macOS/Linux this usually means you need to run with sudo, or set DNS_PORT=5353 in .env."
      );
    }
  });
} catch (err) {
  console.error("[dns] Failed to start local DNS server:", err.message);
  console.error(
    "[dns] Captive-portal auto-redirect will not work, but the presentation itself will still run fine."
  );
  console.error(
    "[dns] On macOS/Linux this usually means you need to run with sudo, or set DNS_PORT=5353 in .env."
  );
}

// ------------------------------------------------------------
// SERVER-SIDE STATE
// ------------------------------------------------------------
let currentSlideIndex = 0;

const authenticatedPresenters = new Set();
let viewerCount = 0;

// Track authenticated viewer sockets by userId so we know who is
// actually present / can be graded for a quiz (as opposed to
// someone who is connected but not logged in -- shouldn't happen
// given the auth gate, but this keeps quiz code defensive).
const viewerSocketsByUserId = new Map(); // userId -> Set of socket.id

// ------------------------------------------------------------
// CAPTIVE PORTAL — "signed in" tracking (Step 2)
// ------------------------------------------------------------
const signedInIPs = new Set();

function normalizeClientIP(req) {
  const raw = req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

function isSignedIn(req) {
  return signedInIPs.has(normalizeClientIP(req));
}

function markSignedIn(req) {
  const ip = normalizeClientIP(req);
  const alreadySignedIn = signedInIPs.has(ip);
  signedInIPs.add(ip);
  if (!alreadySignedIn) {
    console.log(`[portal] ${ip} signed in -- captive prompt will not repeat this session.`);
  }
}

// ------------------------------------------------------------
// WHITEBOARD STATE (Step 1 -- backend only, no UI yet)
// ------------------------------------------------------------
let whiteboardActive = false;
let whiteboardObjects = [];

function sendWhiteboardStateTo(socket) {
  socket.emit("whiteboard-state", {
    active: whiteboardActive,
    objects: whiteboardObjects,
  });
}

function broadcastWhiteboardState() {
  io.emit("whiteboard-state", {
    active: whiteboardActive,
    objects: whiteboardObjects,
  });
}

// ------------------------------------------------------------
// QUIZ STATE (NEW)
// ------------------------------------------------------------
// One quiz is "live" at a time. Shape:
//
// quizState = {
//   id: string,
//   question: string,
//   type: "multiple_choice" | "true_false" | "identification",
//   options: string[] | null,     // null for identification
//   correctAnswer: string,        // never sent to viewers while active
//   xp: number,
//   difficulty: "easy" | "medium" | "hard",
//   timeLimit: number | null,     // seconds, null = untimed
//   startedAt: number,            // Date.now() ms
//   active: boolean,
//   responses: Map<userId, { username, answer, correct, timeMs, xpAwarded }>
// }
let quizState = null;
let quizTimer = null;

const VALID_QUIZ_TYPES = new Set(["multiple_choice", "true_false", "identification"]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

// ------------------------------------------------------------
// BADGES (NEW)
// ------------------------------------------------------------
const BADGE_DEFINITIONS = {
  good_listener:   { name: "Good Listener", icon: "👂", rarity: "Rare" },
  on_fire:         { name: "On Fire", icon: "🔥", rarity: "Rare" },
  brainstorm:      { name: "Brainstorm", icon: "🧠", rarity: "Epic" },
  perfect_run:     { name: "Perfect Run", icon: "💎", rarity: "Legendary" },
  lightning:       { name: "Lightning", icon: "⚡", rarity: "Rare" },
  perfect_shot:    { name: "Perfect Shot", icon: "🎯", rarity: "Epic" },
  bright_mind:     { name: "Bright Mind", icon: "💡", rarity: "Common" },
  first_step:      { name: "First Step", icon: "🙋", rarity: "Common" },
  dedicated:       { name: "Dedicated", icon: "📚", rarity: "Rare" },
  until_the_end:   { name: "Until the End", icon: "⏳", rarity: "Rare" },
  fast_starter:    { name: "Fast Starter", icon: "🚀", rarity: "Common" },
  comeback:        { name: "Comeback", icon: "🏅", rarity: "Epic" },
  quiz_warrior:    { name: "Quiz Warrior", icon: "💎", rarity: "Epic" },
};

// Dynamic badges are computed live from current rank -- never
// stored in the DB, always recalculated on every leaderboard push.
function dynamicBadgeForRank(rank) {
  if (rank === 1) return { id: "genius", name: "Genius", icon: "🧠", rarity: "Legendary" };
  if (rank === 2) return { id: "diligent", name: "Diligent", icon: "🔥", rarity: "Epic" };
  return { id: "lowkey", name: "Lowkey", icon: "🥷", rarity: "Common" };
}
const BULAKBOL_BADGE = { id: "bulakbol", name: "Bulakbol", icon: "💤", rarity: "Lowest" };

let totalQuizzesLaunched = 0;
const COMEBACK_RANK_IMPROVEMENT_THRESHOLD = 3; // positions
const QUIZ_WARRIOR_CORRECT_THRESHOLD = 10; // total correct answers
const FAST_STARTER_CUTOFF = 3; // among first N responders of a quiz

// Awards a permanent badge to a user if they don't already have it.
// Safe to call repeatedly -- it's a no-op if already earned.
async function awardBadge(userId, badgeId) {
  const def = BADGE_DEFINITIONS[badgeId];
  if (!def) return;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT badges FROM user_progress WHERE user_id = ? FOR UPDATE",
      [userId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return;
    }

    const existing = Array.isArray(rows[0].badges) ? rows[0].badges : [];
    if (existing.some((b) => b.id === badgeId)) {
      await connection.rollback();
      return; // already earned
    }

    const newBadge = {
      id: badgeId,
      name: def.name,
      icon: def.icon,
      rarity: def.rarity,
      earnedAt: new Date().toISOString(),
    };
    const updatedBadges = [...existing, newBadge];

    await connection.query("UPDATE user_progress SET badges = ? WHERE user_id = ?", [
      JSON.stringify(updatedBadges),
      userId,
    ]);
    await connection.commit();

    // Notify the user's connected device(s) so the UI can play an
    // unlock animation.
    const socketIds = viewerSocketsByUserId.get(userId);
    if (socketIds) {
      for (const sid of socketIds) {
        io.to(sid).emit("badge-unlocked", newBadge);
      }
    }
    console.log(`[badges] awarded "${badgeId}" to user ${userId}`);
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[badges] award error:", err);
  } finally {
    connection.release();
  }
}

function levelForXp(xp) {
  // Simple, tweakable leveling curve: 100 XP per level.
  return Math.floor(xp / 100) + 1;
}

function normalizeAnswerForCompare(value) {
  return String(value ?? "").trim().toLowerCase();
}

function gradeAnswer(quiz, rawAnswer) {
  if (quiz.type === "identification") {
    // Accept a "|" separated list of acceptable answers in
    // correctAnswer, e.g. "op-amp|operational amplifier".
    const accepted = String(quiz.correctAnswer)
      .split("|")
      .map((s) => normalizeAnswerForCompare(s));
    return accepted.includes(normalizeAnswerForCompare(rawAnswer));
  }
  // multiple_choice and true_false: exact match on the option string
  return normalizeAnswerForCompare(rawAnswer) === normalizeAnswerForCompare(quiz.correctAnswer);
}

function currentViewerTotal() {
  // Only authenticated (logged-in) viewers can participate in a
  // quiz and count toward "total". The presenter console itself
  // never counts here.
  let total = 0;
  for (const set of viewerSocketsByUserId.values()) {
    if (set.size > 0) total++;
  }
  return total;
}

function broadcastQuizLiveStatus() {
  if (!quizState) return;
  const responded = quizState.responses.size;
  const correctCount = [...quizState.responses.values()].filter((r) => r.correct).length;
  const feed = [...quizState.responses.entries()]
    .sort((a, b) => a[1].timeMs - b[1].timeMs)
    .map(([userId, r]) => ({
      username: r.username,
      correct: r.correct,
      timeMs: r.timeMs,
    }));

  io.to("presenters").emit("quiz-live-status", {
    quizId: quizState.id,
    responded,
    total: currentViewerTotal(),
    correctCount,
    feed,
  });
}

// Persists one user's quiz result to the database: bumps xp/level,
// updates streak/participation/rank-tracking columns for badges,
// and appends a small record to their quiz_results JSON history.
// Returns enough info for the caller to decide which badges to award.
async function persistQuizResultForUser(userId, resultEntry, xpAwarded, correct) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT xp, quiz_results, current_streak, best_streak, quizzes_participated
       FROM user_progress WHERE user_id = ? FOR UPDATE`,
      [userId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return null;
    }

    const row = rows[0];
    const previousXp = row.xp || 0;
    const previousResults = Array.isArray(row.quiz_results) ? row.quiz_results : [];
    const previousStreak = row.current_streak || 0;
    const previousBestStreak = row.best_streak || 0;
    const previousParticipated = row.quizzes_participated || 0;
    const previousCorrectCount = previousResults.filter((r) => r.correct).length;
    const previousIncorrectCount = previousResults.filter((r) => !r.correct).length;

    const newXp = previousXp + xpAwarded;
    const newLevel = levelForXp(newXp);
    const newResults = [...previousResults, resultEntry].slice(-200); // cap history length
    const newStreak = correct ? previousStreak + 1 : 0;
    const newBestStreak = Math.max(previousBestStreak, newStreak);
    const newParticipated = previousParticipated + 1;

    await connection.query(
      `UPDATE user_progress
       SET xp = ?, level = ?, quiz_results = ?, current_streak = ?, best_streak = ?, quizzes_participated = ?
       WHERE user_id = ?`,
      [newXp, newLevel, JSON.stringify(newResults), newStreak, newBestStreak, newParticipated, userId]
    );

    await connection.commit();

    return {
      xp: newXp,
      level: newLevel,
      newStreak,
      newBestStreak,
      newParticipated,
      isFirstQuiz: previousParticipated === 0,
      isFirstCorrect: correct && previousCorrectCount === 0,
      totalCorrectCount: previousCorrectCount + (correct ? 1 : 0),
      totalIncorrectCount: previousIncorrectCount + (correct ? 0 : 1),
    };
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[quiz] failed to persist result for user", userId, err);
    return null;
  } finally {
    connection.release();
  }
}

function clearQuizTimer() {
  if (quizTimer) {
    clearTimeout(quizTimer);
    quizTimer = null;
  }
}

function endQuiz() {
  if (!quizState || !quizState.active) return;
  quizState.active = false;
  clearQuizTimer();

  const responses = [...quizState.responses.entries()].map(([userId, r]) => ({
    userId,
    username: r.username,
    answer: r.answer,
    correct: r.correct,
    timeMs: r.timeMs,
    xpAwarded: r.xpAwarded,
  }));

  const total = currentViewerTotal();
  const respondedCount = responses.length;
  const correctResponses = responses.filter((r) => r.correct);
  const accuracy = respondedCount > 0 ? correctResponses.length / respondedCount : 0;

  const fastest = correctResponses.slice().sort((a, b) => a.timeMs - b.timeMs).slice(0, 5);

  // Leaderboard for this quiz: correct answers first (fastest
  // first), then incorrect answers (fastest first), then anyone
  // who never answered.
  const answeredUserIds = new Set(responses.map((r) => r.userId));
  const notAnswered = [];
  for (const [userId, set] of viewerSocketsByUserId.entries()) {
    if (set.size > 0 && !answeredUserIds.has(userId)) {
      notAnswered.push({ userId, username: null });
    }
  }

  const leaderboard = [
    ...correctResponses.slice().sort((a, b) => a.timeMs - b.timeMs),
    ...responses.filter((r) => !r.correct).sort((a, b) => a.timeMs - b.timeMs),
  ].map((r, i) => ({ rank: i + 1, ...r }));

  const resultsPayload = {
    quizId: quizState.id,
    question: quizState.question,
    correctAnswer: quizState.correctAnswer,
    total,
    responded: respondedCount,
    notAnswered: notAnswered.length,
    accuracy,
    fastest,
    leaderboard,
  };

  // Badge checks that need the full set of responses for this quiz.
  if (correctResponses.length === 1 && respondedCount > 1) {
    awardBadge(correctResponses[0].userId, "good_listener");
  }
  if (correctResponses.length > 0) {
    const fastestCorrect = correctResponses.slice().sort((a, b) => a.timeMs - b.timeMs)[0];
    awardBadge(fastestCorrect.userId, "lightning");
  }
  for (const [userId, set] of viewerSocketsByUserId.entries()) {
    if (set.size === 0) continue;
    pool
      .query("SELECT quizzes_participated FROM user_progress WHERE user_id = ?", [userId])
      .then(([rows]) => {
        if (rows.length && rows[0].quizzes_participated >= totalQuizzesLaunched) {
          awardBadge(userId, "dedicated");
        }
      })
      .catch((err) => console.error("[badges] dedicated check error:", err));
  }

  io.to("presenters").emit("quiz-results", resultsPayload);

  // Let every viewer know the quiz is over (so late-answer UI can
  // relax, and anyone who didn't answer sees the correct answer).
  io.to("viewers").emit("quiz-ended", {
    quizId: quizState.id,
    correctAnswer: quizState.correctAnswer,
  });

  console.log(
    `[quiz] ended "${quizState.question}" -- ${respondedCount}/${total} responded, ` +
      `${(accuracy * 100).toFixed(0)}% accuracy.`
  );
}

function launchQuiz(config) {
  clearQuizTimer();
  totalQuizzesLaunched++;

  const id = `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  quizState = {
    id,
    question: config.question,
    type: config.type,
    options: config.type === "identification" ? null : config.options,
    correctAnswer: config.correctAnswer,
    xp: config.xp,
    difficulty: config.difficulty,
    timeLimit: config.timeLimit || null,
    startedAt: Date.now(),
    active: true,
    responses: new Map(),
  };

  // What viewers get -- notably, NEVER the correct answer.
  const viewerPayload = {
    quizId: quizState.id,
    question: quizState.question,
    type: quizState.type,
    options: quizState.options,
    xp: quizState.xp,
    difficulty: quizState.difficulty,
    timeLimit: quizState.timeLimit,
    startedAt: quizState.startedAt,
  };

  io.to("viewers").emit("quiz-question", viewerPayload);
  broadcastQuizLiveStatus();

  console.log(`[quiz] launched "${quizState.question}" (${quizState.type}, ${quizState.difficulty}).`);

  if (quizState.timeLimit) {
    quizTimer = setTimeout(() => {
      endQuiz();
    }, quizState.timeLimit * 1000);
  }
}

// ------------------------------------------------------------
// LEADERBOARD + DYNAMIC BADGES (NEW)
// ------------------------------------------------------------
// Fetches ALL users ranked by XP (not just the public top 20) so
// we can compute an accurate rank for every connected viewer,
// then: (a) broadcasts the public top-20 leaderboard, and
// (b) sends each connected viewer their own rank + dynamic badge +
// their current permanent badges, updating first_rank/best_rank
// along the way for the Comeback badge.
async function broadcastLeaderboardUpdate() {
  try {
    const [rows] = await pool.query(
      `SELECT u.id AS userId, u.username, p.xp, p.level, p.first_rank, p.best_rank, p.badges
       FROM users u JOIN user_progress p ON p.user_id = u.id
       ORDER BY p.xp DESC`
    );

    const top20 = rows.slice(0, 20).map((row, i) => {
      const rank = i + 1;
      let permanent = [];
      try {
        permanent = Array.isArray(row.badges) ? row.badges : (row.badges ? JSON.parse(row.badges) : []);
      } catch (e) {
        permanent = [];
      }
      return {
        rank,
        username: row.username,
        xp: row.xp,
        level: row.level,
        dynamicBadge: dynamicBadgeForRank(rank),
        permanentBadges: permanent,
      };
    });
    io.to("viewers").emit("leaderboard-update", top20);

    // Per-connected-viewer rank + dynamic badge + Comeback check.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rank = i + 1;
      const socketIds = viewerSocketsByUserId.get(row.userId);
      if (!socketIds || socketIds.size === 0) continue; // not connected

      const dynamicBadge = dynamicBadgeForRank(rank);
      const payload = {
        rank,
        totalRanked: rows.length,
        dynamicBadge,
        permanentBadges: Array.isArray(row.badges) ? row.badges : [],
      };
      for (const sid of socketIds) {
        io.to(sid).emit("your-rank-update", payload);
      }

      const newFirstRank = row.first_rank == null ? rank : row.first_rank;
      const newBestRank = row.best_rank == null ? rank : Math.min(row.best_rank, rank);

      if (row.first_rank == null || row.best_rank == null || newBestRank !== row.best_rank) {
        pool
          .query("UPDATE user_progress SET first_rank = ?, best_rank = ? WHERE user_id = ?", [
            newFirstRank,
            newBestRank,
            row.userId,
          ])
          .catch((err) => console.error("[badges] rank update error:", err));
      }

      if (row.first_rank != null && row.first_rank - rank >= COMEBACK_RANK_IMPROVEMENT_THRESHOLD) {
        awardBadge(row.userId, "comeback");
      }
    }
  } catch (err) {
    console.error("[leaderboard] broadcast error:", err);
  }
}

// ------------------------------------------------------------
// HELPER FUNCTIONS
// ------------------------------------------------------------

function clampSlideIndex(index) {
  if (index < 0) return 0;
  if (index > slideImages.length - 1) return Math.max(0, slideImages.length - 1);
  return index;
}

function sendCurrentSlideTo(socket) {
  socket.emit("slide-update", {
    index: currentSlideIndex,
    total: slideImages.length,
    image: slideImages[currentSlideIndex] || null,
  });
}

function broadcastCurrentSlide() {
  io.emit("slide-update", {
    index: currentSlideIndex,
    total: slideImages.length,
    image: slideImages[currentSlideIndex] || null,
  });
}

function broadcastViewerCount() {
  io.emit("viewer-count", viewerCount);
}

// ------------------------------------------------------------
// EXPRESS SETUP (serving the frontend files)
// ------------------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function validateTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return null;
  try {
    return authRoutes.verifyToken(match[1]);
  } catch (err) {
    return null;
  }
}

app.get("/", (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(" ")[1];

  if (token) {
    try {
      authRoutes.verifyToken(token);
      return res.redirect(`/viewer?token=${encodeURIComponent(token)}`);
    } catch (err) {
      // fall through to login
    }
  }

  res.redirect("/login");
});

app.get("/viewer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

app.get("/presenter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.use("/api/auth", authRoutes.router);

// ------------------------------------------------------------
// QUIZ: AI QUESTION GENERATION (NEW)
// ------------------------------------------------------------
// POST /api/quiz/generate  { topic, type, difficulty }
// Presenter-only in practice (gated by the presenter console UI),
// but this is a stateless helper endpoint -- it doesn't touch
// quizState at all, it just returns a suggested question for the
// presenter to review/edit before launching. If ANTHROPIC_API_KEY
// isn't configured, it returns a clear error so the UI can fall
// back to manual entry instead of hanging.
app.post("/api/quiz/generate", async (req, res) => {
  const { topic, type, difficulty } = req.body || {};

  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error:
        "AI question generation isn't configured on this server. Set ANTHROPIC_API_KEY in .env, or create the question manually.",
    });
  }
  if (!VALID_QUIZ_TYPES.has(type)) {
    return res.status(400).json({ error: "Invalid question type." });
  }
  if (!VALID_DIFFICULTIES.has(difficulty)) {
    return res.status(400).json({ error: "Invalid difficulty." });
  }

  const typeInstructions = {
    multiple_choice:
      'Return "options" as an array of exactly 4 short answer strings, and "correctAnswer" as the exact text of the correct option (must match one entry in "options" exactly).',
    true_false:
      'Return "options" as ["True", "False"], and "correctAnswer" as exactly "True" or "False".',
    identification:
      'Do not return "options" (omit it or set it to null). Return "correctAnswer" as the single best short answer (a few words at most).',
  };

  const systemPrompt =
    "You are a quiz-question generator for a live classroom presentation tool. " +
    "Respond with ONLY raw JSON, no markdown fences, no preamble. " +
    'The JSON object must have exactly these keys: "question" (string), "options" (array of strings or null), "correctAnswer" (string).';

  const userPrompt =
    `Topic: ${topic || "the current lesson"}\n` +
    `Difficulty: ${difficulty}\n` +
    `Question type: ${type}\n` +
    `${typeInstructions[type]}\n` +
    "Keep the question concise and unambiguous, appropriate for a live in-class quiz.";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[quiz-ai] Anthropic API error:", response.status, errText);
      return res.status(502).json({ error: "AI generation failed. Please write the question manually." });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "AI returned no usable content." });
    }

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("[quiz-ai] Could not parse AI JSON:", cleaned);
      return res.status(502).json({ error: "AI response wasn't valid JSON. Please write the question manually." });
    }

    res.json({
      question: parsed.question,
      options: parsed.options || null,
      correctAnswer: parsed.correctAnswer,
    });
  } catch (err) {
    console.error("[quiz-ai] request failed:", err);
    res.status(502).json({ error: "Could not reach the AI service." });
  }
});

// ------------------------------------------------------------
// CAPTIVE PORTAL — landing page + OS probe routes (Step 2)
// ------------------------------------------------------------
const PORTAL_URL = `http://${LOCAL_IP}:${PORT}/portal`;

app.get("/portal", (req, res) => {
  markSignedIn(req);
  res.sendFile(path.join(__dirname, "public", "portal.html"));
});

app.get(["/hotspot-detect.html", "/library/test/success.html"], (req, res) => {
  if (isSignedIn(req)) {
    res
      .type("html")
      .send("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  } else {
    res.sendFile(path.join(__dirname, "public", "portal.html"));
  }
});

app.get(["/generate_204", "/gen_204"], (req, res) => {
  if (isSignedIn(req)) {
    res.status(204).end();
  } else {
    res.redirect(302, PORTAL_URL);
  }
});

app.get("/connecttest.txt", (req, res) => {
  if (isSignedIn(req)) {
    res.type("txt").send("Microsoft Connect Test");
  } else {
    res.redirect(302, PORTAL_URL);
  }
});

app.get("/ncsi.txt", (req, res) => {
  if (isSignedIn(req)) {
    res.type("txt").send("Microsoft NCSI");
  } else {
    res.redirect(302, PORTAL_URL);
  }
});

app.get("/api/config", (req, res) => {
  res.json({
    studentUrl: STUDENT_URL,
    totalSlides: slideImages.length,
  });
});

app.post("/api/reload-slides", (req, res) => {
  slideImages = loadSlideImages();
  currentSlideIndex = clampSlideIndex(currentSlideIndex);
  broadcastCurrentSlide();
  res.json({ totalSlides: slideImages.length });
});

app.get("/api/qr.png", async (req, res) => {
  try {
    const qrBuffer = await QRCode.toBuffer(STUDENT_URL, {
      width: 240,
      margin: 1,
    });
    res.type("png").send(qrBuffer);
  } catch (err) {
    console.error("Failed to generate QR code:", err);
    res.status(500).send("Could not generate QR code.");
  }
});

// GET /api/leaderboard -- overall (all-time) XP leaderboard, used
// by the presenter's Quiz results panel alongside the per-quiz
// leaderboard.
app.get("/api/leaderboard", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.username, p.xp, p.level
       FROM users u JOIN user_progress p ON p.user_id = u.id
       ORDER BY p.xp DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error("[leaderboard] error:", err);
    res.status(500).json({ error: "Could not load leaderboard." });
  }
});

// ------------------------------------------------------------
// SOCKET.IO AUTH GATE
// ------------------------------------------------------------
io.use((socket, next) => {
  const handshakeAuth = socket.handshake.auth || {};

  if (handshakeAuth.role === "presenter") {
    return next();
  }

  const token = handshakeAuth.token;
  if (!token) {
    return next(new Error("AUTH_REQUIRED"));
  }

  try {
    socket.user = authRoutes.verifyToken(token);
    return next();
  } catch (err) {
    return next(new Error("AUTH_REQUIRED"));
  }
});

// ------------------------------------------------------------
// SOCKET.IO — REAL-TIME LOGIC
// ------------------------------------------------------------

io.on("connection", (socket) => {
  viewerCount++;
  broadcastViewerCount();

  const isPresenterSocket = socket.handshake.auth && socket.handshake.auth.role === "presenter";

  if (!isPresenterSocket && socket.user) {
    socket.join("viewers");
    const userId = socket.user.userId;
    if (!viewerSocketsByUserId.has(userId)) {
      viewerSocketsByUserId.set(userId, new Set());
    }
    viewerSocketsByUserId.get(userId).add(socket.id);
  }

  console.log(`[connect] ${socket.id} connected. Viewers: ${viewerCount}`);

  sendCurrentSlideTo(socket);
  sendWhiteboardStateTo(socket);

  if (!isPresenterSocket && socket.user) broadcastLeaderboardUpdate();

  // Catch late joiners up on a quiz already in progress.
  if (quizState && quizState.active && socket.rooms.has("viewers")) {
    socket.emit("quiz-question", {
      quizId: quizState.id,
      question: quizState.question,
      type: quizState.type,
      options: quizState.options,
      xp: quizState.xp,
      difficulty: quizState.difficulty,
      timeLimit: quizState.timeLimit,
      startedAt: quizState.startedAt,
    });
  }

  socket.on("presenter-auth", (pin) => {
    if (pin === PRESENTER_PIN) {
      authenticatedPresenters.add(socket.id);
      socket.join("presenters");
      viewerCount = Math.max(0, viewerCount - 1);
      broadcastViewerCount();
      socket.emit("auth-result", { success: true });
      console.log(`[auth] ${socket.id} authenticated as presenter.`);

      // Bring a (re)connecting presenter up to speed on any quiz
      // already in progress or the most recently finished one.
      if (quizState) {
        broadcastQuizLiveStatus();
      }
    } else {
      socket.emit("auth-result", {
        success: false,
        message: "Incorrect PIN. Please try again.",
      });
      console.log(`[auth] ${socket.id} failed presenter authentication.`);
    }
  });

  function isAuthenticatedPresenter() {
    return authenticatedPresenters.has(socket.id);
  }

  socket.on("next-slide", () => {
    if (!isAuthenticatedPresenter()) return;
    currentSlideIndex = clampSlideIndex(currentSlideIndex + 1);
    broadcastCurrentSlide();
  });

  socket.on("prev-slide", () => {
    if (!isAuthenticatedPresenter()) return;
    currentSlideIndex = clampSlideIndex(currentSlideIndex - 1);
    broadcastCurrentSlide();
  });

  socket.on("goto-slide", (index) => {
    if (!isAuthenticatedPresenter()) return;
    const parsedIndex = parseInt(index, 10);
    if (Number.isNaN(parsedIndex)) return;
    currentSlideIndex = clampSlideIndex(parsedIndex);
    broadcastCurrentSlide();
  });

  socket.on("reset-slide", () => {
    if (!isAuthenticatedPresenter()) return;
    currentSlideIndex = 0;
    broadcastCurrentSlide();
  });

  // Presenter explicitly ends the presentation -- award "Until the
  // End" to everyone still connected right now.
  socket.on("end-presentation", () => {
    if (!isAuthenticatedPresenter()) return;
    for (const [userId, set] of viewerSocketsByUserId.entries()) {
      if (set.size > 0) awardBadge(userId, "until_the_end");
    }
    io.to("viewers").emit("presentation-ended");
    console.log(`[presentation] ended by ${socket.id}.`);
  });

  // ------------------------------------------------------------
  // WHITEBOARD EVENTS
  // ------------------------------------------------------------

  socket.on("toggle-whiteboard", (active) => {
    if (!isAuthenticatedPresenter()) return;
    whiteboardActive = Boolean(active);
    broadcastWhiteboardState();
    console.log(`[whiteboard] ${whiteboardActive ? "activated" : "deactivated"} by ${socket.id}.`);
  });

  socket.on("add-whiteboard-object", (object) => {
    if (!isAuthenticatedPresenter()) return;
    if (!object || typeof object !== "object") return;

    const stored = {
      ...object,
      id: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    whiteboardObjects.push(stored);
    io.emit("whiteboard-object-added", stored);
  });

  socket.on("clear-whiteboard", () => {
    if (!isAuthenticatedPresenter()) return;
    whiteboardObjects = [];
    io.emit("whiteboard-cleared");
    console.log(`[whiteboard] cleared by ${socket.id}.`);
  });

  // ------------------------------------------------------------
  // QUIZ EVENTS (NEW)
  // ------------------------------------------------------------

  // Presenter launches a quiz. Payload:
  // { question, type, options, correctAnswer, xp, difficulty, timeLimit }
  socket.on("quiz-launch", (config) => {
    if (!isAuthenticatedPresenter()) return;
    if (!config || typeof config !== "object") return;

    const question = String(config.question || "").trim();
    const type = config.type;
    const difficulty = config.difficulty;
    const xp = Math.max(0, parseInt(config.xp, 10) || 0);
    const timeLimit = config.timeLimit ? Math.max(5, parseInt(config.timeLimit, 10)) : null;
    const correctAnswer = String(config.correctAnswer || "").trim();

    if (!question || !VALID_QUIZ_TYPES.has(type) || !VALID_DIFFICULTIES.has(difficulty) || !correctAnswer) {
      socket.emit("quiz-error", { message: "Missing or invalid quiz fields." });
      return;
    }

    let options = null;
    if (type === "multiple_choice") {
      options = Array.isArray(config.options) ? config.options.map((o) => String(o).trim()).filter(Boolean) : [];
      if (options.length < 2) {
        socket.emit("quiz-error", { message: "Multiple choice needs at least 2 options." });
        return;
      }
      if (!options.some((o) => normalizeAnswerForCompare(o) === normalizeAnswerForCompare(correctAnswer))) {
        socket.emit("quiz-error", { message: "Correct answer must match one of the options exactly." });
        return;
      }
    } else if (type === "true_false") {
      options = ["True", "False"];
    }

    launchQuiz({ question, type, options, correctAnswer, xp, difficulty, timeLimit });
  });

  // Presenter manually ends the current quiz early.
  socket.on("quiz-end", () => {
    if (!isAuthenticatedPresenter()) return;
    endQuiz();
  });

  // Viewer submits an answer.
  // Payload: { quizId, answer }
  socket.on("quiz-answer", async (payload) => {
    if (isPresenterSocket || !socket.user) return;
    if (!quizState || !quizState.active) return;
    if (!payload || payload.quizId !== quizState.id) return;

    const userId = socket.user.userId;
    const username = socket.user.username;

    // One answer per user per quiz -- ignore repeats/double-taps.
    if (quizState.responses.has(userId)) return;

    const timeMs = Date.now() - quizState.startedAt;
    const correct = gradeAnswer(quizState, payload.answer);
    const xpAwarded = correct ? quizState.xp : 0;

    quizState.responses.set(userId, {
      username,
      answer: payload.answer,
      correct,
      timeMs,
      xpAwarded,
    });

    broadcastQuizLiveStatus();

    const resultEntry = {
      quizId: quizState.id,
      question: quizState.question,
      answer: payload.answer,
      correct,
      timeMs,
      xpAwarded,
      at: new Date().toISOString(),
    };

    const updated = await persistQuizResultForUser(userId, resultEntry, xpAwarded, correct);
    if (updated) {
      broadcastLeaderboardUpdate();

      if (updated.isFirstQuiz) await awardBadge(userId, "first_step");
      if (updated.isFirstCorrect) await awardBadge(userId, "bright_mind");
      if (correct && updated.newStreak === 3) await awardBadge(userId, "on_fire");
      if (correct && updated.newStreak === 4) await awardBadge(userId, "brainstorm");
      if (correct && updated.newStreak >= 5) await awardBadge(userId, "perfect_run");
      if (updated.totalCorrectCount >= QUIZ_WARRIOR_CORRECT_THRESHOLD) await awardBadge(userId, "quiz_warrior");
      if (updated.totalCorrectCount >= 5 && updated.totalIncorrectCount === 0) {
        await awardBadge(userId, "perfect_shot");
      }

      // "Fast Starter" -- among the first few to respond to this quiz.
      if (quizState.responses.size <= FAST_STARTER_CUTOFF) {
        await awardBadge(userId, "fast_starter");
      }
    }

    socket.emit("quiz-feedback", {
      quizId: quizState.id,
      correct,
      correctAnswer: quizState.correctAnswer,
      xpAwarded,
      timeMs,
      newXp: updated ? updated.xp : null,
      newLevel: updated ? updated.level : null,
    });
  });

  socket.on("disconnect", () => {
    if (authenticatedPresenters.has(socket.id)) {
      authenticatedPresenters.delete(socket.id);
      console.log(`[disconnect] presenter ${socket.id} disconnected.`);
      return;
    }

    if (socket.user) {
      const set = viewerSocketsByUserId.get(socket.user.userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) viewerSocketsByUserId.delete(socket.user.userId);
      }
    }

    viewerCount = Math.max(0, viewerCount - 1);
    broadcastViewerCount();
    if (quizState && quizState.active) broadcastQuizLiveStatus();
    console.log(`[disconnect] viewer ${socket.id} disconnected. Viewers: ${viewerCount}`);
  });
});

// ------------------------------------------------------------
// START THE SERVER
// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log("=================================================");
  console.log(" Wi-Fi Synchronized Classroom Presentation System");
  console.log("=================================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Presenter PIN: ${PRESENTER_PIN}`);
  console.log(`Loaded ${slideImages.length} slide image(s) from public/images/`);
  console.log(`AI quiz generation: ${ANTHROPIC_API_KEY ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
  console.log("");
  console.log("On THIS computer, open:");
  console.log(`  Presenter view: http://localhost:${PORT}/presenter`);
  console.log("");
  console.log("Students on the same Wi-Fi should open:");
  console.log(`  ${STUDENT_URL}`);
  console.log("  (This URL is also shown as a QR code on the presenter page.)");
  console.log("");
  console.log("If that IP looks wrong (e.g. you have multiple network");
  console.log("adapters), set HOST_IP in your .env file to override it.");
  console.log("=================================================");
});