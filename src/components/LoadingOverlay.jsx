import { usePipeline } from '../context/PipelineContext';

const STEPS = [
  { key: 'stripping', label: 'Preparing Image' },
  { key: 'detecting', label: 'Detecting Faces' },
  { key: 'blurring', label: 'Applying Effects' },
];

export default function LoadingOverlay() {
  const { status, error } = usePipeline();

  if (status === 'idle' || status === 'ready') return null;

  if (status === 'error') {
    return (
      <div className="loading-overlay">
        <div className="loading-card loading-error">
          <div className="loading-icon">!</div>
          <p>{error || 'Something went wrong'}</p>
        </div>
      </div>
    );
  }

  const stepIndex = STEPS.findIndex(s => s.key === status);
  const currentStep = stepIndex >= 0 ? stepIndex : 0;

  return (
    <div className="loading-overlay">
      <div className="loading-card">
        <div className="loading-spinner" />
        <p className="loading-label">{STEPS[currentStep]?.label || 'Processing...'}</p>
        <div className="loading-steps">
          {STEPS.map((s, i) => (
            <div key={s.key} className="loading-step-item">
              <div className={`loading-step ${i < currentStep ? 'done' : ''} ${i === currentStep ? 'active' : ''}`} />
              <span className="loading-step-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
