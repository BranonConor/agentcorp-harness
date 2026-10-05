import { useCallback, useState, type ReactNode } from "react";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Collapsible } from "@base-ui/react/collapsible";

export type SelectOption<Value extends string | number> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

type SelectFieldProps<Value extends string | number> = {
  label: string;
  options: readonly SelectOption<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
};

export function SelectField<Value extends string | number>({
  label, options, value, onValueChange, disabled, readOnly, required, name, id,
}: SelectFieldProps<Value>) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const attachField = useCallback((node: HTMLDivElement | null) => {
    const container = node?.closest<HTMLElement>(".live-shell") ?? null;
    setPortalContainer(current => current === container ? current : container);
  }, []);
  return <div className="ui-select-field" ref={attachField}>
    <Select.Root value={value} onValueChange={next => {
      if (next !== null) onValueChange(next);
    }} disabled={disabled} readOnly={readOnly} required={required} name={name} id={id}
      items={options}>
      <Select.Label className="ui-select-label">{label}</Select.Label>
      <Select.Trigger className="ui-select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon className="ui-select-chevron" aria-hidden="true">
          <Chevron />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal container={portalContainer}>
        <Select.Positioner className="ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup className="ui-select-popup">
            <Select.List className="ui-select-list">
              {options.map(option => <Select.Item key={String(option.value)} value={option.value}
                disabled={option.disabled} className="ui-select-item">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="ui-select-check" aria-hidden="true">✓</Select.ItemIndicator>
              </Select.Item>)}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}

export function Chevron() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>;
}

export function Toggle({ label, checked, onCheckedChange, disabled, readOnly, name }: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
}) {
  return <Switch.Root className="ui-switch" aria-label={label} checked={checked}
    onCheckedChange={onCheckedChange} disabled={disabled} readOnly={readOnly} name={name}>
    <Switch.Thumb className="ui-switch-thumb" />
  </Switch.Root>;
}

export const Disclosure = {
  Root: Collapsible.Root,
  Panel: Collapsible.Panel,
  Trigger: function DisclosureTrigger({ children, className }: { children: ReactNode; className?: string }) {
    return <Collapsible.Trigger className={["ui-disclosure-trigger", className].filter(Boolean).join(" ")}>
      {children}<span className="ui-disclosure-chevron"><Chevron /></span>
    </Collapsible.Trigger>;
  },
};
