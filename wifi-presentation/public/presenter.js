// ============================================================
// presenter.js
// ============================================================
// Runs in the PRESENTER'S browser only. It:
//   1. Handles the PIN login screen.
//   2. Sends control commands to the server (next/prev/jump/reset).
//   3. Shows a live, true-to-design preview of the current slide.
//   4. Shows how many students are connected.
//   5. Loads the QR code + student URL from the server.
//
// Reminder: this file can ask the server to change slides, but
// the server is the one that actually enforces the PIN check.
// ============================================================

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const pinError = document.getElementById("pinError");
const pinSubmit = document.getElementById("pinSubmit");

const presenterPage = document.getElementById("presenterPage");
const viewerCountEl = document.getElementById("viewerCount");

const pSlideNumber = document.getElementById("pSlideNumber");
const previewOuter = document.getElementById("previewOuter");
const previewStage = document.getElementById("previewStage");

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const resetBtn = document.getElementById("resetBtn");
const jumpGrid = document.getElementById("jumpGrid");

const studentUrlEl = document.getElementById("studentUrl");
const qrImg = document.getElementById("qrcode");

let totalSlidesKnown = 0;
let jumpGridBuilt = false;

const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// --------------------------------------------------------
// PIN LOGIN
// --------------------------------------------------------

function attemptLogin() {
  const pin = pinInput.value.trim();
  if (!pin) return;
  pinError.textContent = "";
  socket.emit("presenter-auth", pin);
}

pinSubmit.addEventListener("click", attemptLogin);
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptLogin();
});

socket.on("auth-result", (result) => {
  if (result.success) {
    pinScreen.style.display = "none";
    presenterPage.style.display = "block";
    loadStudentUrlAndQr();
  } else {
    pinError.textContent = result.message || "Incorrect PIN.";
    pinInput.value = "";
    pinInput.focus();
  }
});

// Socket.IO reconnecting does NOT automatically re-send our PIN, so
// re-authenticate if we'd already unlocked the page once before.
socket.io.on("reconnect", () => {
  if (presenterPage.style.display !== "none") {
    const pin = pinInput.value.trim();
    if (pin) socket.emit("presenter-auth", pin);
  }
});

// --------------------------------------------------------
// STUDENT URL + QR CODE
// --------------------------------------------------------

async function loadStudentUrlAndQr() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();

    studentUrlEl.textContent = config.studentUrl;
    qrImg.src = "/api/qr.png";

    totalSlidesKnown = config.totalSlides;
    buildJumpGrid(totalSlidesKnown);
  } catch (err) {
    studentUrlEl.textContent = "Could not load student URL.";
    console.error(err);
  }
}

// --------------------------------------------------------
// JUMP-TO-SLIDE GRID
// --------------------------------------------------------

function buildJumpGrid(total) {
  if (jumpGridBuilt) return;
  jumpGrid.innerHTML = "";

  for (let i = 0; i < total; i++) {
    const btn = document.createElement("button");
    btn.className = "jump-btn";
    btn.textContent = i + 1;
    btn.dataset.index = i;
    btn.addEventListener("click", () => {
      socket.emit("goto-slide", i);
    });
    jumpGrid.appendChild(btn);
  }

  jumpGridBuilt = true;
}

function updateJumpGridActiveState(currentIndex) {
  const buttons = jumpGrid.querySelectorAll(".jump-btn");
  buttons.forEach((btn) => {
    const btnIndex = parseInt(btn.dataset.index, 10);
    btn.classList.toggle("active", btnIndex === currentIndex);
  });
}

// --------------------------------------------------------
// SLIDE CONTROL BUTTONS
// --------------------------------------------------------

nextBtn.addEventListener("click", () => socket.emit("next-slide"));
prevBtn.addEventListener("click", () => socket.emit("prev-slide"));
resetBtn.addEventListener("click", () => socket.emit("reset-slide"));

// --------------------------------------------------------
// SWIPE GESTURES (touch devices) — swipe the preview left/right
// to go to the next/previous slide, same as tapping Next/Prev.
// --------------------------------------------------------

const SWIPE_MIN_DISTANCE_PX = 50; // ignore tiny accidental drags
const SWIPE_MAX_OFF_AXIS_PX = 80; // ignore mostly-vertical drags (scrolling)

let touchStartX = null;
let touchStartY = null;

previewOuter.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length !== 1) return; // ignore pinch/multi-touch
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  },
  { passive: true }
);

previewOuter.addEventListener(
  "touchend",
  (e) => {
    if (touchStartX === null) return;

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;

    touchStartX = null;
    touchStartY = null;

    if (Math.abs(deltaY) > SWIPE_MAX_OFF_AXIS_PX) return; // too vertical, probably scrolling
    if (Math.abs(deltaX) < SWIPE_MIN_DISTANCE_PX) return; // too small, probably a tap

    if (deltaX < 0) {
      socket.emit("next-slide"); // swiped left -> advance forward
    } else {
      socket.emit("prev-slide"); // swiped right -> go back
    }
  },
  { passive: true }
);

// --------------------------------------------------------
// LIVE PREVIEW + VIEWER COUNT
// --------------------------------------------------------

socket.on("slide-update", (data) => {
  const { index, total } = data;

  pSlideNumber.textContent = `Slide ${index + 1} of ${total}`;

  // render.js's image-based renderSlide expects the WHOLE payload
  // (it just reads data.image off of it) -- there's no separate
  // "slide" or "deck" field sent by the server anymore, so we pass
  // `data` straight through, exactly like viewer.js does.
  renderSlide(previewStage, data);
  fitStage(previewOuter, previewStage, false);

  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === total - 1;

  if (!jumpGridBuilt && total > 0) {
    totalSlidesKnown = total;
    buildJumpGrid(total);
  }

  updateJumpGridActiveState(index);
});

socket.on("viewer-count", (count) => {
  const label = count === 1 ? "viewer" : "viewers";
  viewerCountEl.textContent = `${count} ${label} connected`;
});

window.addEventListener("resize", () => fitStage(previewOuter, previewStage, false));