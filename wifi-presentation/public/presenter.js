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
//
// WHAT CHANGED FOR LOGIN: the socket connection now sends
// `auth: { role: "presenter" }` on connect. This tells server.js's
// Socket.IO auth gate (io.use(...)) to let this connection through
// WITHOUT a participant login token -- the presenter still has to
// clear the PIN check below exactly as before. Nothing else in this
// file changed.
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

const whiteboardCanvas = document.getElementById("whiteboardCanvas");
const whiteboardToggleBtn = document.getElementById("whiteboardToggleBtn");
const whiteboardToolbar = document.getElementById("whiteboardToolbar");
const toolButtons = {
  pen: document.getElementById("toolPenBtn"),
  eraser: document.getElementById("toolEraserBtn"),
  line: document.getElementById("toolLineBtn"),
  rectangle: document.getElementById("toolRectBtn"),
  circle: document.getElementById("toolCircleBtn"),
};
const wbColorInput = document.getElementById("wbColorInput");
const wbSizeInput = document.getElementById("wbSizeInput");
const wbClearBtn = document.getElementById("wbClearBtn");

const studentUrlEl = document.getElementById("studentUrl");
const qrImg = document.getElementById("qrcode");

let totalSlidesKnown = 0;
let jumpGridBuilt = false;

