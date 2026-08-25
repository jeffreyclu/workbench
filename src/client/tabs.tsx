import { useId, type KeyboardEvent, type ReactNode } from 'react';

export type TabItem<Value extends string> = {
  value: Value;
  label: ReactNode;
};

type TabsProps<Value extends string> = {
  ariaLabel: string;
  className: string;
  panelClassName?: string;
  items: readonly TabItem<Value>[];
  selected: Value;
  onSelect: (value: Value) => void;
  children: ReactNode;
};

/**
 * An automatically activated tab set following the W3C tabs pattern.
 * The current view remains controlled by its feature so selection can keep
 * owning the existing query and navigation behavior.
 */
export function Tabs<Value extends string>({ ariaLabel, className, panelClassName, items, selected, onSelect, children }: TabsProps<Value>) {
  const idPrefix = useId();
  const selectedIndex = items.findIndex((item) => item.value === selected);
  const selectedItem = items[selectedIndex >= 0 ? selectedIndex : 0];
  const selectedTabId = `${idPrefix}-${selectedItem.value}-tab`;
  const selectedPanelId = `${idPrefix}-${selectedItem.value}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = Number(event.currentTarget.dataset.tabIndex);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else return;

    event.preventDefault();
    const nextItem = items[nextIndex];
    onSelect(nextItem.value);
    document.getElementById(`${idPrefix}-${nextItem.value}-tab`)?.focus();
  };

  return <>
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const active = item.value === selected;
        return <button
          key={item.value}
          type="button"
          id={`${idPrefix}-${item.value}-tab`}
          role="tab"
          aria-selected={active}
          aria-controls={`${idPrefix}-${item.value}-panel`}
          tabIndex={active ? 0 : -1}
          data-tab-index={index}
          className={active ? 'active' : ''}
          onClick={() => onSelect(item.value)}
          onKeyDown={onKeyDown}
        >{item.label}</button>;
      })}
    </div>
    <div id={selectedPanelId} className={panelClassName} role="tabpanel" aria-labelledby={selectedTabId}>
      {children}
    </div>
  </>;
}
