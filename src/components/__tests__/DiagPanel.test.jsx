// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import DiagPanel from '../DiagPanel';
import { initDiagnostics, disableDiagnostics, diagLog, clearDiagLog, getDiagEntries } from '../../utils/perfDiagnostics';

beforeEach(() => {
  localStorage.clear();
  initDiagnostics('?diag=1');
  clearDiagLog();
});

afterEach(() => {
  cleanup();
  disableDiagnostics();
});

const open = () => fireEvent.click(screen.getByRole('button', { name: /diagnostics/i }));

describe('DiagPanel', () => {
  it('renders nothing when diagnostics are off', () => {
    disableDiagnostics();
    const { container } = render(<DiagPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('starts collapsed so it does not cover the editor, showing the event count', () => {
    diagLog('save-start');
    diagLog('save-end', { ms: 1200 });
    render(<DiagPanel />);
    expect(screen.getByRole('button', { name: /diagnostics/i }).textContent).toContain('2');
    expect(screen.queryByText('save-end')).toBeNull();
  });

  it('lists entries with their details once opened', () => {
    diagLog('stall-after-return', { ms: 9000 });
    render(<DiagPanel />);
    open();
    expect(screen.getByText('stall-after-return')).toBeTruthy();
    expect(screen.getByText(/ms=9000/)).toBeTruthy();
  });

  it('shows new entries as they are logged', () => {
    render(<DiagPanel />);
    open();
    act(() => diagLog('hidden'));
    expect(screen.getByText('hidden')).toBeTruthy();
  });

  it('Clear empties the log', () => {
    diagLog('save-start');
    render(<DiagPanel />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(getDiagEntries()).toEqual([]);
    expect(screen.queryByText('save-start')).toBeNull();
  });

  it('Copy puts the plain-text log on the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    diagLog('save-end', { ms: 1200 });
    render(<DiagPanel />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('save-end');
    expect(writeText.mock.calls[0][0]).toContain('ms=1200');
  });

  it('Turn off disables diagnostics and removes the panel', () => {
    const { container } = render(<DiagPanel />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    expect(container.innerHTML).toBe('');
    expect(localStorage.getItem('ih_diag')).toBeNull();
  });
});
