// ============================================================
// viewer-auth.js
// ============================================================
// Runs BEFORE viewer.js's actual logic starts. Job:
//   1. Check for a saved login token.
//   2. If missing/invalid, show the login/signup overlay and
//      block the presentation from ever loading.
//   3. Once a valid token is confirmed (login/signup success, or
//      an existing token that still checks out against the
//      server), hide the overlay, reveal the presentation, and
//      call window.startViewer(token) -- defined in viewer.js --
//      which is what actually connects the socket.
//
// IMPORTANT: this is a UX convenience, not the real security
// boundary. Someone could edit this file locally and skip
// straight to calling startViewer() with a fake token -- but
// that gets them nowhere, because server.js independently
// rejects any socket connection without a valid token. This file
// just makes the normal flow pleasant; server.js makes it
// enforced.
// ============================================================

const TOKEN_KEY = "wifi_presentation_token";

const authGate = document.getElementById("authGate");
const presentationRoot = document.getElementById("presentationRoot");

const authForm = document.getElementById("authForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const authMessage = document.getElementById("authMessage");
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const authTitle = document.getElementById("authTitle");
const submitBtn = document.getElementById("submitBtn");

let mode = "login";

function setMode(newMode) {
  mode = newMode;
  const isLogin = mode === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabSignup.classList.toggle("active", !isLogin);
  authTitle.textContent = isLogin ? "Log In to Join" : "Create an Account";
  submitBtn.textContent = isLogin ? "Log In" : "Sign Up";
  passwordInput.autocomplete = isLogin ? "current-password" : "new-password";
  authMessage.textContent = "";
  authMessage.className = "";
}

tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));

function showMessage(text, type) {
  authMessage.textContent = text;
  authMessage.className = type || "";
}

function showGate() {
  authGate.style.display = "flex";
  presentationRoot.style.display = "none";
}

function enterPresentation(token) {
  authGate.style.display = "none";
  presentationRoot.style.display = "block";
  window.startViewer(token);
}

// On page load: if we already have a token, confirm it's still
// valid (not expired, account still exists) before trusting it --
// otherwise a stale token would show the gate as "passed" client-side
// while the server rejects the actual socket connection, leaving the
// student stuck on a blank screen with no explanation.
async function checkExistingToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showGate();
    return;
  }

  try {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      enterPresentation(token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      showGate();
    }
  } catch (err) {
    // Network hiccup -- fail safe by showing the gate rather than
    // silently letting a possibly-invalid token through.
    showGate();
  }
}

// After successful login, redirect to /viewer
function redirectToViewer(token) {
  // Small delay to ensure localStorage is written
  setTimeout(() => {
    window.location.href = "/viewer";
  }, 100);
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showMessage("", "");

  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";

  submitBtn.disabled = true;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || "Something went wrong.", "error");
      return;
    }

    localStorage.setItem(TOKEN_KEY, data.token);
    showMessage(
      mode === "login" ? "Logged in! Entering presentation..." : "Account created! Entering presentation...",
      "success"
    );
    enterPresentation(data.token);
  } catch (err) {
    showMessage("Could not reach the server.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

checkExistingToken();