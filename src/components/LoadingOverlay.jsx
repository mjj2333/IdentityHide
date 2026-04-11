import { usePipeline } from '../context/PipelineContext';

const STEPS = [
  { key: 'stripping', label: 'Preparing Image' },
  { key: 'detecting', label: 'Detecting Faces' },
  { key: 'blurring', label: 'Applying Effects' },
];

export default function LoadingOverlay() {
  const { status, error, reset } = usePipeline();

  if (status === 'idle' || status === 'ready') return null;

  if (status === 'error') {
    return (
      <div className="loading-overlay">
        <div
          className="loading-card loading-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div className="loading-icon" aria-hidden="true">!</div>
          <p>{error || 'Something went wrong'}</p>
          <button className="btn btn-secondary" onClick={reset}>
            Start Over
          </button>
        </div>
      </div>
    );
  }

  const stepIndex = STEPS.findIndex(s => s.key === status);
  const currentStep = stepIndex >= 0 ? stepIndex : 0;
  const currentLabel = STEPS[currentStep]?.label || 'Processing...';

  return (
    <div className="loading-overlay">
      <div
        className="loading-card"
        role="status"
        aria-live="polite"
        aria-label={`${currentLabel}, step ${currentStep + 1} of ${STEPS.length}`}
      >
        <div className="loading-spinner" aria-hidden="true" />
        <p className="loading-label">{currentLabel}</p>
        <div className="loading-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <div key={s.key} className="loading-step-item">
              <div className={`loading-step ${i < currentStep ? 'done' : ''} ${i === currentStep ? 'active' : ''}`} />
              <span className="loading-step-label">{s.label}</span>
            </div>
          ))}
        </div>
        <button className="btn btn-secondary" onClick={reset}>
          Cancel
        </button>
      </div>
    </div>
  );
}
