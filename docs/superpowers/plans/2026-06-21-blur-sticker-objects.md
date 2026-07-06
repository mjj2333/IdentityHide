# Blur Objects + Sticker Objects Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (inline) to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax. This codebase verifies UI/canvas work by `npx vite build` + a Netlify **draft** deploy for manual testing on device — there is no automated test for the editor canvas. The blur engine is pure and could be unit-tested, but the project has no `blurEngine` test today, so we verify the engine via the live preview.

**Goal:** Make blur and stickers two independent object types you place, move, and resize separately — instead of a global blur with a global sticker overlay stamped on every region.

**Architecture:** Each item in the region array (`editDets`) gets a `kind: 'blur' | 'sticker'`. Blur objects are ovals that blur; sticker objects carry their own `barStyle/barColor/barWidth/barLength/barAngle` and are stamped centered on their own box. The engine blurs all `blur` objects first, then stamps each `sticker` object (with its own color) on top. Freehand brush mode is left as-is.

**Tech Stack:** React + Vite, canvas 2D, existing DOM-overlay region editor.

---

## Key design decisions (locked from brainstorming)

- **Two object kinds** in one `editDets` array: `kind:'blur'` (oval region) and `kind:'sticker'` (placed sticker). Auto-detected faces are `kind:'blur'`.
- **Per-sticker** style, color, width, length, angle — stored on each sticker object. The Stickers dropdown + Width/Length/Angle sliders edit the **selected** sticker (and set the defaults used for the **next** Add Sticker).
- **Blur type** (Gaussian/Pixelate), **Strength**, **Feather** stay global (apply to all blur objects + freehand blur brush).
- **Rectangle shape removed** — blur objects are always oval.
- **Auto mode**: detection makes blur objects; "+ Add Sticker" lets you place stickers by hand. No manual blur objects there.
- **Shape mode**: "+ Add Blur" and "+ Add Sticker".
- **Freehand mode unchanged**: brush paints blur (`mode`) or a single color (`stickerEnabled` + `barColor`). `stickerEnabled` survives only as the freehand brush-color flag; it is no longer shown in Auto/Shape.
- **Migration**: any `editDets` item without `kind` loads as `kind:'blur'`. Old saved sessions that had a global sticker overlay simply lose it (4h TTL, in-flight only) — acceptable.

## Object shapes

```js
// Blur object (oval region; auto faces + manual)
{ kind: 'blur', topLeft:[x,y], bottomRight:[x,y], origHw, origHh,
  manual:false, probability, contour, keypoints, segData, enabled? }

// Sticker object (placed independently)
{ kind: 'sticker', topLeft:[x,y], bottomRight:[x,y], origHw, origHh, manual:true,
  barStyle, barColor, barWidth, barLength, barAngle }
```

## New engine contract

```js
applyMaskedBlur(sourceCanvas, blurMask, mode, strength,
                stickerObjects = [],            // array of sticker objects (own params)
                freehandStickerMask = null,     // freehand color-brush strokes
                freehandStickerColor = '#000000')
```
- PASS 1 (blur): if `mode` is `gaussian`/`pixelate` and `blurMask` has pixels → existing crop-blur.
- PASS 2 (stickers): if `freehandStickerMask` → blend it toward `freehandStickerColor`; then for each `stickerObject` → stamp its shape centered on its box (sized `barWidth%`×`barLength%` of box, rotated `barAngle`) and blend toward **its own** `barColor`.

---

## File structure

- `src/utils/blurEngine.js` — rewrite `applyStickerPass`, extract `blendMaskTowardColor`, change `applyMaskedBlur` signature, drop the legacy `'blackbar'`/`barSettings`/`detections` path. (~Task 1)
- `src/components/MaskEditorScreen.jsx` — det kinds, Add Blur/Add Sticker, sticker selection controls, preview split, toolbar. (Tasks 2,4,7)
- `src/components/BatchEditorScreen.jsx` — mirror. (Task 5)
- `src/components/ReviewScreen.jsx` — final apply split. (Task 6)
- `src/utils/batchProcessor.js` — batch apply split. (Task 6)
- `src/components/BatchGridScreen.jsx` — global regen split. (Task 6)
- `src/context/PipelineContext.jsx`, `src/context/BatchContext.jsx` — defaults unchanged shape; verify. (Task 7)
- `src/utils/sessionStore.js` — migration on restore. (Task 2)

---

## Task 1: Engine — per-object sticker rendering

