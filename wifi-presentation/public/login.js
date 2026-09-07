// ============================================================
// login.js
// ============================================================
// Talks to /api/auth/signup and /api/auth/login, stores the
// returned JWT in localStorage, and calls /api/auth/me to prove
// the whole loop works end-to-end.
//
// This page is intentionally standalone for now -- it's not
// wired into viewer.html/viewer.js yet. That integration (only
// letting logged-in participants see the presentation) is the
// next step, once the login/signup/DB layer is confirmed working.
// ============================================================

const TOKEN_KEY = "wifi_presentation_token";

let mode = "login"; // or "signup"

const form = document.getElementById("authForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const messageEl = document.getElementById("authMessage");
const meBox = document.getElementById("meBox");
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const authTitle = document.getElementById("authTitle");
const submitBtn = document.getElementById("submitBtn");

function setMode(newMode) {
  mode = newMode;
  const isLogin = mode === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabSignup.classList.toggle("active", !isLogin);
  authTitle.textContent = isLogin ? "Log In" : "Sign Up";
  submitBtn.textContent = isLogin ? "Log In" : "Sign Up";
  passwordInput.autocomplete = isLogin ? "current-password" : "new-password";
  messageEl.textContent = "";
  messageEl.className = "";
}

tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = type || "";
}

async function fetchMe(token) {
  try {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      meBox.textContent = "";
      return;
    }
    meBox.textContent =
      `Logged in as: ${data.username}\n` +
      `XP: ${data.xp}  Level: ${data.level}\n` +
      `Badges: ${JSON.stringify(data.badges)}\n` +
      `Quiz results: ${JSON.stringify(data.quiz_results)}`;
  } catch (err) {
    console.error("Failed to fetch /api/auth/me:", err);
  }
}

// If a token is already saved (e.g. page refresh), show profile.
const existingToken = localStorage.getItem(TOKEN_KEY);
if (existingToken) {
  fetchMe(existingToken);
}

form.addEventListener("submit", async (e) => {
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
      mode === "login" ? "Logged in! Redirecting..." : "Account created! Redirecting...",
      "success"
    );
    // Auto-redirect to viewer after brief delay to show success message
    setTimeout(() => {
      window.location.href = "/viewer";
    }, 500);
  } catch (err) {
    console.error(err);
    showMessage("Could not reach the server.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});