const socket = io({
  auth: { role: "presenter" }, // NEW: skips the login-token check server-side
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

// (Fullscreen button removed by request -- no fullscreenBtn element
// exists in presenter.html anymore, so there's nothing to wire up
// here. If you ever want it back, add a <button id="fullscreenBtn">
// to presenter.html and re-add a listener here.)

// --------------------------------------------------------
// WHITEBOARD (Step 2 — presenter drawing UI)
// --------------------------------------------------------
// Coordinates are stored/sent as 0..1 FRACTIONS of the canvas's
// own width/height, not raw pixels -- this is what the server
// expects (see the WHITEBOARD STATE comment in server.js) so the
// same drawing lines up correctly on every viewer's differently
// sized screen. All conversion between real pixels (for actually
// drawing on THIS screen) and fractions (for sending/storing)
// happens right here.

const ctx = whiteboardCanvas.getContext("2d");

let currentTool = "pen"; // "pen" | "eraser" | "line" | "rectangle" | "circle"
let isDrawing = false;
let strokePoints = []; // used by pen/eraser, in fraction coords
let shapeStart = null; // used by line/rectangle/circle, in fraction coords
let shapeEnd = null;

function setActiveTool(tool) {
  currentTool = tool;
  Object.entries(toolButtons).forEach(([name, btn]) => {
    btn.classList.toggle("active", name === tool);
  });
}

toolButtons.pen.addEventListener("click", () => setActiveTool("pen"));
toolButtons.eraser.addEventListener("click", () => setActiveTool("eraser"));
toolButtons.line.addEventListener("click", () => setActiveTool("line"));
toolButtons.rectangle.addEventListener("click", () => setActiveTool("rectangle"));
toolButtons.circle.addEventListener("click", () => setActiveTool("circle"));

// Keeps the canvas's actual pixel resolution matching its displayed
// CSS size (same box previewOuter/previewStage already use), so
// drawing isn't blurry or misaligned. Called on toggle-on and resize.
function resizeWhiteboardCanvas() {
  const rect = previewOuter.getBoundingClientRect();
  whiteboardCanvas.width = rect.width;
  whiteboardCanvas.height = rect.height;
  redrawWhiteboard();
}

function toFraction(clientX, clientY) {
  const rect = whiteboardCanvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

function toPixels(fractionPoint) {
  return {
    x: fractionPoint.x * whiteboardCanvas.width,
    y: fractionPoint.y * whiteboardCanvas.height,
  };
}

// Draws one object (already-completed stroke/shape from the server's
// list, or a locally-in-progress one) onto the canvas. Does NOT clear
// the canvas first -- callers decide when to clear.
function drawObject(obj) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (obj.type === "stroke" || obj.type === "eraser-stroke") {
    if (!obj.points || obj.points.length < 2) return;
    ctx.globalCompositeOperation = obj.type === "eraser-stroke" ? "destination-out" : "source-over";
    ctx.strokeStyle = obj.color || "#ffffff";
    ctx.lineWidth = obj.size || 4;
    ctx.beginPath();
    const first = toPixels(obj.points[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < obj.points.length; i++) {
      const p = toPixels(obj.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  if (!obj.start || !obj.end) return;
  const start = toPixels(obj.start);
  const end = toPixels(obj.end);

  ctx.strokeStyle = obj.color || "#ffffff";
  ctx.lineWidth = obj.size || 4;
  ctx.beginPath();

  if (obj.type === "line") {
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
  } else if (obj.type === "rectangle") {
    ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (obj.type === "circle") {
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
  }

  ctx.stroke();
}

// Full redraw of everything the server currently knows about, plus
// (optionally) whatever's mid-drag right now locally. Simpler and
// safer than trying to incrementally patch the canvas, and fast
// enough at classroom-presentation scale (dozens/hundreds of
// objects, not thousands).
let knownWhiteboardObjects = [];

function redrawWhiteboard() {
  ctx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  knownWhiteboardObjects.forEach(drawObject);
}

function getEventPoint(e) {
  if (e.touches && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  return { clientX: e.clientX, clientY: e.clientY };
}

function handleDrawStart(e) {
  isDrawing = true;
  const { clientX, clientY } = getEventPoint(e);
  const point = toFraction(clientX, clientY);

  if (currentTool === "pen" || currentTool === "eraser") {
    strokePoints = [point];
  } else {
    shapeStart = point;
    shapeEnd = point;
  }
}

function handleDrawMove(e) {
  if (!isDrawing) return;
  e.preventDefault(); // stop touch-scrolling while drawing
  const { clientX, clientY } = getEventPoint(e);
  const point = toFraction(clientX, clientY);

  if (currentTool === "pen" || currentTool === "eraser") {
    strokePoints.push(point);
    redrawWhiteboard();
    drawObject({
      type: currentTool === "eraser" ? "eraser-stroke" : "stroke",
      color: wbColorInput.value,
      size: Number(wbSizeInput.value),
      points: strokePoints,
    });
  } else {
    shapeEnd = point;
    redrawWhiteboard();
    drawObject({
      type: currentTool,
      color: wbColorInput.value,
      size: Number(wbSizeInput.value),
      start: shapeStart,
      end: shapeEnd,
    });
  }
}

function handleDrawEnd() {
  if (!isDrawing) return;
  isDrawing = false;

  let finishedObject = null;

  if (currentTool === "pen" || currentTool === "eraser") {
    if (strokePoints.length >= 2) {
      finishedObject = {
        type: currentTool === "eraser" ? "eraser-stroke" : "stroke",
        color: wbColorInput.value,
        size: Number(wbSizeInput.value),
        points: strokePoints,
      };
    }
    strokePoints = [];
  } else if (shapeStart && shapeEnd) {
    finishedObject = {
      type: currentTool,
      color: wbColorInput.value,
      size: Number(wbSizeInput.value),
      start: shapeStart,
      end: shapeEnd,
    };
    shapeStart = null;
    shapeEnd = null;
  }

  if (finishedObject) {
    socket.emit("add-whiteboard-object", finishedObject);
  } else {
    // Nothing worth keeping (e.g. a stray click) -- just redraw to
    // clear any in-progress preview.
    redrawWhiteboard();
  }
}

whiteboardCanvas.addEventListener("mousedown", handleDrawStart);
whiteboardCanvas.addEventListener("mousemove", handleDrawMove);
window.addEventListener("mouseup", handleDrawEnd);

whiteboardCanvas.addEventListener("touchstart", handleDrawStart, { passive: true });
whiteboardCanvas.addEventListener("touchmove", handleDrawMove, { passive: false });
whiteboardCanvas.addEventListener("touchend", handleDrawEnd);

whiteboardToggleBtn.addEventListener("click", () => {
  const turningOn = whiteboardCanvas.style.display === "none";
  socket.emit("toggle-whiteboard", turningOn);
});

wbClearBtn.addEventListener("click", () => {
  socket.emit("clear-whiteboard");
});

socket.on("whiteboard-state", (state) => {
  knownWhiteboardObjects = state.objects || [];

  const isActive = Boolean(state.active);
  whiteboardCanvas.style.display = isActive ? "block" : "none";
  whiteboardToolbar.style.display = isActive ? "block" : "none";
  previewStage.style.display = isActive ? "none" : "block";
  whiteboardToggleBtn.textContent = isActive ? "Back to Slides" : "Whiteboard";

  if (isActive) {
    resizeWhiteboardCanvas();
  }
});

socket.on("whiteboard-object-added", (obj) => {
  knownWhiteboardObjects.push(obj);
  redrawWhiteboard();
});

socket.on("whiteboard-cleared", () => {
  knownWhiteboardObjects = [];
  redrawWhiteboard();
});

window.addEventListener("resize", () => {
  if (whiteboardCanvas.style.display !== "none") {
    resizeWhiteboardCanvas();
  }
});

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