**Files:** Modify `src/utils/blurEngine.js`

- [ ] **Step 1: Extract a `blendMaskTowardColor` helper.** Add near `applyStickerPass`:

```js
// Blend outCtx's current pixels toward `colorHex` wherever `maskCanvas` has
// alpha. Used per sticker (each its own color) and for freehand color strokes.
function blendMaskTowardColor(outCtx, maskCanvas, colorHex, width, height) {
  const [tr, tg, tb] = parseHexColor(colorHex);
  const outData = outCtx.getImageData(0, 0, width, height);
  const maskData = maskCanvas.getContext('2d').getImageData(0, 0, width, height);
  const od = outData.data;
  const md = maskData.data;
  for (let i = 0; i < od.length; i += 4) {
    const a = md[i + 3];
    if (a > 0) {
      const t = a / 255;
      od[i] = Math.round(od[i] * (1 - t) + tr * t);
      od[i + 1] = Math.round(od[i + 1] * (1 - t) + tg * t);
      od[i + 2] = Math.round(od[i + 2] * (1 - t) + tb * t);
    }
  }
  outCtx.putImageData(outData, 0, 0);
}
```

- [ ] **Step 2: Rewrite `applyStickerPass`** to take sticker objects (own params, centered on box) + freehand strokes:

```js
function applyStickerPass(outCtx, stickerObjects, freehandStickerMask, freehandStickerColor, width, height) {
  // Freehand color-brush strokes blend toward the single freehand color.
  if (freehandStickerMask) {
    blendMaskTowardColor(outCtx, freehandStickerMask, freehandStickerColor || DEFAULT_BAR_COLOR, width, height);
  }
  // Each sticker object: own shape/size/angle, stamped CENTERED on its box,
  // blended toward its OWN color, on top of whatever is already there.
  for (const s of (stickerObjects || [])) {
    const x = s.topLeft[0], y = s.topLeft[1];
    const bw = s.bottomRight[0] - x, bh = s.bottomRight[1] - y;
    if (bw <= 0 || bh <= 0) continue;
    const cx = x + bw / 2, cy = y + bh / 2;
    const barH = bh * ((s.barWidth ?? 100) / 100);
    const barW = bw * ((s.barLength ?? 100) / 100);
    const angle = ((s.barAngle || 0) * Math.PI) / 180;
    const style = s.barStyle || DEFAULT_BAR_STYLE;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    drawStyledBarToMask(maskCanvas.getContext('2d'), cx, cy, barW, barH, angle, style);
    blendMaskTowardColor(outCtx, maskCanvas, s.barColor || DEFAULT_BAR_COLOR, width, height);
  }
}
```

- [ ] **Step 3: Update `applyMaskedBlur` signature + body.** Replace the current signature and the legacy `'blackbar'` block + PASS 2 call:

```js
export function applyMaskedBlur(sourceCanvas, blurMask, mode = 'gaussian', strength = 20,
                                stickerObjects = [], freehandStickerMask = null, freehandStickerColor = '#000000') {
  const { width, height } = sourceCanvas;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(sourceCanvas, 0, 0);

  if ((mode === 'gaussian' || mode === 'pixelate') && blurMask) {
    applyBlurPass(outCanvas, outCtx, sourceCanvas, blurMask, mode, strength, width, height);
  }

  const hasStickers = (stickerObjects && stickerObjects.length > 0) || !!freehandStickerMask;
  if (hasStickers) {
    applyStickerPass(outCtx, stickerObjects, freehandStickerMask, freehandStickerColor, width, height);
  }
  return outCanvas;
}
```

Delete the old `barSettings`/`detections`/`stickerEnabled`/`stickerMask` params and the `if (mode === 'blackbar')` legacy alias block. Keep `applyBlurPass`, `drawStyledBarToMask`, `parseHexColor`, `BAR_STYLES`, `DEFAULT_BAR_STYLE`, `DEFAULT_BAR_COLOR`, `migrateBlurSettings` unchanged. The `BLACKBAR_EYE_Y_RATIO` constant is now only used by `applyBlurPass`? No — it was only used in the old sticker stamping; it can stay unused or be removed.

- [ ] **Step 4: Verify build.** Run `npx vite build` — expect failures in callers (next tasks fix them). The engine file itself must parse. If only caller errors remain, proceed.

---

## Task 2: Data model `kind` + migration

**Files:** Modify `src/components/MaskEditorScreen.jsx`, `src/utils/sessionStore.js`, `src/components/BatchEditorScreen.jsx`

