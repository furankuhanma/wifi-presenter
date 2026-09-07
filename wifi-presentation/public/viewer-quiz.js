// ============================================================
// viewer-quiz.js
// ============================================================
// Runs in every STUDENT'S browser, loaded after viewer.js (but
// before viewer-auth.js reveals the presentation). It waits for
// viewer.js to actually open its socket (via the "viewer-socket-
// ready" event -- see viewer.js), then:
//
//   1. Shows a full-screen overlay the instant the server sends
//      "quiz-question", with a countdown if the quiz has a time
//      limit.
//   2. Renders Multiple Choice / True-False as tappable buttons,
//      or Identification as a text field.
//   3. Sends the answer to the server and locks the UI so a
//      student can't answer twice.
//   4. Shows instant feedback (correct/incorrect + XP earned)
//      once the server grades it.
//
// This file never grades anything itself -- it only displays
// what the server (server.js) decides.
// ============================================================

(function () {
  const overlay = document.getElementById("quizOverlay");
  const metaBadge = document.getElementById("quizDifficultyBadge");
  const timerEl = document.getElementById("quizTimer");
  const questionText = document.getElementById("quizQuestionText");
  const optionsList = document.getElementById("quizOptionsList");
  const idForm = document.getElementById("quizIdentificationForm");
  const idInput = document.getElementById("quizIdentificationInput");
  const waitingEl = document.getElementById("quizWaiting");
  const feedbackEl = document.getElementById("quizFeedback");

  let currentQuiz = null; // { quizId, type, timeLimit, startedAt, ... }
  let hasAnswered = false;
  let countdownInterval = null;

  function resetOverlayForNewQuiz(quiz) {
    currentQuiz = quiz;
    hasAnswered = false;

    overlay.classList.add("active");
    metaBadge.textContent = `${capitalize(quiz.difficulty)} · ${quiz.xp} XP`;
    questionText.textContent = quiz.question;

    feedbackEl.style.display = "none";
    waitingEl.style.display = "none";
    optionsList.innerHTML = "";
    optionsList.style.display = "none";
    idForm.style.display = "none";
    idInput.value = "";

    if (quiz.type === "multiple_choice" || quiz.type === "true_false") {
      optionsList.style.display = "flex";
      quiz.options.forEach((optionText) => {
        const btn = document.createElement("button");
        btn.className = "quiz-option-btn";
        btn.type = "button";
        btn.textContent = optionText;
        btn.addEventListener("click", () => submitAnswer(optionText, btn));
        optionsList.appendChild(btn);
      });
    } else {
      idForm.style.display = "flex";
    }

    clearInterval(countdownInterval);
    if (quiz.timeLimit) {
      startCountdown(quiz.startedAt, quiz.timeLimit);
    } else {
      timerEl.textContent = "";
    }
  }

  function startCountdown(startedAt, timeLimitSeconds) {
    function tick() {
      const elapsedMs = Date.now() - startedAt;
      const remaining = Math.max(0, timeLimitSeconds - Math.floor(elapsedMs / 1000));
      timerEl.textContent = `${remaining}s`;
      timerEl.classList.toggle("urgent", remaining <= 5);
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        lockAllInputs();
      }
    }
    tick();
    countdownInterval = setInterval(tick, 250);
  }

  function lockAllInputs() {
    optionsList.querySelectorAll(".quiz-option-btn").forEach((b) => (b.disabled = true));
    idInput.disabled = true;
    const submitBtn = document.getElementById("quizSubmitBtn");
    if (submitBtn) submitBtn.disabled = true;
  }

  function submitAnswer(answer, clickedBtn) {
    if (hasAnswered || !currentQuiz) return;
    hasAnswered = true;
    lockAllInputs();

    if (clickedBtn) clickedBtn.classList.add("selected");

    waitingEl.style.display = "block";

    window.appSocket.emit("quiz-answer", {
      quizId: currentQuiz.quizId,
      answer,
    });
  }

  idForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = idInput.value.trim();
    if (!value) return;
    submitAnswer(value);
  });

  function showFeedback(feedback) {
    waitingEl.style.display = "none";
    clearInterval(countdownInterval);

    feedbackEl.style.display = "block";
    feedbackEl.className = feedback.correct ? "correct" : "incorrect";

    const xpLine = feedback.xpAwarded > 0 ? ` +${feedback.xpAwarded} XP` : "";
    const levelLine =
      feedback.newLevel != null ? ` · Level ${feedback.newLevel} (${feedback.newXp} XP total)` : "";

    feedbackEl.textContent = feedback.correct
      ? `Correct!${xpLine}${levelLine}`
      : `Not quite. Correct answer: ${feedback.correctAnswer}${levelLine}`;

    // Highlight the right/wrong option for MCQ / True-False.
    optionsList.querySelectorAll(".quiz-option-btn").forEach((btn) => {
      if (btn.textContent === feedback.correctAnswer) {
        btn.classList.add("correct");
      } else if (btn.classList.contains("selected")) {
        btn.classList.add("incorrect");
      }
    });
  }

  function closeOverlayAfterDelay() {
    setTimeout(() => {
      overlay.classList.remove("active");
      currentQuiz = null;
    }, 4000);
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // --------------------------------------------------------
  // WIRE UP TO THE SOCKET ONCE IT EXISTS
  // --------------------------------------------------------
  function attachQuizListeners(socket) {
    socket.on("quiz-question", (quiz) => {
      resetOverlayForNewQuiz(quiz);
    });

    socket.on("quiz-feedback", (feedback) => {
      showFeedback(feedback);
      closeOverlayAfterDelay();
    });

    socket.on("quiz-ended", (info) => {
      clearInterval(countdownInterval);
      if (!hasAnswered && currentQuiz && info.quizId === currentQuiz.quizId) {
        // Didn't answer in time -- show the correct answer, no XP.
        lockAllInputs();
        waitingEl.style.display = "none";
        feedbackEl.style.display = "block";
        feedbackEl.className = "incorrect";
        feedbackEl.textContent = `Time's up. Correct answer: ${info.correctAnswer}`;
        closeOverlayAfterDelay();
      }
    });
  }

  if (window.appSocket) {
    attachQuizListeners(window.appSocket);
  } else {
    window.addEventListener("viewer-socket-ready", (e) => attachQuizListeners(e.detail), { once: true });
  }
})();