import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  SelectList,
  SettingsList,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import {
  CODEX_FAST_MODE_ERROR,
  type ImproverModelRuntime,
  type ModelSelection,
} from "./improver-model-runtime.js";
import { redactError } from "./redact.js";
import {
  DEFAULT_INSTRUCTION,
  type PromptImproveSettings,
  type SettingsStore,
  type ThinkingSetting,
} from "./settings-store.js";

interface Selection {
  id: string;
  value: string;
}

export interface ModelChoice extends SelectItem {
  searchText: string;
}

export function filterModelChoices(
  items: readonly ModelChoice[],
  query: string,
): ModelChoice[] {
  return fuzzyFilter([...items], query, (item) => item.searchText);
}

export function thinkingChoices(supported: readonly string[]): SelectItem[] {
  return [
    { value: "default", label: "Model default" },
    ...supported.map((level) => ({ value: level, label: level })),
  ];
}

export function fastModeChoices(supported: boolean): SelectItem[] {
  return supported
    ? [
        { value: "off", label: "off" },
        { value: "on", label: "on" },
      ]
    : [{ value: "off", label: "off" }];
}

export async function showSettings(
  ctx: ExtensionContext,
  store: SettingsStore,
  runtime: ImproverModelRuntime,
  initial: PromptImproveSettings,
  afterSave: (settings: PromptImproveSettings) => void,
): Promise<void> {
  let settings = initial;
  while (true) {
    const available = await runtime.available();
    const inspected = await runtime.inspect(settings);
    const supported = inspected.supportedThinking;
    const fastModeSupported = inspected.fastModeSupported;
    const selected = await showSettingsPage(
      ctx,
      settings,
      available,
      supported,
      fastModeSupported,
    );
    if (!selected) return;

    let next: PromptImproveSettings | undefined;
    if (selected.id === "model") {
      const target: ModelSelection =
        selected.value === "active"
          ? { mode: "active" }
          : decodeFixedModelSelection(selected.value);
      const plan = runtime.planModelChange(settings, target);
      if (plan.kind === "invalid") {
        ctx.ui.notify(plan.error, "warning");
        continue;
      }
      if (plan.kind === "confirmation-required") {
        const confirmed = await ctx.ui.confirm(
          "Update dependent settings?",
          plan.confirmationSummary,
        );
        if (!confirmed) continue;
      }
      next = plan.proposedSettings;
    } else if (selected.id === "thinking") {
      next = { ...settings, thinking: selected.value as ThinkingSetting };
    } else if (selected.id === "fastMode") {
      if (selected.value === "on" && !fastModeSupported) {
        ctx.ui.notify(CODEX_FAST_MODE_ERROR, "warning");
        continue;
      }
      if (selected.value === "on" && !settings.fastMode) {
        const confirmed = await ctx.ui.confirm(
          "Enable OpenAI Codex Fast mode?",
          "Fast mode may use credits or tokens at a higher rate and depends on OpenAI eligibility.",
        );
        if (!confirmed) continue;
      }
      next = { ...settings, fastMode: selected.value === "on" };
    } else if (selected.id === "context") {
      next = {
        ...settings,
        context: { ...settings.context, enabled: selected.value === "on" },
      };
    } else if (selected.id === "count") {
      next = {
        ...settings,
        context: { ...settings.context, count: Number(selected.value) },
      };
    } else if (selected.id === "instruction" && selected.value === "reset") {
      next = { ...settings, instruction: DEFAULT_INSTRUCTION };
    } else if (selected.id === "instruction" && selected.value === "edit") {
      const edited = await ctx.ui.editor(
        "Prompt Improver rewrite guidance",
        settings.instruction,
      );
      if (edited === undefined) continue;
      if (edited.trim().length === 0) {
        ctx.ui.notify("Rewrite guidance cannot be blank", "warning");
        continue;
      }
      next = { ...settings, instruction: edited };
    }

    if (next) {
      try {
        await store.save(next);
        settings = next;
        afterSave(settings);
        ctx.ui.notify("Prompt Improver setting saved", "info");
      } catch (error) {
        ctx.ui.notify(
          `Could not save Prompt Improver settings: ${redactError(error)}`,
          "error",
        );
      }
    }
  }
}