- [ ] **Step 1: `handleAutoDetect` (MaskEditorScreen ~245) — tag blur kind.** When mapping detections into `editDets`, add `kind: 'blur'` to each new det.

- [ ] **Step 2: `handleAddRegion` → `handleAddBlur` (MaskEditorScreen ~595).** Always oval, `kind:'blur'`:

```js
const handleAddBlur = useCallback(() => {
  const hw = imgW * 0.075;
  const hh = hw * 1.3;
  const cx = imgW / 2, cy = imgH / 2;
  const newDet = {
    kind: 'blur',
    topLeft: [cx - hw, cy - hh], bottomRight: [cx + hw, cy + hh],
    origHw: hw, origHh: hh, probability: 1, contour: [], keypoints: null,
    segData: null, manual: true,
  };
  setEditDets(prev => [...prev, newDet]);
  setSelectedOvalIdx(editDetsRef.current.length); // select the new one
  track('blur_region_added');
}, [imgW, imgH, setEditDets]);
```

- [ ] **Step 3: New `handleAddSticker` (MaskEditorScreen).** Creates a bar-shaped box with default sticker params pulled from `blurSettings`:

```js
const handleAddSticker = useCallback(() => {
  const hw = imgW * 0.12;          // wide
  const hh = imgW * 0.035;         // short → bar aspect
  const cx = imgW / 2, cy = imgH / 2;
  const bs = blurSettingsRef.current;
  const newDet = {
    kind: 'sticker',
    topLeft: [cx - hw, cy - hh], bottomRight: [cx + hw, cy + hh],
    origHw: hw, origHh: hh, manual: true,
    barStyle: bs.barStyle || 'solid',
    barColor: bs.barColor || '#000000',
    barWidth: 100, barLength: 100, barAngle: 0,
  };
  setEditDets(prev => [...prev, newDet]);
  setSelectedOvalIdx(editDetsRef.current.length);
  track('sticker_added', { style: newDet.barStyle });
}, [imgW, imgH, setEditDets]);
```

- [ ] **Step 4: Migration in `sessionStore.js` restore (~148).** After `editDets: data.editDets || []`, normalize: `(data.editDets || []).map(d => ({ kind: 'blur', ...d }))` so older items default to blur but explicit `kind` (when present) wins. (Spread after so saved `kind` overrides.) Actually use: `({ ...d, kind: d.kind || 'blur' })`.

- [ ] **Step 5: BatchEditor init (~160-203).** When mapping `imageEntry.editDetections`, add `kind: d.kind || 'blur'` to each.

- [ ] **Step 6: Build.** `npx vite build` — caller errors expected until Tasks 3-6.

---

## Task 3: Mask builders filter to blur kind

**Files:** `src/components/MaskEditorScreen.jsx` (`buildPreviewMask`), `src/components/ReviewScreen.jsx` (`buildCombinedMask`), `src/utils/batchProcessor.js` (`buildFaceMask`)

- [ ] **Step 1:** In each builder's region loop, skip non-blur items. Change `for (const det of dets)` body to start with `if (det.kind === 'sticker') continue;`. (Blur + undefined kinds still paint.) The builder already only paints shapes when `mode !== 'blackbar'`; keep oval-only (remove the `det.shape === 'rectangle'` branch — always ellipse).

- [ ] **Step 2: Build.** Parse check.

---

## Task 4: MaskEditorScreen UI — buttons, selection, preview, toolbar

**Files:** `src/components/MaskEditorScreen.jsx`

- [ ] **Step 1: Split preview in `updateBlurPreview` (~319).** Replace the blurMask/stickerMask/barSettings logic:

```js
const dets = editDetsRef.current;
const blurDets = dets.filter(d => d.kind !== 'sticker');
const stickerObjects = dets.filter(d => d.kind === 'sticker');
const bs = blurSettingsRef.current;
const mode = bs.mode;
const wantBlur = mode === 'gaussian' || mode === 'pixelate';
// blurMask = blur regions (+ freehand blur strokes when in freehand-blur)
const blurMask = wantBlur ? buildPreviewMask(blurDets, 'gaussian') : null;
// freehand color strokes only when freehand brush is in color mode
const freehandStickerMask = bs.stickerEnabled ? buildPreviewMask([], 'blackbar') : null;
const hasBlur = !!blurMask && maskHasPixels(blurMask);
const hasSticker = stickerObjects.length > 0 || (!!freehandStickerMask && maskHasPixels(freehandStickerMask));
if (!hasBlur && !hasSticker) { blurPreviewRef.current = null; }
else {
  blurPreviewRef.current = applyMaskedBlur(
    src, blurMask, wantBlur ? mode : 'none', bs.strength,
    stickerObjects, freehandStickerMask, bs.barColor || '#000000');
}
```
(`buildPreviewMask([], 'blackbar')` returns only the freehand canvas strokes.)

