import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe on a rendered tree and fails with a readable summary.
 *
 * Only WCAG A/AA rules are enforced (best-practice rules would flag things like
 * "content outside a landmark", which is a layout opinion, not a barrier).
 * Colour contrast is disabled because jsdom has no layout engine: without real
 * paint there is nothing to measure, and a false pass would be worse than a
 * documented gap.
 */
export async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });

  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes
          .map((node) => node.target.join(' '))
          .join('\n  ')}`,
    )
    .join('\n');

  expect(results.violations, `axe found accessibility violations:\n${summary}`).toHaveLength(0);
}