async function showSettingsPage(
  ctx: ExtensionContext,
  settings: PromptImproveSettings,
  available: Array<{ provider: string; id: string; name?: string }>,
  supported: readonly string[],
  fastModeSupported: boolean,
): Promise<Selection | undefined> {
  const modelItems: ModelChoice[] = [
    {
      value: "active",
      label: "Active session model",
      description: "Resolve when improvement starts",
      searchText: "active session model",
    },
    ...available.map((model) => {
      const label = `${model.provider}/${model.id}`;
      const description =
        model.name && model.name !== model.id ? model.name : undefined;
      return {
        value: encodeFixedModel(model.provider, model.id),
        label,
        ...(description ? { description } : {}),
        searchText: `${label} ${description ?? ""}`,
      };
    }),
  ];
  const thinkingItems = thinkingChoices(supported);
  const currentModel =
    settings.model.mode === "active"
      ? "Active session model"
      : `${settings.model.provider}/${settings.model.model}`;
  const instructionState =
    settings.instruction === DEFAULT_INSTRUCTION ? "Default" : "Custom";

  return ctx.ui.custom<Selection | undefined>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Prompt Improver settings")),
          1,
          0,
        ),
      );
      const choices =
        (items: SelectItem[], searchable = false) =>
        (_current: string, selected: (value?: string) => void): Component =>
          searchable
            ? new ModelSearchSelector(items as ModelChoice[], theme, selected)
            : createSelector(items, theme, selected);
      const items: SettingItem[] = [
        {
          id: "model",
          label: "Improver model",
          currentValue: currentModel,
          description: "Active session model or authenticated fixed model",
          submenu: choices(modelItems, true),
        },
        {
          id: "thinking",
          label: "Thinking",
          currentValue:
            settings.thinking === "default"
              ? "Model default"
              : settings.thinking,
          description: "Unsupported saved levels block improvement",
          submenu: choices(thinkingItems),
        },
        {
          id: "fastMode",
          label: "Fast mode",
          currentValue: settings.fastMode ? "on" : "off",
          description: fastModeSupported
            ? "OpenAI Codex only; higher credit or token usage"
            : "Unavailable for the resolved model",
          submenu: choices(fastModeChoices(fastModeSupported)),
        },
        {
          id: "context",
          label: "Recent context",
          currentValue: settings.context.enabled ? "on" : "off",
          submenu: choices([
            { value: "off", label: "off" },
            { value: "on", label: "on" },
          ]),
        },
        {
          id: "count",
          label: "Context messages",
          currentValue: String(settings.context.count),
          description: "Positive integer; no maximum",
          submenu: (_current, selected) =>
            new PositiveIntegerInput(settings.context.count, theme, selected),
        },
        {
          id: "instruction",
          label: "Rewrite guidance",
          currentValue: instructionState,
          description:
            "Customizes rewriting; fixed context/draft protocol always applies",
          submenu: choices([
            { value: "edit", label: "Edit rewrite guidance" },
            { value: "reset", label: "Reset guidance to built-in default" },
          ]),
        },
      ];
      const list = new SettingsList(
        items,
        8,
        getSettingsListTheme(),
        (id, value) => done({ id, value }),
        () => done(undefined),
        { enableSearch: true },
      );
      container.addChild(list);
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
}

function createSelector(
  items: SelectItem[],
  theme: Theme,
  done: (value?: string) => void,
): Component {
  const list = new SelectList(
    items,
    Math.min(items.length, 12),
    getSelectListTheme(),
  );
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
  return list;
}

export class ModelSearchSelector implements Component, Focusable {
  private readonly input = new Input();
  private filtered: ModelChoice[];
  private selectedIndex = 0;
  private _focused = false;

  constructor(
    private readonly items: ModelChoice[],
    private readonly theme: Theme,
    private readonly done: (value?: string) => void,
  ) {
    this.filtered = items;
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] {
    const maxVisible = 12;
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filtered.length - maxVisible,
      ),
    );
    const visible = this.filtered.slice(start, start + maxVisible);
    const rows = visible.flatMap((item, visibleIndex) => {
      const selected = start + visibleIndex === this.selectedIndex;
      const label = `${selected ? "> " : "  "}${item.label}`;
      return [
        this.theme.fg(
          selected ? "accent" : "text",
          truncateToWidth(label, width),
        ),
        ...(item.description
          ? [
              this.theme.fg(
                "dim",
                truncateToWidth(`    ${item.description}`, width),
              ),
            ]
          : []),
      ];
    });
    return [
      "Search authenticated models (fuzzy, case-insensitive):",
      ...this.input.render(width),
      "",
      ...(rows.length > 0
        ? rows
        : [this.theme.fg("warning", "  No matching models")]),
      "",
      this.theme.fg(
        "dim",
        "Type to filter · ↑↓ navigate · Enter select · Esc cancel",
      ),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        Math.max(0, this.filtered.length - 1),
        this.selectedIndex + 1,
      );
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(
        Math.max(0, this.filtered.length - 1),
        this.selectedIndex + 10,
      );
      return;
    }
    const previousQuery = this.input.getValue();
    this.input.handleInput(data);
    const query = this.input.getValue();
    if (query !== previousQuery) {
      this.filtered = filterModelChoices(this.items, query);
      this.selectedIndex = 0;
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

class PositiveIntegerInput implements Component, Focusable {
  private readonly input = new Input();
  private error = "";
  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    current: number,
    private readonly theme: Theme,
    done: (value?: string) => void,
  ) {
    this.input.setValue(String(current));
    this.input.onEscape = () => done(undefined);
    this.input.onSubmit = (value) => {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count <= 0) {
        this.error = "Enter a positive integer";
        return;
      }
      done(String(count));
    };
  }

  render(width: number): string[] {
    return [
      "Context message count:",
      ...this.input.render(width),
      this.error
        ? this.theme.fg("warning", this.error)
        : this.theme.fg("dim", "Enter save · Esc cancel"),
    ];
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
}

function encodeFixedModel(provider: string, model: string): string {
  return `fixed:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
}

function decodeFixedModelSelection(value: string): ModelSelection {
  const [, provider = "", model = ""] = value.split(":");
  return {
    mode: "fixed",
    provider: decodeURIComponent(provider),
    model: decodeURIComponent(model),
  };
}
