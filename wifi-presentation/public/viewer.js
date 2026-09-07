// ============================================================
// viewer.js  (mobile-aware)
// ============================================================
// Runs in every STUDENT'S browser. Jobs:
//   1. Connect to the server via Socket.IO.
//   2. Render whatever slide the server says is "current" -- a
//      single pre-rendered image (see render.js).
//   3. Show a connection status indicator.
//   4. Let the student switch landscape/portrait fit as a local
//      display preference that doesn't affect the server or other viewers.
//   5. Mirror the presenter's whiteboard, read-only, when active.
//
// This file never decides which slide to show -- it only
// displays whatever the server sends via "slide-update".
//
// WHAT'S NEW: the very first slide auto-picks a sensible rotation
// (e.g. a landscape deck on a portrait phone starts rotated, since
// that's almost always what makes it readable) using render.js's
// suggestRotation() helper. The student can still tap Rotate to
// override it any time. Viewport-size re-fitting on mobile (address
// bar show/hide, orientation change) is now handled centrally by
// render.js, so this file doesn't need its own resize listeners for
// that.
// ============================================================

const statusBar = document.getElementById("statusBar");
const slideNumberEl = document.getElementById("slideNumber");
const stageOuter = document.getElementById("stageOuter");
const stage = document.getElementById("stage");
const rotateBtn = document.getElementById("rotateBtn");

let isRotated = false;
let rotationAutoPicked = false;

const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// --------------------------------------------------------
// CONNECTION STATUS
// --------------------------------------------------------

function setStatusConnected() {
  statusBar.classList.remove("reconnecting");
}

function setStatusReconnecting() {
  statusBar.classList.add("reconnecting");
  slideNumberEl.textContent = "Reconnecting…";
}

socket.on("connect", setStatusConnected);
socket.on("disconnect", setStatusReconnecting);
socket.io.on("reconnect_attempt", setStatusReconnecting);
socket.io.on("reconnect", () => {
  setStatusConnected();
  // No need to re-request the slide -- the server sends
  // "slide-update" to every socket as soon as it (re)connects.
});

// --------------------------------------------------------
// SLIDE RENDERING
// --------------------------------------------------------

socket.on("slide-update", (data) => {
  const { index, total } = data;

  slideNumberEl.textContent = `Slide ${index + 1} of ${total}`;

  renderSlide(stage, data);
  fitStage(stageOuter, stage, isRotated);
});

// The very first time we learn a slide's real dimensions, pick a
// sensible default rotation instead of always starting unrotated.
// Runs once; after that the student's manual Rotate taps take over.
function maybeAutoPickRotation() {
  if (rotationAutoPicked) return;

  const slideWidth = Number(stage.dataset.slideWidth);
  const slideHeight = Number(stage.dataset.slideHeight);
  if (!slideWidth || !slideHeight) return;

  const outerRect = stageOuter.getBoundingClientRect();
  const shouldRotate = suggestRotation(
    slideWidth,
    slideHeight,
    outerRect.width,
    outerRect.height
  );

  rotationAutoPicked = true;
  if (shouldRotate !== isRotated) {
    isRotated = shouldRotate;
    fitStage(stageOuter, stage, isRotated);
  }
}

// The image inside `stage` is recreated on every render, so watch
// for it via a MutationObserver instead of hanging a one-off
// listener off a specific <img> that might already be gone.
new MutationObserver(maybeAutoPickRotation).observe(stage, {
  attributes: true,
  attributeFilter: ["data-slide-width", "data-slide-height"],
});

// --------------------------------------------------------
// ORIENTATION CONTROLS
// --------------------------------------------------------

rotateBtn.addEventListener("click", () => {
  isRotated = !isRotated;
  fitStage(stageOuter, stage, isRotated);
});

// Note: render.js's shared visualViewport/resize/orientationchange
// listeners already re-fit this stage automatically on viewport
// changes (address bar show/hide, rotation, etc.), so no separate
// listeners are needed here for that.

