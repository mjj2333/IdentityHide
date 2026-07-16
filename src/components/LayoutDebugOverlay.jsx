import { useState, useEffect } from 'react';

/**
 * TEMPORARY on-screen layout probe for debugging the iOS mask-editor toolbar
 * clipping (the bottom category tabs get pushed off-screen). Renders the live
 * bounding boxes of the key elements as text, fixed to the top of the screen,
 * so measurements can be read directly off the device — no Web Inspector
 * (Release-build WebViews aren't inspectable). Remove this file + its usage in
 * App.jsx once the layout bug is fixed.
 */
export default function LayoutDebugOverlay() {
  const [txt, setTxt] = useState('measuring…');

  useEffect(() => {
    const targets = [
      ['toolbar', '.mask-editor-toolbar'],
      ['tabs', '.toolbar-tabs'],
      ['tabBtn', '.toolbar-tab'],
    ];
    const tick = () => {
      const lines = targets.map(([label, sel]) => {
        const el = document.querySelector(sel);
        if (!el) return `${label} NA`;
        const r = el.getBoundingClientRect();
        return `${label} ${Math.round(r.top)}-${Math.round(r.bottom)} (h${Math.round(r.height)})`;
      });
      const cs = getComputedStyle(document.documentElement);
      const safe = cs.getPropertyValue('--safe-area-bottom').trim();
      const safeLine = window.innerHeight - (parseFloat(safe) || 0);
      setTxt(`winH=${window.innerHeight} safeBot=${safe} homeLine=${safeLine}\n${lines.join('\n')}`);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 'env(safe-area-inset-top, 0px)',
        left: 0,
        zIndex: 99999,
        background: 'rgba(200,0,0,0.9)',
        color: '#fff',
        font: '11px/1.35 monospace',
        padding: '4px 7px',
        whiteSpace: 'pre',
        pointerEvents: 'none',
        borderBottomRightRadius: 6,
      }}
    >
      {txt}
    </div>
  );
}
