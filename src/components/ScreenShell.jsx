export default function ScreenShell({
  backAction,
  backLabel = 'Back',
  primaryAction,
  primaryLabel,
  primaryDisabled,
  primaryRef,
  stepLabel,
  toolbar,
  toolbarClassName = '',
  className = '',
  contentClassName = '',
  children,
}) {
  const shellClassName = ['screen-shell', className].filter(Boolean).join(' ');
  const contentClassNames = ['screen-content', contentClassName].filter(Boolean).join(' ');
  const toolbarClassNames = ['screen-bottom-toolbar', toolbarClassName].filter(Boolean).join(' ');

  return (
    <div className={shellClassName}>
      <header className="screen-top-bar">
        <div className="top-bar-side top-bar-side-left">
          {backAction ? (
            <button type="button" aria-label={backLabel || 'Back'} className="btn btn-ghost top-back-btn" onClick={backAction}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              {backLabel}
            </button>
          ) : null}
        </div>
        <div className="top-bar-brand">
          <span className="brand-text">IdentityHide</span>
          {stepLabel && <span className="brand-step-label">{stepLabel}</span>}
        </div>
        <div className="top-bar-side top-bar-side-right">
          {primaryAction && (
            <button ref={primaryRef} type="button" aria-label={primaryLabel || 'Continue'} className="btn btn-primary top-primary-btn" onClick={primaryAction} disabled={primaryDisabled}>
              {primaryLabel}
            </button>
          )}
        </div>
      </header>
      <main className={contentClassNames}>
        {children}
      </main>
      {toolbar && (
        <nav className={toolbarClassNames} aria-label="Tools">
          {toolbar}
        </nav>
      )}
    </div>
  );
}
