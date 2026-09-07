// ============================================================
// server.js
// ============================================================
// This is the "brain" of the whole application.
//
// It does 4 main jobs:
//   1. Serves the HTML/CSS/JS files to browsers (Express).
//   2. Keeps track of the ONE "official" current slide number.
//   3. Talks to every connected phone/laptop in real time (Socket.IO).
//   4. Makes sure only the presenter (who knows the PIN) can
//      change slides.
//
// IMPORTANT CONCEPT:
// No phone ever decides the slide on its own. Every device just
// displays whatever number the SERVER says is current. This is
// why late joiners and reconnecting phones always show the
// correct slide automatically.
//
// CHANGE FROM THE PPTX-RENDERING VERSION:
// Slides are no longer reconstructed from parsed PowerPoint data
// (positioned text/shape/image elements). Instead, each slide is
// just a plain image file -- public/images/slide-1.png,
// slide-2.png, etc. -- and the server's only job re: slide CONTENT
// is to find those files, put them in the right order, and tell
// connected clients which image URL corresponds to the current
// slide. slides.js / import-pptx.js are no longer used by the
// running app (left in place in case you still want them for
// regenerating images later).
//
// FILENAME MATCHING (updated):
// Accepts BOTH naming styles so you don't have to rename exports
// from Canva/PowerPoint:
//   - "slide-1.png", "slide-2.jpg", ...  (original style)
//   - "1.png", "2.jpg", ...              (plain numbered style)
// Mixing both styles in the same folder works too -- everything is
// just sorted by its extracted number.
//
// CAPTIVE PORTAL (NEW):
// This server now also starts a small local DNS server (see
// dns-server.js) so that phones connecting to the presentation
// Wi-Fi can automatically get a "Sign in to network" prompt,
// instead of everyone having to type in an IP address manually.
// This is entirely additive -- if DNS fails to start for any
// reason (permissions, port conflict, etc.), the presentation
// and slide sync continue to work exactly as before; only the
// auto-popup convenience is lost.
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

// ------------------------------------------------------------
// SLIDE IMAGE DISCOVERY
// ------------------------------------------------------------
// Looks for image files in public/images/ named either:
//   slide-<number>.<ext>   e.g. slide-1.png, slide-2.jpg
//   <number>.<ext>         e.g. 1.png, 2.jpg
// and returns their web-servable paths sorted in numeric slide
// order (NOT alphabetical -- "2" / "slide-2" must sort before
// "10" / "slide-10").
function loadSlideImages() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.warn(`Warning: ${IMAGES_DIR} does not exist. No slides to show.`);
    return [];
  }

  // Matches "slide-3.png" (group 1 = "3") OR "3.png" (group 2 = "3").
  // Only one of the two groups will be set per match.
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

  // Warn (rather than silently drop) if two files resolve to the same
  // slide number -- e.g. both "3.png" and "slide-3.png" present -- since
  // only one can win and it's easy to not notice otherwise.
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
// This is the #1 source of "phone can't reach the site" problems.
// A dev machine often has MULTIPLE non-internal IPv4 addresses at
// once: the real Wi-Fi/Ethernet adapter, PLUS virtual adapters from
// WSL2, Docker, Hyper-V, or VirtualBox. Those virtual adapters are
// NOT reachable from a phone on the same Wi-Fi -- they're NAT'd
// behind the host OS. Blindly taking "the first non-internal IPv4
// found" (like a naive version of this function does) can easily
// grab a virtual adapter instead of the real one.
//
// We score each candidate and pick the best one:
//   - Adapter name mentions Wi-Fi/WLAN/Ethernet -> best.
//   - Address is in the common home/office LAN ranges
//     (192.168.0.0/16 or 10.0.0.0/8) -> good.
//   - Address is in 172.16.0.0/12 -> deprioritized. This exact
//     range is where WSL2's default NAT network, Docker's default
//     bridge, and Hyper-V's "Default Switch" all commonly live.
//   - Everything else -> last resort.
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
  if (in172Private) score -= 20; // common WSL2/Docker/Hyper-V range
  return score;
}

