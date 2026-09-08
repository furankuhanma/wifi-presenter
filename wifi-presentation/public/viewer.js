// ============================================================
// viewer.js  (mobile-aware, login-gated)
// ============================================================
// Runs in every STUDENT'S browser. Jobs:
//   1. Connect to the server via Socket.IO (only once logged in).
//   2. Render whatever slide the server says is "current".
//   3. Show a connection status indicator.
//   4. Let the student switch landscape/portrait fit.
//   5. Mirror the presenter's whiteboard, read-only, when active.
//   6. NEW: Show a live leaderboard panel (XP/level/rank).
//   7. NEW: Show earned badges (permanent + dynamic) and play an
//      unlock animation/toast when a new permanent badge is earned.
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

  // --------------------------------------------------------
  // LEADERBOARD (NEW)
  // --------------------------------------------------------
  function decodeUsernameFromToken(t) {
    try {
      const payload = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.username || null;
    } catch (err) {
      return null;
    }
  }

  const currentUsername = decodeUsernameFromToken(token);

  const leaderboardBtn = document.getElementById("leaderboardBtn");
  const leaderboardPanel = document.getElementById("leaderboardPanel");
  const leaderboardClose = document.getElementById("leaderboardClose");
  const leaderboardList = document.getElementById("leaderboardList");

  function renderBadgeIcons(entry) {
    const icons = [];
    if (entry && entry.dynamicBadge && entry.dynamicBadge.icon) {
      const badgeId = entry.dynamicBadge.id || 'genius';
      icons.push(`<span class="badge-icon-clickable" data-badge-id="${badgeId}" style="cursor: pointer;">${entry.dynamicBadge.icon}</span>`);
    }
    if (entry && entry.permanentBadges && Array.isArray(entry.permanentBadges)) {
      entry.permanentBadges.forEach((b) => {
        if (b && b.icon && b.id) {
          icons.push(`<span class="badge-icon-clickable" data-badge-id="${b.id}" style="cursor: pointer;">${b.icon}</span>`);
        }
      });
    }
    return icons.join("");
  }

  function renderLeaderboard(entries) {
    if (!leaderboardList) return;
    leaderboardList.innerHTML = "";

    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      if (entry.rank <= 3) row.classList.add("top-rank");
      if (currentUsername && entry.username === currentUsername) row.classList.add("current-user");

      const badgeIcons = renderBadgeIcons(entry);
      row.innerHTML = `
        <div class="lb-rank">#${entry.rank}</div>
        <div class="lb-username">${entry.username}</div>
        <div class="lb-badges">${badgeIcons}</div>
        <div class="lb-level">L${entry.level}</div>
        <div class="lb-xp">${entry.xp} XP</div>
      `;
      leaderboardList.appendChild(row);
    });
  }

  // Add event delegation for badge clicks
  if (leaderboardList) {
    leaderboardList.addEventListener("click", (e) => {
      if (e.target.classList.contains("badge-icon-clickable")) {
        const badgeId = e.target.getAttribute("data-badge-id");
        showBadgeModal(badgeId);
      }
    });
  }

  if (leaderboardBtn && leaderboardPanel) {
    leaderboardBtn.addEventListener("click", () => {
      leaderboardPanel.classList.toggle("open");
    });
  }
  if (leaderboardClose && leaderboardPanel) {
    leaderboardClose.addEventListener("click", () => {
      leaderboardPanel.classList.remove("open");
    });
  }

  // --------------------------------------------------------
  // BADGES (NEW) - Now displayed inline in leaderboard
  // --------------------------------------------------------
  const BADGE_DESCRIPTIONS = {
    good_listener: { name: "Good Listener", icon: "👂", rarity: "Rare", description: "Be the only participant who answers a quiz correctly while everyone else answers incorrectly." },
    on_fire: { name: "On Fire", icon: "🔥", rarity: "Rare", description: "Get 3 correct answers consecutively." },
    brainstorm: { name: "Brainstorm", icon: "🧠", rarity: "Epic", description: "Get 4 correct answers consecutively." },
    perfect_run: { name: "Perfect Run", icon: "💎", rarity: "Legendary", description: "Get 5 correct answers consecutively without any wrong answers." },
    lightning: { name: "Lightning", icon: "⚡", rarity: "Rare", description: "Get the fastest correct answer." },
    perfect_shot: { name: "Perfect Shot", icon: "🎯", rarity: "Epic", description: "Get 5 correct answers without any incorrect answers." },
    bright_mind: { name: "Bright Mind", icon: "💡", rarity: "Common", description: "Get your first correct answer." },
    first_step: { name: "First Step", icon: "🙋", rarity: "Common", description: "Answer your first quiz." },
    dedicated: { name: "Dedicated", icon: "📚", rarity: "Rare", description: "Participate in every quiz during the presentation." },
    until_the_end: { name: "Until the End", icon: "⏳", rarity: "Rare", description: "Stay connected until the presentation ends." },
    fast_starter: { name: "Fast Starter", icon: "🚀", rarity: "Common", description: "Be among the first participants to answer a quiz." },
    comeback: { name: "Comeback", icon: "🏅", rarity: "Epic", description: "Significantly improve your leaderboard position during the presentation." },
    quiz_warrior: { name: "Quiz Warrior", icon: "💎", rarity: "Epic", description: "Reach a high number of correct answers." },
    genius: { name: "Genius", icon: "🧠", rarity: "Legendary", description: "Genius man siguro ning bataa ni" },
    diligent: { name: "Diligent", icon: "🔥", rarity: "Epic", description: "Current Rank #2 with the second-highest XP." },
    lowkey: { name: "Lowkey", icon: "🥷", rarity: "Common", description: "Actively participates but remains outside the Top 2." },
    bulakbol: { name: "Bulakbol", icon: "💤", rarity: "Lowest", description: "Default badge for users who have not earned another badge." },
  };

  let myDynamicBadge = null;
  let myPermanentBadges = [];

  const badgeToastEl = document.getElementById("badgeToast");
  const badgeModal = document.getElementById("badgeModal");
  const badgeModalContent = document.getElementById("badgeModalContent");
  const badgeModalClose = document.getElementById("badgeModalClose");

  function showBadgeModal(badgeId) {
    const badgeInfo = BADGE_DESCRIPTIONS[badgeId];
    if (!badgeInfo || !badgeModal) return;

    document.getElementById("badgeModalIcon").textContent = badgeInfo.icon;
    document.getElementById("badgeModalName").textContent = badgeInfo.name;
    document.getElementById("badgeModalRarity").textContent = badgeInfo.rarity;
    document.getElementById("badgeModalRarity").className = `badge-rarity ${badgeInfo.rarity}`;
    document.getElementById("badgeModalDescription").textContent = badgeInfo.description;

    badgeModal.classList.add("open");
  }

  function closeBadgeModal() {
    if (badgeModal) badgeModal.classList.remove("open");
  }

  if (badgeModalClose) badgeModalClose.addEventListener("click", closeBadgeModal);
  if (badgeModal) badgeModal.addEventListener("click", (e) => {
    if (e.target === badgeModal) closeBadgeModal();
  });

  function showBadgeToast(badge) {
    if (!badgeToastEl) return;
    badgeToastEl.textContent = `${badge.icon} Badge Unlocked: ${badge.name}!`;
    badgeToastEl.classList.remove("show");
    void badgeToastEl.offsetWidth; // restart animation
    badgeToastEl.classList.add("show");
    setTimeout(() => badgeToastEl.classList.remove("show"), 4000);
  }

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
  // LEADERBOARD + BADGE LISTENERS (NEW)
  // --------------------------------------------------------

  socket.on("leaderboard-update", renderLeaderboard);

  socket.on("your-rank-update", (data) => {
    myDynamicBadge = data.dynamicBadge;
    myPermanentBadges = data.permanentBadges || [];
  });

  socket.on("badge-unlocked", (badge) => {
    if (!myPermanentBadges.some((b) => b.id === badge.id)) {
      myPermanentBadges.push(badge);
    }
    showBadgeToast(badge);
  });

  socket.on("presentation-ended", () => {
    slideNumberEl.textContent = "Presentation ended";
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
    resizeWhiteboardCanvas();
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

  // Also handle visualViewport changes (mobile address bar hide/show, etc.)
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (whiteboardCanvas && whiteboardCanvas.style.display !== "none") {
        resizeWhiteboardCanvas();
      }
    });
  }
}

window.startViewer = startViewer;