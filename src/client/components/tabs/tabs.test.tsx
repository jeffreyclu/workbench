// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tabs } from './tabs';

function ExampleTabs() {
  const [selected, setSelected] = useState<'active' | 'archive' | 'all'>('active');
  return <Tabs ariaLabel="Example views" className="example-tabs" selected={selected} onSelect={setSelected} items={[
    { value: 'active', label: 'Active' },
    { value: 'archive', label: 'Archive' },
    { value: 'all', label: 'All' },
  ]}>
    <p>{selected} content</p>
  </Tabs>;
}

describe('Tabs', () => {
  it('connects a selected tab to its tabpanel and moves selection and focus with keyboard navigation', () => {
    render(<ExampleTabs />);
    const tablist = screen.getByRole('tablist', { name: 'Example views' });
    const active = within(tablist).getByRole('tab', { name: 'Active' });
    const archive = within(tablist).getByRole('tab', { name: 'Archive' });
    const all = within(tablist).getByRole('tab', { name: 'All' });

    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('tabindex', '0');
    expect(archive).toHaveAttribute('aria-selected', 'false');
    expect(archive).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', active.id);
    expect(active).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);

    active.focus();
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(archive).toHaveFocus();
    expect(archive).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('archive content');

    fireEvent.keyDown(archive, { key: 'End' });
    expect(all).toHaveFocus();
    expect(all).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(active).toHaveFocus();
    expect(active).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(active, { key: 'ArrowLeft' });
    expect(all).toHaveFocus();
    fireEvent.keyDown(all, { key: 'Home' });
    expect(active).toHaveFocus();
  });
});
