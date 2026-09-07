// ============================================================
// presenter-quiz.js
// ============================================================
// Runs in the PRESENTER'S browser, loaded after presenter.js.
// Reuses the same `socket` connection presenter.js already
// created (both files are classic <script> tags on the same
// page, so top-level `const socket` from presenter.js is visible
// here too).
//
// Responsibilities:
//   1. Quiz builder form (manual entry OR "Generate" via the AI
//      endpoint, which just pre-fills the same form for review).
//   2. Emits "quiz-launch" with a validated config.
//   3. Shows live response status while a quiz is running.
//   4. Shows results + leaderboard once the quiz ends.
//
// This file never decides who's "right" -- grading and XP all
// happen server-side. It only builds the question and displays
// whatever the server reports back.
// ============================================================

(function () {
  const quizModeManualBtn = document.getElementById("quizModeManual");
  const quizModeAiBtn = document.getElementById("quizModeAi");
  const quizAiFields = document.getElementById("quizAiFields");
  const quizAiTopic = document.getElementById("quizAiTopic");
  const quizAiGenerateBtn = document.getElementById("quizAiGenerateBtn");
  const quizAiStatus = document.getElementById("quizAiStatus");

  const quizQuestion = document.getElementById("quizQuestion");
  const quizType = document.getElementById("quizType");
  const quizDifficulty = document.getElementById("quizDifficulty");
  const quizXp = document.getElementById("quizXp");
  const quizTimeLimit = document.getElementById("quizTimeLimit");

  const quizMcqFields = document.getElementById("quizMcqFields");
  const quizTfFields = document.getElementById("quizTfFields");
  const quizIdFields = document.getElementById("quizIdFields");
  const quizTfCorrect = document.getElementById("quizTfCorrect");
  const quizIdCorrect = document.getElementById("quizIdCorrect");
  const mcqOptionInputs = () => Array.from(document.querySelectorAll(".quiz-mcq-option"));
  const mcqCorrectRadios = () => Array.from(document.querySelectorAll('input[name="quizMcqCorrect"]'));

  const quizError = document.getElementById("quizError");
  const quizFormStatus = document.getElementById("quizFormStatus");
  const quizLaunchBtn = document.getElementById("quizLaunchBtn");

  const quizBuilder = document.getElementById("quizBuilder");
  const quizLiveStatus = document.getElementById("quizLiveStatus");
  const quizProgressFill = document.getElementById("quizProgressFill");
  const quizLiveCount = document.getElementById("quizLiveCount");
  const quizLiveFeed = document.getElementById("quizLiveFeed");
  const quizEndBtn = document.getElementById("quizEndBtn");

  const quizResultsPanel = document.getElementById("quizResultsPanel");
  const quizStatAccuracy = document.getElementById("quizStatAccuracy");
  const quizStatResponded = document.getElementById("quizStatResponded");
  const quizStatCorrectAnswer = document.getElementById("quizStatCorrectAnswer");
  const quizFastestTable = document.querySelector("#quizFastestTable tbody");
  const quizLeaderboardTable = document.querySelector("#quizLeaderboardTable tbody");

  // --------------------------------------------------------
  // MODE TABS (Manual vs AI-generated)
  // --------------------------------------------------------
  quizModeManualBtn.addEventListener("click", () => {
    quizModeManualBtn.classList.add("active");
    quizModeAiBtn.classList.remove("active");
    quizAiFields.classList.add("hidden");
  });

  quizModeAiBtn.addEventListener("click", () => {
    quizModeAiBtn.classList.add("active");
    quizModeManualBtn.classList.remove("active");
    quizAiFields.classList.remove("hidden");
  });

  // --------------------------------------------------------
  // QUESTION TYPE SWITCHING
  // --------------------------------------------------------
  function updateTypeFieldsVisibility() {
    const type = quizType.value;
    quizMcqFields.classList.toggle("hidden", type !== "multiple_choice");
    quizTfFields.classList.toggle("hidden", type !== "true_false");
    quizIdFields.classList.toggle("hidden", type !== "identification");
  }
  quizType.addEventListener("change", updateTypeFieldsVisibility);
  updateTypeFieldsVisibility();

  // --------------------------------------------------------
  // AI GENERATION (fills the form; presenter can still edit)
  // --------------------------------------------------------
  quizAiGenerateBtn.addEventListener("click", async () => {
    const topic = quizAiTopic.value.trim();
    quizAiStatus.textContent = "Generating…";
    quizAiGenerateBtn.disabled = true;

    try {
      const res = await fetch("/api/quiz/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          type: quizType.value,
          difficulty: quizDifficulty.value,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        quizAiStatus.textContent = data.error || "Generation failed.";
        return;
      }

      quizQuestion.value = data.question || "";

      if (quizType.value === "multiple_choice" && Array.isArray(data.options)) {
        const inputs = mcqOptionInputs();
        inputs.forEach((input, i) => {
          input.value = data.options[i] || "";
        });
        const correctIndex = data.options.findIndex(
          (o) => o.trim().toLowerCase() === String(data.correctAnswer || "").trim().toLowerCase()
        );
        const radios = mcqCorrectRadios();
        if (correctIndex >= 0 && radios[correctIndex]) radios[correctIndex].checked = true;
      } else if (quizType.value === "true_false") {
        quizTfCorrect.value = /true/i.test(data.correctAnswer) ? "True" : "False";
      } else if (quizType.value === "identification") {
        quizIdCorrect.value = data.correctAnswer || "";
      }

      quizAiStatus.textContent = "Generated -- review before launching.";
    } catch (err) {
      console.error(err);
      quizAiStatus.textContent = "Could not reach the server.";
    } finally {
      quizAiGenerateBtn.disabled = false;
    }
  });

  // --------------------------------------------------------
  // BUILD + LAUNCH
  // --------------------------------------------------------
  function buildQuizConfig() {
    const question = quizQuestion.value.trim();
    const type = quizType.value;
    const difficulty = quizDifficulty.value;
    const xp = parseInt(quizXp.value, 10) || 0;
    const timeLimit = quizTimeLimit.value ? parseInt(quizTimeLimit.value, 10) : null;

    if (!question) return { error: "Please enter a question." };

    if (type === "multiple_choice") {
      const options = mcqOptionInputs()
        .map((i) => i.value.trim())
        .filter(Boolean);
      const checkedRadio = mcqCorrectRadios().find((r) => r.checked);
      const correctIndex = checkedRadio ? parseInt(checkedRadio.value, 10) : -1;
      const correctAnswer = mcqOptionInputs()[correctIndex]?.value.trim();

      if (options.length < 2) return { error: "Add at least 2 options." };
      if (!correctAnswer) return { error: "Select which option is correct." };

      return { question, type, options, correctAnswer, xp, difficulty, timeLimit };
    }

    if (type === "true_false") {
      return {
        question,
        type,
        options: ["True", "False"],
        correctAnswer: quizTfCorrect.value,
        xp,
        difficulty,
        timeLimit,
      };
    }

    // identification
    const correctAnswer = quizIdCorrect.value.trim();
    if (!correctAnswer) return { error: "Enter the correct answer." };
    return { question, type, correctAnswer, xp, difficulty, timeLimit };
  }

  quizLaunchBtn.addEventListener("click", () => {
    quizError.textContent = "";
    const config = buildQuizConfig();
    if (config.error) {
      quizError.textContent = config.error;
      return;
    }
    quizFormStatus.textContent = "Launching…";
    socket.emit("quiz-launch", config);
  });

  quizEndBtn.addEventListener("click", () => {
    socket.emit("quiz-end");
  });

  socket.on("quiz-error", (err) => {
    quizError.textContent = err.message || "Could not launch quiz.";
    quizFormStatus.textContent = "";
  });

  // --------------------------------------------------------
  // LIVE STATUS (while a quiz is running)
  // --------------------------------------------------------
  socket.on("quiz-live-status", (status) => {
    quizFormStatus.textContent = "";
    quizBuilder.classList.add("hidden");
    quizResultsPanel.classList.add("hidden");
    quizLiveStatus.classList.remove("hidden");

    const pct = status.total > 0 ? Math.round((status.responded / status.total) * 100) : 0;
    quizProgressFill.style.width = `${pct}%`;
    quizLiveCount.textContent = `${status.responded} / ${status.total} responded (${status.correctCount} correct so far)`;

    quizLiveFeed.innerHTML = "";
    status.feed
      .slice()
      .reverse()
      .forEach((entry) => {
        const row = document.createElement("div");
        row.className = `feed-row ${entry.correct ? "correct" : "incorrect"}`;
        row.innerHTML = `<span>${escapeHtml(entry.username)}</span><span>${entry.correct ? "✓" : "✗"} ${(entry.timeMs / 1000).toFixed(1)}s</span>`;
        quizLiveFeed.appendChild(row);
      });
  });

  // --------------------------------------------------------
  // RESULTS (after a quiz ends)
  // --------------------------------------------------------
  socket.on("quiz-results", (results) => {
    quizLiveStatus.classList.add("hidden");
    quizResultsPanel.classList.remove("hidden");

    quizStatAccuracy.textContent = `${Math.round(results.accuracy * 100)}%`;
    quizStatResponded.textContent = `${results.responded} / ${results.total}`;
    quizStatCorrectAnswer.textContent = results.correctAnswer;

    quizFastestTable.innerHTML = "";
    results.fastest.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(r.username)}</td><td>${(r.timeMs / 1000).toFixed(1)}s</td>`;
      quizFastestTable.appendChild(tr);
    });

    quizLeaderboardTable.innerHTML = "";
    results.leaderboard.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.rank}</td><td>${escapeHtml(r.username)}</td><td>${escapeHtml(String(r.answer))}</td><td>${r.correct ? "✓ Correct" : "✗ Incorrect"}</td><td>${(r.timeMs / 1000).toFixed(1)}s</td>`;
      quizLeaderboardTable.appendChild(tr);
    });

    // Give the presenter a way back to building the next question.
    const backBtn = document.createElement("button");
    backBtn.textContent = "New Quiz";
    backBtn.style.marginTop = "12px";
    backBtn.addEventListener("click", () => {
      quizResultsPanel.classList.add("hidden");
      quizBuilder.classList.remove("hidden");
      quizError.textContent = "";
      quizFormStatus.textContent = "";
    }, { once: true });
    quizResultsPanel.appendChild(backBtn);
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }
})();