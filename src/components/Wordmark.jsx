/**
 * Redact.ID wordmark. Renders the brand lockup with the correct small-caps
 * treatment and the 35%-opacity ".ID" suffix. Use the `size` prop to pick
 * between hero (Home), header (Editor/Review/Save), or a custom pixel size.
 *
 * Layout of the underlying CSS is in global.css under `.wordmark`.
 */
export default function Wordmark({ size = 'header', stepLabel, as: Tag = 'div', className = '', style }) {
  const cls = [
    'wordmark',
    size === 'hero' ? 'wordmark--hero' : size === 'header' ? 'wordmark--header' : '',
    className,
  ].filter(Boolean).join(' ');

  const wordmarkStyle = typeof size === 'number'
    ? { fontSize: size, lineHeight: 0.95, letterSpacing: -(size / 40), ...style }
    : style;

  // The step caption ("EDIT", "REVIEW", "SAVE") centers under the wordmark.
  // Using `align-items: center` on the column-flex lockup keeps both the
  // wordmark and the caption on the same vertical axis, regardless of
  // how the lockup is positioned inside its parent.
  return (
    <Tag className="wordmark-lockup" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
      <span className={cls} style={wordmarkStyle} aria-label="Redact.ID">
        Redact<span className="id-suffix">.ID</span>
      </span>
      {stepLabel && <span className="step-caption" style={{ marginTop: 3 }}>{stepLabel}</span>}
    </Tag>
  );
}
