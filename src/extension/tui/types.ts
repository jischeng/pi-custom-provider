/** Shared shape of the terminal screens. Kept separate so panels and components do not import each other. */

export type Field = {
  id: string;
  label: string;
  description?: string;
  schema: any;
  value: any;
  allowDefault?: boolean;
};

/**
 * A row in a section.
 * - `choices`: choosing the row opens a select list of these values inside the panel.
 * - `screen`: the editor needs the shared editor area (a Pi dialog or another panel), so the
 *   list closes first.
 * Rows with neither are applied in place; the list only rebuilds, so it never flashes.
 */
export type ActionChoice = { id: string; label: string; value?: any };

export type Action = {
  id: string;
  label: string;
  value?: string;
  description?: string;
  screen?: boolean;
  /** Choosing the row opens this list inside the panel; the chosen `value` is handed to `onAction`. */
  choices?: ActionChoice[];
};

export type ProviderSection = { heading: string; items: Action[] };

export type ProviderPage = {
  title: string;
  sections: ProviderSection[];
  /** Heading that owns the cursor when the page opens. Defaults to the first section. */
  startAt?: string;
};

export type PanelHeading = { context?: string; title: string; description?: string };
