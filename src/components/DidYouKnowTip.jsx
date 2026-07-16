import { useState, useEffect } from 'react';

/**
 * Rotating "Did you know?" card shown during long waits (single-image
 * ComfyUI processing for premium users; batch processing for anyone since
 * batch is premium-gated anyway). Rotates every 16 seconds; starts on a
 * random index so consecutive Applies don't always lead with the same tip.
 *
 * Parents own the show/hide decision — this component always renders when
 * mounted. Reuses the `.apply-tip` CSS block from global.css.
 */
const DID_YOU_KNOW = [
  'Face blur and metadata stripping run entirely in your browser — they never leave your device.',
  'Metadata stripping removes GPS coordinates, camera model, timestamps, and software signatures.',
  'AI-powered recognition can match faces, tattoos, and other subtle features — even in photos that look anonymous.',
  'Tattoo removal uses AI inpainting to reconstruct what skin would look like underneath.',
  'Tattoo removal runs on our server; we use your image only to return your result, never to train AI or share it.',
  'EXIF timestamps reveal routines: when you are home, when you travel, when you sleep. Stripping them breaks that map.',
  'EXIF data embedded in a single photo can reveal your location, device, and exact moment of capture.',
  'Pinch to zoom in for finer tattoo masks — precision helps the AI fill in realistic skin.',
  'You can Touch Up after seeing the result to refine any areas that need more work.',
  'Solid black bars are the most reliable way to hide features — heavy blur can sometimes be reversed by AI.',
  'Processing time scales with image size — using the Quick tier on import gives faster results.',
  'Tattoo removal works best on flat, well-lit areas — wrinkled or shadowed skin can need a touch-up pass.',
  'Tattoo removal only reconstructs what you mark — fine-edge painting gives cleaner skin than broad strokes.',
  'Photo metadata can reveal your device model, operating system, editing software, and even lens type — enough to link you across anonymous accounts.',
];

export default function DidYouKnowTip() {
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * DID_YOU_KNOW.length));
  useEffect(() => {
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % DID_YOU_KNOW.length);
    }, 16000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="apply-tip" aria-live="polite">
      <div className="apply-tip-label">Did you know?</div>
      <p className="apply-tip-body">{DID_YOU_KNOW[tipIndex]}</p>
    </div>
  );
}
