import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/**
 * One segmented-control row of a pack requirement — "Where to look", the
 * minimum deployment count, the minimum time in service.
 *
 * Pulled out of `PackModeControl` so the small settings popover and the
 * larger "Browse all packs" modal render the exact same control bound to the
 * exact same `usePackModeSettings` state, rather than the modal growing a
 * second, easily-drifting copy of these options.
 */
export function PackFilterOptionRow<T extends number | string>({
  label,
  options,
  value,
  testId,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly hint: string }>;
  value: T;
  testId: string;
  onChange: (next: T) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-muted-foreground">{label}</div>
      {/* Single-choice, so the group owns the selection: clicking the pressed
          option must not clear it, which is why an empty change is ignored. */}
      <ToggleGroup
        className="grid w-full grid-cols-3"
        data-testid={testId}
        onValueChange={(next) => {
          const [selected] = next;
          const option = options.find((candidate) => String(candidate.value) === selected);
          if (option && option.value !== value) {
            onChange(option.value);
          }
        }}
        value={[String(value)]}
        variant="segmented"
      >
        {options.map((option) => (
          <ToggleGroupItem
            className="px-2 text-[11px]"
            key={String(option.value)}
            title={option.hint}
            value={String(option.value)}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