function getLocalIPAddress() {
  if (process.env.HOST_IP) {
    return process.env.HOST_IP; // Manual override, if provided -- always wins
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
// LOCAL DNS SERVER (captive portal, step 1)
// ------------------------------------------------------------
// Resolves OS captive-portal probe domains (and everything else,
// since there's no real internet to forward to) to LOCAL_IP, so
// connected phones get an automatic "Sign in to network" prompt.
// This is additive and fails safe: if it can't bind (permissions,
// port 53 already in use, etc.), the presentation/sync features
// below are completely unaffected.
try {
  startDnsServer(LOCAL_IP, DNS_PORT);
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

// ------------------------------------------------------------
// CAPTIVE PORTAL — "signed in" tracking (Step 2)
// ------------------------------------------------------------
// Once a device has loaded the /portal landing page, its IP is
// added here so it stops getting the "Sign in to network" prompt
// on later probe checks during the same session. See the note in
// dns-server.js and the earlier design discussion: this is
// IP-based (not MAC-based), which is simple and reliable for a
// single classroom session, but resets if a device's IP changes
// (e.g. reconnecting after a long time away). That's an accepted
// tradeoff -- worst case, someone sees the sign-in prompt again.
const signedInIPs = new Set();

// Normalizes IPv4-mapped IPv6 addresses (e.g. "::ffff:192.168.1.5",
// which is how Node sometimes reports IPv4 clients) down to the
// plain IPv4 form, so the same device isn't tracked as two entries.
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

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/presenter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

// ------------------------------------------------------------
// CAPTIVE PORTAL — landing page + OS probe routes (Step 2)
// ------------------------------------------------------------
// PORTAL_URL is what phones' mini in-app browsers get sent to when
// their OS decides "this network needs sign-in" (see dns-server.js
// for how DNS makes the probe domains reach this server at all).
const PORTAL_URL = `http://${LOCAL_IP}:${PORT}/portal`;

// The landing page itself. Loading this page is what marks the
// device as "signed in" for the rest of the session -- not just
// resolving DNS to us, since that alone doesn't mean a person
// actually saw/used the portal.
app.get("/portal", (req, res) => {
  markSignedIn(req);
  res.sendFile(path.join(__dirname, "public", "portal.html"));
});

// --- iOS / macOS captive portal check ---
// Apple's Captive Network Assistant fetches this exact path and
// expects an exact "Success" response. Any other response (or a
// redirect) makes it treat the network as requiring sign-in and
// show that response's body in its built-in mini browser.
app.get(["/hotspot-detect.html", "/library/test/success.html"], (req, res) => {
  if (isSignedIn(req)) {
    res
      .type("html")
      .send("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  } else {
    // Serve the portal page directly (rather than a redirect) since
    // Apple's CNA mini-browser renders whatever body comes back from
    // this exact URL.
    res.sendFile(path.join(__dirname, "public", "portal.html"));
  }
});

// --- Android captive portal check ---
// Android expects an empty 204 response. Anything else (we use a
// redirect) makes it show the "Sign in to network" notification and
// open a browser to the redirect target.
app.get(["/generate_204", "/gen_204"], (req, res) => {
  if (isSignedIn(req)) {
    res.status(204).end();
  } else {
    res.redirect(302, PORTAL_URL);
  }
});

// --- Windows captive portal check ---
// Windows expects the exact text "Microsoft Connect Test" from
// connecttest.txt (newer) or "Microsoft NCSI" from ncsi.txt (older).
// A redirect/mismatch triggers the "Sign in" notification.
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

// Lets the presenter console re-scan public/images/ without restarting
// the server (e.g. after dropping in new/renamed slide images).
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

// ------------------------------------------------------------
// SOCKET.IO — REAL-TIME LOGIC
// ------------------------------------------------------------

io.on("connection", (socket) => {
  viewerCount++;
  broadcastViewerCount();

  console.log(`[connect] ${socket.id} connected. Viewers: ${viewerCount}`);

  sendCurrentSlideTo(socket);

  socket.on("presenter-auth", (pin) => {
    if (pin === PRESENTER_PIN) {
      authenticatedPresenters.add(socket.id);
      viewerCount = Math.max(0, viewerCount - 1);
      broadcastViewerCount();
      socket.emit("auth-result", { success: true });
      console.log(`[auth] ${socket.id} authenticated as presenter.`);
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

  socket.on("disconnect", () => {
    if (authenticatedPresenters.has(socket.id)) {
      authenticatedPresenters.delete(socket.id);
      console.log(`[disconnect] presenter ${socket.id} disconnected.`);
      return;
    }

    viewerCount = Math.max(0, viewerCount - 1);
    broadcastViewerCount();
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