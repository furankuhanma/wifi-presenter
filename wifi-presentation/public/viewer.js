// ============================================================
// viewer.js  (mobile-aware, login-gated)
// ============================================================
// Runs in every STUDENT'S browser. Jobs:
//   1. Connect to the server via Socket.IO (only once logged in).
//   2. Render whatever slide the server says is "current".
//   3. Show a connection status indicator.
//   4. Let the student switch landscape/portrait fit.
//   5. Mirror the presenter's whiteboard, read-only, when active.
//
// NEW: after creating the socket, this file exposes it as
// `window.appSocket` and fires a "viewer-socket-ready" event so
// viewer-quiz.js (a separate file, loaded after this one) can
// attach its own listeners to the SAME connection instead of
// opening a second one. Nothing else about this file changed.
// ============================================================

function startViewer(token) {
  const statusBar = document.getElementById("statusBar");
  const slideNumberEl = document.getElementById("slideNumber");
  const stageOuter = document.getElementById("stageOuter");
  const stage = document.getElementById("stage");
  const rotateBtn = document.getElementById("rotateBtn");

  let isRotated = false;
  let rotationAutoPicked = false;

  const socket = io({
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // NEW: make this socket reachable to viewer-quiz.js.
  window.appSocket = socket;
  window.dispatchEvent(new CustomEvent("viewer-socket-ready", { detail: socket }));

  socket.on("connect_error", (err) => {
    if (err && err.message === "AUTH_REQUIRED") {
      localStorage.removeItem("wifi_presentation_token");
      location.reload();
    } else {
      setStatusReconnecting();
    }
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

  // --------------------------------------------------------
  // WHITEBOARD (read-only viewer display)
  // --------------------------------------------------------
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
}

window.startViewer = startViewer;