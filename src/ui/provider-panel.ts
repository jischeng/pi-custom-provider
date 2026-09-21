import {
  DynamicBorder,
  getSettingsListTheme,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Action } from "./components";

type ProviderPage = { title: string; models: Action[]; actions: Action[] };

/** Native lists/layout. Only section focus and application callbacks are coordinated here. */
export async function providerPanel(
  ctx: ExtensionContext,
  page: () => ProviderPage,
  onAction: (id: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) => {
      const panel = new Container();
      const standard = getSettingsListTheme();
      let active = page().models.length ? 0 : 1;
      let busy = false;
      let closed = false;
      let lists: SettingsList[] = [];
      let selected: string | undefined;
      let snapshot: string;
      const finish = () => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener("abort", abort);
        done();
      };
      const abort = () => {
        if (!busy) finish();
      };
      const activate = async (id: string) => {
        if (busy || closed) return;
        busy = true;
        selected = id;
        try {
          if (!(await onAction(id)) || signal?.aborted) finish();
          else if (JSON.stringify(page()) !== snapshot) rebuild();
        } catch {
          await ctx.ui.select("Could not complete the action.", ["Back"], { signal });
        } finally {
          busy = false;
          if (signal?.aborted) finish();
          tui.requestRender();
        }
      };
      const rebuild = () => {
        const state = page();
        snapshot = JSON.stringify(state);
        // Reserve borders, headings, native search/hints and terminal margins.
        const rowBudget = Math.max(5, tui.terminal.rows - 19);
        const actionRows = Math.min(state.actions.length, Math.max(4, rowBudget - 1));
        if (!state.models.length) active = 1;
        panel.clear();
        panel.addChild(new DynamicBorder());
        panel.addChild(new Text(theme.fg("accent", theme.bold(state.title)), 1, 1));
        lists = [state.models, state.actions].map((items, index) => {
          panel.addChild(new Text(theme.bold(index === 0 ? "Models" : "Actions"), 1, 0));
          const list = new SettingsList(
            items.map((item) => ({
              id: item.id,
              label: item.label,
              description: item.description,
              currentValue: "",
              values: ["Open"],
            })),
            index === 0 ? Math.max(1, Math.min(8, rowBudget - actionRows)) : actionRows,
            {
              ...standard,
              get cursor() {
                return active === index ? standard.cursor : "  ";
              },
              label: (text, chosen) => standard.label(text, chosen && active === index),
              description: (text) => (active === index ? standard.description(text) : ""),
              hint: (text) => (text.includes("Enter/Space") ? "" : standard.hint(text)),
            },
            (id) => {
              list.updateValue(id, "");
              void activate(id);
            },
            () => finish(),
            { enableSearch: index === 0 },
          );
          if (selected) list.selectItem(selected);
          if (items.length) panel.addChild(list);
          else panel.addChild(new Text(theme.fg("dim", "No models added."), 2, 1));
          return list;
        });
        panel.addChild(
          new Text(
            rawKeyHint("Tab", "switch section") +
              " · " +
              keyHint("tui.select.confirm", "open") +
              " · " +
              keyHint("tui.select.cancel", "close"),
            1,
            0,
          ),
        );
        panel.addChild(new Spacer(1));
        panel.addChild(new DynamicBorder());
      };
      const nativeMouse = panel.handleMouse.bind(panel);
      rebuild();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      return Object.assign(panel, {
        handleInput(data: string) {
          if (busy || closed) return;
          if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
            if (page().models.length) active = 1 - active;
            tui.requestRender();
          } else lists[active].handleInput(data);
        },
        handleMouse(event: TuiMouseEvent) {
          if (busy || closed) return undefined;
          const result = nativeMouse(event);
          const index = lists.findIndex((list) => list === result?.target.component);
          if (index !== -1) active = index;
          return result;
        },
      });
    },
    { overlay: true, overlayOptions: { width: "95%", margin: 1 } },
  );
}