// --------------------------------------------------------
// WHITEBOARD (Step 3 — read-only viewer display)
// --------------------------------------------------------
// Mirrors whatever the presenter draws. Students never draw here --
// this only listens and renders. Coordinates arrive as 0..1
// fractions of canvas width/height (see server.js's WHITEBOARD
// STATE comment), which is what makes the same drawing line up
// correctly on this phone even though its screen is a different
// size than the presenter's.
//
// Simplification vs. the presenter's Rotate feature: the whiteboard
// canvas always displays upright (not rotated), even if the student
// has rotated the slide view. Drawing is usually explanatory text/
// diagrams that read fine either way, and this keeps Step 3 simple.
// If this turns out to matter in practice, rotation support can be
// added later the same way fitStage() handles it for slides.

const whiteboardCanvas = document.getElementById("whiteboardCanvas");
const wbCtx = whiteboardCanvas ? whiteboardCanvas.getContext("2d") : null;

let knownWhiteboardObjects = [];

function resizeWhiteboardCanvas() {
  if (!whiteboardCanvas) return;
  const rect = stageOuter.getBoundingClientRect();
  whiteboardCanvas.width = rect.width;
  whiteboardCanvas.height = rect.height;
  redrawWhiteboard();
}

function toPixels(fractionPoint) {
  if (!whiteboardCanvas) return { x: 0, y: 0 };
  return {
    x: fractionPoint.x * whiteboardCanvas.width,
    y: fractionPoint.y * whiteboardCanvas.height,
  };
}

function drawWhiteboardObject(obj) {
  if (!wbCtx) return;
  wbCtx.lineJoin = "round";
  wbCtx.lineCap = "round";

  if (obj.type === "stroke" || obj.type === "eraser-stroke") {
    if (!obj.points || obj.points.length < 2) return;
    wbCtx.globalCompositeOperation = obj.type === "eraser-stroke" ? "destination-out" : "source-over";
    wbCtx.strokeStyle = obj.color || "#ffffff";
    wbCtx.lineWidth = obj.size || 4;
    wbCtx.beginPath();
    const first = toPixels(obj.points[0]);
    wbCtx.moveTo(first.x, first.y);
    for (let i = 1; i < obj.points.length; i++) {
      const p = toPixels(obj.points[i]);
      wbCtx.lineTo(p.x, p.y);
    }
    wbCtx.stroke();
    wbCtx.globalCompositeOperation = "source-over";
    return;
  }

  if (!obj.start || !obj.end) return;
  const start = toPixels(obj.start);
  const end = toPixels(obj.end);

  wbCtx.strokeStyle = obj.color || "#ffffff";
  wbCtx.lineWidth = obj.size || 4;
  wbCtx.beginPath();

  if (obj.type === "line") {
    wbCtx.moveTo(start.x, start.y);
    wbCtx.lineTo(end.x, end.y);
  } else if (obj.type === "rectangle") {
    wbCtx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (obj.type === "circle") {
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    wbCtx.arc(start.x, start.y, radius, 0, Math.PI * 2);
  }

  wbCtx.stroke();
}

function redrawWhiteboard() {
  if (!wbCtx || !whiteboardCanvas) return;
  wbCtx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  knownWhiteboardObjects.forEach(drawWhiteboardObject);
}

socket.on("whiteboard-state", (state) => {
  if (!whiteboardCanvas) return;
  knownWhiteboardObjects = state.objects || [];

  const isActive = Boolean(state.active);
  whiteboardCanvas.style.display = isActive ? "block" : "none";
  stage.style.display = isActive ? "none" : "block";

  if (isActive) {
    resizeWhiteboardCanvas();
    slideNumberEl.textContent = "Whiteboard";
  }
  // If turning off, the next "slide-update" (which the server sends
  // right alongside toggle-off in practice) will restore the normal
  // "Slide X of Y" text -- nothing extra needed here for that case.
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
  if (whiteboardCanvas && whiteboardCanvas.style.display !== "none") {
    resizeWhiteboardCanvas();
  }
});