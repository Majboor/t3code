import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ClaudeAI, CursorIcon, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { GlmEffortSlider } from "./GlmEffortSlider";

const ACCOUNT_PROVIDER_NAME_OF: Partial<Record<ProviderKind, "codex" | "claude">> = {
  codex: "codex",
  claudeAgent: "claude",
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  glm: OpenCodeIcon,
  cursor: CursorIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const COMING_SOON_PROVIDER_OPTIONS = [
  { id: "opencode", label: "OpenCode", icon: OpenCodeIcon },
  { id: "gemini", label: "Gemini", icon: Gemini },
] as const;

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : fallbackClassName;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const connections = useProviderConnections(isMenuOpen && props.lockedProvider === null);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    options?: { closeMenu?: boolean },
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    // The slider is a continuous drag, not a click-to-select item — closing
    // the popup mid-drag would yank focus out from under the pointer.
    if (options?.closeMenu !== false) setIsMenuOpen(false);
  };

  function renderModelChoices(provider: ProviderKind, currentModel: string) {
    if (provider === "glm") {
      return (
        <GlmEffortSlider
          model={currentModel}
          onModelChange={(nextModel) => handleModelChange(provider, nextModel, { closeMenu: false })}
        />
      );
    }
    return (
      <MenuRadioGroup value={currentModel} onValueChange={(value) => handleModelChange(provider, value)}>
        {props.modelOptionsByProvider[provider].map((modelOption) => (
          <MenuRadioItem
            key={`${provider}:${modelOption.slug}`}
            value={modelOption.slug}
            onClick={() => setIsMenuOpen(false)}
          >
            {modelOption.name}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    );
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider, "text-muted-foreground/70"),
              props.activeProviderIconClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        {props.lockedProvider !== null ? (
          <MenuGroup>{renderModelChoices(props.lockedProvider, props.model)}</MenuGroup>
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }
              // A provider can be server-ready (installed, enabled) but have
              // no account this person has connected — GLM has no such
              // concept (always "connected", the credential is automatic).
              // Kept visible rather than hidden, greyed out with a tooltip
              // that says exactly what to do, same spirit as the
              // "Not installed"/"Disabled" states above for a different
              // reason (no server-side capability at all).
              const accountProviderName = ACCOUNT_PROVIDER_NAME_OF[option.value];
              const connection = connections?.find((c) => c.provider === accountProviderName);
              const isDisconnected =
                accountProviderName !== undefined && connections !== null && connection?.connected !== true;

              if (isDisconnected) {
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger
                      render={
                        <Link
                          to="/settings/connections"
                          className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground/50 outline-none hover:bg-accent/50 sm:min-h-7 sm:text-sm"
                          onClick={() => setIsMenuOpen(false)}
                        />
                      }
                    >
                      <OptionIcon
                        aria-hidden="true"
                        className={cn("size-4 shrink-0 opacity-50", providerIconClassName(option.value, ""))}
                      />
                      <span>{option.label}</span>
                      <span className="ms-auto text-[11px] uppercase tracking-[0.08em]">Not connected</span>
                    </TooltipTrigger>
                    <TooltipPopup side="right">Connect {option.label}</TooltipPopup>
                  </Tooltip>
                );
              }

              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
                    <MenuGroup>
                      {renderModelChoices(
                        option.value,
                        props.provider === option.value ? props.model : "",
                      )}
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground/85 opacity-80"
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length === 0 && <MenuDivider />}
            {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuItem key={option.id} disabled>
                  <OptionIcon aria-hidden="true" className="size-4 shrink-0 opacity-80" />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
