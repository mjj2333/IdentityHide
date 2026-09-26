// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => false }));
import FaqScreen from '../FaqScreen';

afterEach(() => cleanup());

describe('FaqScreen', () => {
  it('puts every answer in the page (collapsed with `hidden`), so crawlers read it without clicking', () => {
    const { container } = render(<FaqScreen onBack={() => {}} />);
    const questions = container.querySelectorAll('.faq-question');
    const answers = container.querySelectorAll('.faq-answer');
    expect(questions.length).toBeGreaterThan(5);
    expect(answers.length).toBe(questions.length);
    answers.forEach((a) => expect(a.hidden).toBe(true));
  });

  it('still opens and closes an answer on click', () => {
    const { container } = render(<FaqScreen onBack={() => {}} />);
    const q = container.querySelector('.faq-question');
    const a = container.querySelector('.faq-answer');
    fireEvent.click(q);
    expect(a.hidden).toBe(false);
    expect(q.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(q);
    expect(a.hidden).toBe(true);
  });
});
