// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ConfirmModal from '../ConfirmModal';

afterEach(cleanup);

describe('ConfirmModal', () => {
  it('renders the supplied message', () => {
    render(<ConfirmModal message="Discard your work?" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Discard your work?')).toBeTruthy();
  });

  it('calls onConfirm when the primary button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal message="msg" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /yes, continue/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal message="msg" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmModal message="msg" onConfirm={() => {}} onCancel={onCancel} />
    );
    fireEvent.click(container.querySelector('.confirm-backdrop'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel when clicking inside the modal body', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal message="msg" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('msg'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('invokes the latest onCancel on Escape after the prop changes', () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const { rerender } = render(
      <ConfirmModal message="msg" onConfirm={() => {}} onCancel={firstCancel} />
    );
    rerender(<ConfirmModal message="msg" onConfirm={() => {}} onCancel={secondCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(firstCancel).not.toHaveBeenCalled();
    expect(secondCancel).toHaveBeenCalledTimes(1);
  });
});
