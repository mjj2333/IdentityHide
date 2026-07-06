// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCreditState,
  canConsumeCredit,
  consumeCredit,
  canEarnMore,
  grantRewardedCredit,
  creditsRemaining,
  MAX_EARNED_PER_WEEK,
} from '../credits';

const STORAGE_KEY = 'ih_credits';

beforeEach(() => {
  localStorage.clear();
});

describe('getCreditState', () => {
  it('returns fresh state on first call and persists it', () => {
    const s = getCreditState();
    expect(s.used).toBe(0);
    expect(s.earnedThisWeek).toBe(0);
    expect(typeof s.weekStart).toBe('string');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).weekStart).toBe(s.weekStart);
  });

  it('returns the same state on subsequent calls within the same week', () => {
    const first = getCreditState();
    consumeCredit();
    const second = getCreditState();
    expect(second.weekStart).toBe(first.weekStart);
    expect(second.used).toBe(1);
  });

  it('resets to zero when localStorage has a stale weekStart', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ weekStart: '1999-01-04', used: 99, earnedThisWeek: 99 })
    );
    const s = getCreditState();
    expect(s.used).toBe(0);
    expect(s.earnedThisWeek).toBe(0);
    expect(s.weekStart).not.toBe('1999-01-04');
  });

  it('resets when localStorage contains the old daily-bucket shape', () => {
    // Pre-weekly builds stored { dailyReset, used, earnedToday }.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ dailyReset: '2026-04-21', used: 2, earnedToday: 1 })
    );
    const s = getCreditState();
    expect(s.used).toBe(0);
    expect(s.earnedThisWeek).toBe(0);
    expect(s.weekStart).toBeDefined();
  });
});

describe('canConsumeCredit', () => {
  it('is true when used < weekly free quota', () => {
    expect(canConsumeCredit()).toBe(true);
  });

  it('remains true while the user has used fewer than 3 free credits', () => {
    consumeCredit();
    expect(canConsumeCredit()).toBe(true);
    consumeCredit();
    expect(canConsumeCredit()).toBe(true);
  });

  it('is false after all 3 free credits are spent with no earned credits', () => {
    consumeCredit();
    consumeCredit();
    consumeCredit();
    expect(canConsumeCredit()).toBe(false);
  });

  it('is true again after earning a rewarded credit', () => {
    consumeCredit();
    consumeCredit();
    consumeCredit();
    expect(canConsumeCredit()).toBe(false);
    grantRewardedCredit();
    expect(canConsumeCredit()).toBe(true);
  });
});

describe('consumeCredit', () => {
  it('increments used and returns the new state', () => {
    const s1 = consumeCredit();
    expect(s1.used).toBe(1);
    const s2 = consumeCredit();
    expect(s2.used).toBe(2);
  });

  it('persists the increment across a fresh read', () => {
    consumeCredit();
    consumeCredit();
    expect(getCreditState().used).toBe(2);
  });
});

describe('rewarded-credit earning', () => {
  it('canEarnMore is true by default', () => {
    expect(canEarnMore()).toBe(true);
  });

  it('grantRewardedCredit increments earnedThisWeek', () => {
    const s = grantRewardedCredit();
    expect(s.earnedThisWeek).toBe(1);
  });

  it('caps earned credits at MAX_EARNED_PER_WEEK', () => {
    for (let i = 0; i < MAX_EARNED_PER_WEEK + 3; i++) {
      grantRewardedCredit();
    }
    expect(getCreditState().earnedThisWeek).toBe(MAX_EARNED_PER_WEEK);
  });

  it('canEarnMore flips to false at the cap', () => {
    for (let i = 0; i < MAX_EARNED_PER_WEEK; i++) {
      grantRewardedCredit();
    }
    expect(canEarnMore()).toBe(false);
  });
});

describe('creditsRemaining', () => {
  it('starts at 3 (weekly free quota)', () => {
    expect(creditsRemaining()).toBe(3);
  });

  it('decreases with each consumed credit', () => {
    consumeCredit();
    expect(creditsRemaining()).toBe(2);
    consumeCredit();
    expect(creditsRemaining()).toBe(1);
  });

  it('increases with each earned credit', () => {
    grantRewardedCredit();
    expect(creditsRemaining()).toBe(4);
    grantRewardedCredit();
    expect(creditsRemaining()).toBe(5);
  });

  it('never goes below 0 even if used somehow exceeds quota', () => {
    for (let i = 0; i < 10; i++) consumeCredit();
    expect(creditsRemaining()).toBe(0);
  });

  it('reflects the net of free + earned - used', () => {
    grantRewardedCredit();       // +1 earned → 4 available
    grantRewardedCredit();       // +1 earned → 5 available
    consumeCredit();              // -1 used  → 4 remaining
    consumeCredit();              // -1 used  → 3 remaining
    expect(creditsRemaining()).toBe(3);
  });
});
