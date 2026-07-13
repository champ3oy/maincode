import { useState, useMemo } from "react";
import { IconMinus, IconPlus, IconExternalLink } from "@tabler/icons-react";
import { useSettings } from "@/hooks/use-settings";
import type { ThemeChoice, FontChoice } from "@/hooks/use-settings";

const FONT_LABELS: Record<FontChoice, string> = {
  "app-mono": "App Mono",
  "system-mono": "System Mono",
  courier: "Courier",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsViewProps {
  onEditJson: () => void;
}

type Category = "Appearance" | "Editor" | "Terminal" | "Source Control";

interface RowDef {
  id: string;
  label: string;
  description: string;
  category: Category;
  control: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Primitive controls
// ---------------------------------------------------------------------------

interface SelectProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}

function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
}: SelectProps<T>) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}

function Stepper({ value, min, max, onChange }: StepperProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= min}
        className="flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="Decrease"
      >
        <IconMinus className="size-3" stroke={2} />
      </button>
      <span className="w-8 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={value >= max}
        className="flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="Increase"
      >
        <IconPlus className="size-3" stroke={2} />
      </button>
    </div>
  );
}

interface ToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ value, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        value ? "bg-primary" : "bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
          value ? "translate-x-4" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  label: string;
  description: string;
  control: React.ReactNode;
}

function Row({ label, description, control }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const CATEGORIES: Category[] = ["Appearance", "Editor", "Terminal", "Source Control"];

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FONT_OPTIONS: { value: FontChoice; label: string }[] = [
  { value: "app-mono", label: FONT_LABELS["app-mono"] },
  { value: "system-mono", label: FONT_LABELS["system-mono"] },
  { value: "courier", label: FONT_LABELS["courier"] },
];

export function SettingsView({ onEditJson }: SettingsViewProps) {
  const { settings, patch } = useSettings();
  const [activeCategory, setActiveCategory] = useState<Category>("Appearance");
  const [search, setSearch] = useState("");

  const rows = useMemo<RowDef[]>(
    () => [
      // Appearance
      {
        id: "theme",
        label: "Theme",
        description: "Color scheme for the interface.",
        category: "Appearance",
        control: (
          <SettingsSelect<ThemeChoice>
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => patch({ theme })}
          />
        ),
      },
      // Editor
      {
        id: "editor-font-size",
        label: "Font Size",
        description: "Editor font size in points (8–32).",
        category: "Editor",
        control: (
          <Stepper
            value={settings.editor.fontSize}
            min={8}
            max={32}
            onChange={(fontSize) => patch({ editor: { fontSize } })}
          />
        ),
      },
      {
        id: "editor-font-family",
        label: "Font Family",
        description: "Monospace font used in the editor.",
        category: "Editor",
        control: (
          <SettingsSelect<FontChoice>
            value={settings.editor.fontFamily}
            options={FONT_OPTIONS}
            onChange={(fontFamily) => patch({ editor: { fontFamily } })}
          />
        ),
      },
      {
        id: "editor-tab-size",
        label: "Tab Size",
        description: "Number of spaces per indentation level (1–8).",
        category: "Editor",
        control: (
          <Stepper
            value={settings.editor.tabSize}
            min={1}
            max={8}
            onChange={(tabSize) => patch({ editor: { tabSize } })}
          />
        ),
      },
      {
        id: "editor-word-wrap",
        label: "Word Wrap",
        description: "Wrap long lines instead of scrolling horizontally.",
        category: "Editor",
        control: (
          <Toggle
            value={settings.editor.wordWrap}
            onChange={(wordWrap) => patch({ editor: { wordWrap } })}
          />
        ),
      },
      {
        id: "editor-autocomplete",
        label: "Autocomplete",
        description: "Suggest completions as you type.",
        category: "Editor",
        control: (
          <Toggle
            value={settings.editor.autocomplete}
            onChange={(autocomplete) => patch({ editor: { autocomplete } })}
          />
        ),
      },
      {
        id: "editor-linting",
        label: "Linting",
        description: "Underline syntax errors in the editor.",
        category: "Editor",
        control: (
          <Toggle
            value={settings.editor.linting}
            onChange={(linting) => patch({ editor: { linting } })}
          />
        ),
      },
      // Terminal
      {
        id: "terminal-font-size",
        label: "Font Size",
        description: "Terminal font size in points (8–24).",
        category: "Terminal",
        control: (
          <Stepper
            value={settings.terminal.fontSize}
            min={8}
            max={24}
            onChange={(fontSize) => patch({ terminal: { fontSize } })}
          />
        ),
      },
      // Source Control
      {
        id: "diff-font-family",
        label: "Diff Font",
        description: "Monospace font used in the diff viewer.",
        category: "Source Control",
        control: (
          <SettingsSelect<FontChoice>
            value={settings.diff.fontFamily}
            options={FONT_OPTIONS}
            onChange={(fontFamily) => patch({ diff: { fontFamily } })}
          />
        ),
      },
      {
        id: "diff-font-size",
        label: "Diff Font Size",
        description: "Diff viewer font size in points (8–32).",
        category: "Source Control",
        control: (
          <Stepper
            value={settings.diff.fontSize}
            min={8}
            max={32}
            onChange={(fontSize) => patch({ diff: { fontSize } })}
          />
        ),
      },
      {
        id: "diff-word-wrap",
        label: "Line Wrapping",
        description: "Wrap long lines instead of scrolling horizontally.",
        category: "Source Control",
        control: (
          <Toggle
            value={settings.diff.wordWrap}
            onChange={(wordWrap) => patch({ diff: { wordWrap } })}
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, patch],
  );

  const query = search.trim().toLowerCase();
  const visibleRows = query
    ? rows.filter(
        (r) =>
          r.label.toLowerCase().includes(query) ||
          r.description.toLowerCase().includes(query) ||
          r.category.toLowerCase().includes(query),
      )
    : rows.filter((r) => r.category === activeCategory);

  const showingSearch = query.length > 0;

  return (
    <div className="flex h-full">
      {/* Left column — category nav */}
      <div className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2 py-4">
        {/* Search */}
        <div className="mb-2 px-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings…"
            className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {/* Category buttons */}
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setActiveCategory(cat);
              setSearch("");
            }}
            className={[
              "rounded px-3 py-1.5 text-left text-sm transition-colors",
              activeCategory === cat && !showingSearch
                ? "bg-accent text-accent-foreground font-medium"
                : "text-foreground hover:bg-accent/60",
            ].join(" ")}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Right column — settings rows */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-3">
          <span className="text-xs text-muted-foreground">
            User · maincode
          </span>
          <button
            type="button"
            onClick={onEditJson}
            className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent transition-colors"
          >
            <IconExternalLink className="size-3.5" stroke={1.75} />
            Edit in settings.json
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 px-8 py-6">
          {showingSearch ? (
            <>
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Search results
              </h2>
              {visibleRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No settings match &ldquo;{search}&rdquo;
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {visibleRows.map((r) => (
                    <Row
                      key={r.id}
                      label={r.label}
                      description={`${r.category} · ${r.description}`}
                      control={r.control}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {activeCategory}
              </h2>
              <div className="flex flex-col gap-2">
                {visibleRows.map((r) => (
                  <Row
                    key={r.id}
                    label={r.label}
                    description={r.description}
                    control={r.control}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
