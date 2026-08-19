import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  isTextEntryElement,
  shouldFocusSidebarSearchShortcut,
  SIDEBAR_FILTER_SHORTCUT_TARGET_SELECTOR,
} from "./sidebarFilters.logic";

/**
 * The sidebar's find-a-project field.
 *
 * Adopted from upstream's settings search: `/` from anywhere lands here, the
 * hint says so while the field is empty, and a query is one click or one
 * Escape from gone. Previously the field was reachable only by pointer and
 * clearable only by selecting the text.
 */
export function SidebarSearchField({
  value,
  onChange,
  onFocusRequested,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Called before focus moves, so a put-away sidebar can bring itself back.
   * Returning `false` means the field cannot be reached right now and the
   * keystroke should be left alone rather than swallowed.
   */
  readonly onFocusRequested?: () => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRequestedRef = useRef(onFocusRequested);
  focusRequestedRef.current = onFocusRequested;

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const targetElement = target instanceof HTMLElement ? target : null;
      if (
        !shouldFocusSidebarSearchShortcut({
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          defaultPrevented: event.defaultPrevented,
          targetIsTextEntry: targetElement ? isTextEntryElement(targetElement) : false,
          targetIsInsideOverlay:
            targetElement?.closest(SIDEBAR_FILTER_SHORTCUT_TARGET_SELECTOR) != null,
        })
      ) {
        return;
      }

      if (focusRequestedRef.current?.() === false) {
        return;
      }

      event.preventDefault();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || value.length === 0) return;
    // Swallowed so Escape clears the query instead of closing the sidebar
    // sheet out from under someone mid-search.
    event.preventDefault();
    event.stopPropagation();
    onChange("");
  };

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        aria-label="Search projects and threads"
        data-testid="sidebar-project-search"
        placeholder="Find project, thread, branch..."
        className="h-7 pl-7 pr-8 text-xs"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
        {value.length > 0 ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Clear sidebar search"
            data-testid="sidebar-project-search-clear"
            className="pointer-events-auto size-5 text-muted-foreground/70 hover:text-foreground"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">/</Kbd>
        )}
      </div>
    </div>
  );
}