- [ ] **Step 2: Region overlays (~1520).** Differentiate kinds for hit/visual; both stay draggable/selectable. Add a class for stickers and skip the oval styling:

```jsx
className={`face-overlay${selectedOvalIdx === i ? ' selected' : ''}${det.kind === 'sticker' ? ' sticker-overlay' : ''}`}
```
(`.sticker-overlay` gets a rectangular dashed outline in CSS; blur stays oval.)

- [ ] **Step 3: Selected-object controls (`selectedBlurRegionRow`, ~1168).** Branch on the selected det's kind. For a **sticker**, show Width/Length/Angle sliders + the style/color dropdown bound to that sticker + Remove. For a **blur**, the existing Resize + Remove. Bind the Width/Length/Angle/style/color edits to mutate the selected det (not `blurSettings`). Add a helper:

```js
const updateSelectedSticker = useCallback((patch) => {
  setEditDets(prev => prev.map((d, i) => i === selectedOvalIdx ? { ...d, ...patch } : d));
  // also store as defaults for next Add Sticker
  setBlurSettings(s => ({ ...s, ...patch }));
}, [selectedOvalIdx, setEditDets, setBlurSettings]);
```
Wire the existing Width/Length/Angle sliders + bar-style dropdown + color picker to call `updateSelectedSticker({ barWidth })` etc. when a sticker is selected.

- [ ] **Step 4: Sub-mode panels.**
  - Shape panel (~1276): replace `+ Add` and the Oval/Rectangle toggle with two buttons: **+ Add Blur** (`handleAddBlur`) and **+ Add Sticker** (`handleAddSticker`).
  - Auto panel (~1307): keep Detect Faces + Clear All, add **+ Add Sticker** (`handleAddSticker`).
  - Remove the `shapeType` state, the `setShapeType` effect that forced rectangle when `stickerEnabled`, and the oval/rectangle toggle JSX.

- [ ] **Step 5: Toolbar selector (~945).** In Auto/Shape: keep Gaussian/Pixelate as the blur **type** (always one active; remove the deselect-to-`none` behavior so a blur object always has a type). The **Stickers dropdown** stays but now sets the **current** sticker style/color: picking a style/color calls `updateSelectedSticker` if a sticker is selected, else sets the `blurSettings` defaults for the next Add Sticker. Remove the "Turn off stickers" item and the global on/off semantics. Freehand keeps its existing Gaussian/Pixelate/Colors exclusive selector untouched.

- [ ] **Step 6: Width/Length/Angle sliders (`blurAdjustmentsRow`, ~1100).** Show **Strength + Feather** when blur type active (global). Show **Width/Length/Angle** only when a **sticker is selected**, bound to that sticker via `updateSelectedSticker`. (No global sticker sliders.)

- [ ] **Step 7: Build + smoke check parse.** `npx vite build`.

---

## Task 5: BatchEditorScreen — mirror Task 2+4

**Files:** `src/components/BatchEditorScreen.jsx`

- [ ] **Step 1:** Mirror `handleAddBlur` / `handleAddSticker`, the `kind` filters in `updateBlurPreview` (use `localMode`, `localStickerEnabled`, `localBarColor`, and `editDets`/`selectedIdx`), the overlay class, the selected-sticker controls (`updateSelectedSticker` mutating `editDets` + the `local*` defaults), and the same sub-mode panel + toolbar changes. Use the batch local-state equivalents.
- [ ] **Step 2:** `handleDone` persist (~669): `editDetections: editDets` already carries `kind` per item; no shape change needed beyond ensuring sticker objects are included.
- [ ] **Step 3: Build.**

---

## Task 6: Apply/export paths

**Files:** `src/components/ReviewScreen.jsx`, `src/utils/batchProcessor.js`, `src/components/BatchGridScreen.jsx`

