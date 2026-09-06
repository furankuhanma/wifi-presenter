// ============================================================
// render.js  (v4 — image-based slides, mobile-aware sizing)
// ============================================================
// Shared between viewer.html and presenter.html.
//
// Each slide is a single pre-rendered image (public/images/*.png),
// shown full-bleed inside the "stage" div. This file's job is to
// show that image and keep the stage scaled to match its own
// aspect ratio -- including on phones, where the visible viewport
// size changes as the browser's address bar shows/hides.
//
// Public API is UNCHANGED (setDeckInfo / renderSlide / fitStage):
//   - setDeckInfo() is a harmless no-op.
//   - renderSlide(stageEl, slideData) expects slideData shaped like
//     { index, total, image } (an image URL).
//   - fitStage(outerEl, stageEl, rotated) sizes+positions the stage.
//     The stage's native width/height come from the loaded image's
//     natural dimensions. Because that arrives asynchronously,
//     fitStage remembers the (outerEl, rotated) it was last called
//     with, so renderSlide can re-run the fit itself once the image
//     finishes loading.
//
// WHAT'S NEW IN THIS VERSION:
//   - fitStage now reads the outer container's size via
//     getBoundingClientRect() instead of clientWidth/clientHeight.
//     On mobile browsers mid-address-bar-transition, clientWidth/
//     Height can report a stale value for a frame; getBoundingClientRect
//     is consistently accurate.
//   - A single shared listener on window.visualViewport (when
//     available) re-fits ALL stages that have been fit at least once.
//     Mobile browsers fire viewport-size changes (address bar
//     hide/show, on-screen keyboard, pinch-zoom) through
//     visualViewport's resize/scroll events, NOT always through the
//     regular window "resize" event -- so relying only on window
//     resize leaves the stage the wrong size after those changes.
//   - Falls back to window "resize"/"orientationchange" automatically
//     when visualViewport isn't supported (older browsers).
// ============================================================

// Tracks every stage that's had fitStage() called on it, so the
// shared viewport listener below can re-fit all of them at once.
const _trackedStages = new Set();

// Kept as a no-op for backwards compatibility with viewer.js /
// presenter.js, which still call this once per connection. There's
// no deck-level sizing info to record anymore -- each slide image
// reports its own natural size once it loads (see renderSlide).
function setDeckInfo(_stageEl, _deckInfo) {
  // Intentionally does nothing.
}

// Renders one slide. Call this on every "slide-update".
function renderSlide(stageEl, slideData) {
  stageEl.innerHTML = "";
  stageEl.style.background = "#000";

  const imageUrl = slideData && slideData.image;
  if (!imageUrl) {
    // No slide image available (e.g. public/images/ is empty or the
    // requested index is out of range) -- leave the stage blank
    // rather than showing a broken image icon.
    return;
  }

  const img = document.createElement("img");
  img.className = "slide-image-full";
  img.alt = "";
  img.src = imageUrl;

  img.addEventListener("load", () => {
    stageEl.dataset.slideWidth = img.naturalWidth;
    stageEl.dataset.slideHeight = img.naturalHeight;

    // If fitStage has already been called at least once for this
    // stage, re-run it now that we actually know the image's real
    // aspect ratio -- otherwise the stage would keep whatever size
    // (or zero size) it had before the image arrived.
    if (stageEl._fitOuter) {
      fitStage(stageEl._fitOuter, stageEl, stageEl._fitRotated);
    }
  });

  stageEl.appendChild(img);
}

// ------------------------------------------------------------
// STAGE FITTING (size, orientation)
// ------------------------------------------------------------
// outerEl: the full-size container (e.g. the stage-outer div)
// stageEl: the slide itself, sized to the current slide image's
//          native aspect ratio
// rotated: true = rotate the stage 90deg so a landscape deck
//          better fills a portrait phone screen
function fitStage(outerEl, stageEl, rotated) {
  // Remember these so renderSlide can re-fit once a newly-loaded
  // image reports its natural size, and so the shared viewport
  // listener below can re-fit this stage too.
  stageEl._fitOuter = outerEl;
  stageEl._fitRotated = rotated;
  _trackedStages.add(stageEl);

  const slideWidth = Number(stageEl.dataset.slideWidth);
  const slideHeight = Number(stageEl.dataset.slideHeight);
  if (!slideWidth || !slideHeight) return;

  // getBoundingClientRect() (rather than clientWidth/clientHeight)
  // avoids a stale read on mobile browsers mid-way through an
  // address-bar show/hide animation.
  const outerRect = outerEl.getBoundingClientRect();
  const availW = outerRect.width;
  const availH = outerRect.height;
  if (!availW || !availH) return;

  const ratio = slideWidth / slideHeight;

  let w, h;
  if (!rotated) {
    w = availW;
    h = w / ratio;
    if (h > availH) {
      h = availH;
      w = h * ratio;
    }
  } else {
    // After a 90deg rotation the stage's own width becomes its visual
    // height and vice versa, so solve for that swapped fit.
    h = availW;
    w = h * ratio;
    if (w > availH) {
      w = availH;
      h = w / ratio;
    }
  }

  stageEl.style.width = `${w}px`;
  stageEl.style.height = `${h}px`;
  stageEl.style.transform = rotated ? "rotate(90deg)" : "none";
}

// Suggests whether the stage should start rotated, based on comparing
// the slide's own orientation to the screen's current orientation --
// e.g. a landscape (16:9) slide on a portrait phone fits much better
// rotated 90deg. Callers (viewer.js) can use this to pick a sane
// default instead of always starting unrotated and making the user
// discover the Rotate button themselves.
function suggestRotation(slideWidth, slideHeight, viewportWidth, viewportHeight) {
  if (!slideWidth || !slideHeight || !viewportWidth || !viewportHeight) return false;
  const slideIsLandscape = slideWidth >= slideHeight;
  const viewportIsPortrait = viewportHeight > viewportWidth;
  return slideIsLandscape && viewportIsPortrait;
}

// ------------------------------------------------------------
// SHARED VIEWPORT-CHANGE LISTENER
// ------------------------------------------------------------
// Re-fits every stage that's been fit at least once, whenever the
// visible viewport actually changes size. Mobile browsers fire this
// through window.visualViewport (address bar hide/show, on-screen
// keyboard opening, pinch-zoom) far more reliably than through the
// plain window "resize" event, which some mobile browsers barely
// fire at all for those cases.
function _refitAllTrackedStages() {
  _trackedStages.forEach((stageEl) => {
    if (stageEl.isConnected && stageEl._fitOuter) {
      fitStage(stageEl._fitOuter, stageEl, stageEl._fitRotated);
    } else {
      // Stage was removed from the page (e.g. navigated away) --
      // stop tracking it.
      _trackedStages.delete(stageEl);
    }
  });
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", _refitAllTrackedStages);
  window.visualViewport.addEventListener("scroll", _refitAllTrackedStages);
}
// Always ALSO listen to these, as a fallback for browsers without
// visualViewport support and for changes it doesn't cover (e.g. some
// desktop window-resize cases).
window.addEventListener("resize", _refitAllTrackedStages);
window.addEventListener("orientationchange", () => {
  // iOS reports the new orientation's dimensions a beat late.
  setTimeout(_refitAllTrackedStages, 250);
});