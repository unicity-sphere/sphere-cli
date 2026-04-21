import { describe, it, expect } from 'vitest';
import { VERSION } from './version.js';

describe('version constant', () => {
  it('is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('matches semver-ish format', () => {
    // Permissive: major.minor.patch with optional -prerelease/+build.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/);
  });
});