- [ ] **Step 1: ReviewScreen `applyFullBlur` (~122).** Split `dets` into `blurDets`/`stickerObjects`; `blurMask = buildCombinedMask(blurDets, 'gaussian')` when blur active; `freehandStickerMask = stickerEnabled ? buildCombinedMask([], 'blackbar') : null`; call `applyMaskedBlur(base, blurMask, wantBlur?mode:'none', strength, stickerObjects, freehandStickerMask, bs.barColor)`.

- [ ] **Step 2: batchProcessor `applyFaceBlurToCanvas` (~174).** Same split using the per-image `dets` and `settings`. `buildFaceMask` already filters sticker kind (Task 3). Build `stickerObjects = dets.filter(d => d.kind === 'sticker')`. Call the new engine signature. `freehandStickerMask` = the faceBrushCanvas when `settings.stickerEnabled` (freehand color), else null; pass `settings.barColor`.

- [ ] **Step 3: BatchGridScreen regen (~117).** This path has no manual objects (auto faces only). Detections are `kind:'blur'` (ensure they're tagged when stored, or filter is a no-op since none are stickers). Call `applyMaskedBlur(img.strippedCanvas, blurMask, wantBlur?mode:'none', strength, [], null, globalBlurSettings.barColor)` — i.e. no sticker objects in the global grid preview. (Per-image stickers show in the per-image editor/export, not the grid thumbnail — acceptable; note it.)

- [ ] **Step 4: `useImagePipeline` recomposite (~272).** It calls `applyMaskedBlur(resultCanvas, faceMask, blurMode, blurRadius, faceDetections)` — `faceDetections` was the 5th arg (old `detections`); now the 5th arg is `stickerObjects`. Pass `[]` instead (auto-blur-after-inpaint never stamped stickers): `applyMaskedBlur(resultCanvas, faceMask, blurMode, blurRadius, [])`.

- [ ] **Step 5: Build.** `npx vite build` — expect clean now.

---

## Task 7: Contexts, rectangle removal cleanup, defaults

**Files:** `src/context/PipelineContext.jsx`, `src/context/BatchContext.jsx`, both editors, `src/styles/global.css`

- [ ] **Step 1:** `blurSettings` keeps its current fields. `mode` is now only `gaussian`/`pixelate` (default `gaussian`); `stickerEnabled` remains (freehand color-brush flag); `barStyle/barColor/barWidth/barLength/barAngle` are the **defaults for new stickers** + freehand color. No schema change required; confirm reset values still valid.
- [ ] **Step 2:** Remove any remaining `shapeType` / oval-rectangle toggle code in both editors and the `.shape-toggle` usage. Remove the `det.shape === 'rectangle'` overlay class branch.
- [ ] **Step 3:** Add CSS `.face-overlay.sticker-overlay` (rectangular dashed outline, distinct accent) so stickers read differently from blur ovals.
- [ ] **Step 4: Build.**

---

## Task 8: Verify + deploy

- [ ] **Step 1:** `npx vite build` — clean.
- [ ] **Step 2:** `npx netlify deploy --dir=dist --alias rid` — draft.
- [ ] **Step 3: Manual test checklist (single image):**
  - Shape mode: + Add Blur → oval blurs; move/resize works.
  - Shape mode: + Add Sticker → bar appears centered on its box; move/resize/rotate (Angle) works; style/color per sticker.
  - One blur + one sticker overlapping → blur under, sticker on top; each adjustable independently.
  - Auto mode: Detect Faces → faces blur; + Add Sticker places a bar; bars are not auto-stamped on faces.
  - Apply → Review shows the same; Export matches.
  - Freehand mode still paints blur and color as before.
- [ ] **Step 4: Batch test:** per-image editor add blur + sticker, Done, Process/Export reflects both.
- [ ] **Step 5:** Report draft URL + QR.

---

## Self-review notes
- **Spec coverage:** two object kinds ✅ (T2), per-sticker params ✅ (T1/T4), Add Blur/Add Sticker ✅ (T4/T5), auto = blur + manual stickers ✅ (T4/T6), rectangle removed ✅ (T3/T7), independent move/resize ✅ (reuses existing drag/resize, T4), blur-under-sticker order ✅ (engine PASS order, T1).
- **Signature consistency:** new `applyMaskedBlur(source, blurMask, mode, strength, stickerObjects, freehandStickerMask, freehandStickerColor)` used identically in all 5 call sites (T1/T4/T5/T6).
- **Risk:** `useImagePipeline` 5th-arg change (was detections, now stickerObjects) — handled in T6 Step 4. Session migration handled T2 Step 4/5. BatchGrid thumbnails won't show per-image stickers — noted, acceptable.
