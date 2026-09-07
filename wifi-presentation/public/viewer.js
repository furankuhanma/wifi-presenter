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