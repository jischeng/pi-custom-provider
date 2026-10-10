import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  fuzzyFilter,
  getKeybindings,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { Action } from "./components";

type ProviderPage = { title: string; models: Action[]; actions: Action[] };

/** Native controls; section boundaries participate in one continuous navigation order. */
export async function providerPanel(
  ctx: ExtensionContext,
  page: () => ProviderPage,
  onAction: (id: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) => {
      const panel = new Container();
      const search = new Input();
      const standard = getSelectListTheme();
      const kb = getKeybindings();
      let active = page().models.length ? 0 : 1;
      let focused = false;
      let busy = false;
      let closed = false;
      let lists: SelectList[] = [];
      let groups: Action[][] = [];
      let selected: string | undefined;
      let snapshot: string;
      const focus = (index: number) => {
        active = index;
        tui.requestRender();
      };
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
        groups = [state.models, state.actions].map((items) =>
          fuzzyFilter(items, search.getValue(), (item) => item.label),
        );
        if (!groups[active]?.length) active = groups[0].length ? 0 : 1;
        // Reserve the native headings, search field, scroll hints, border and margins.
        const rowBudget = Math.max(5, tui.terminal.rows - 16);
        const actionRows = Math.min(groups[1].length, Math.max(4, rowBudget - 1));
        panel.clear();
        panel.addChild(new DynamicBorder());
        panel.addChild(new Text(theme.fg("accent", theme.bold(state.title)), 1, 1));
        panel.addChild(search);
        panel.addChild(new Spacer(1));
        lists = groups.map((items, index) => {
          panel.addChild(new Text(theme.bold(index === 0 ? "Models" : "Actions"), 1, 0));
          const list = new SelectList(
            items.map((item) => ({ value: item.id, label: item.label })),
            index === 0 ? Math.max(1, Math.min(8, rowBudget - actionRows)) : Math.max(1, actionRows),
            {
              ...standard,
              // Keep the inactive list's position, but display only the active cursor.
              selectedText: (text) =>
                active === index ? standard.selectedText(text) : theme.fg("text", text.replace(/^→ /, "  ")),
            },
          );
          list.onSelect = (item) => {
            void activate(item.value);
          };
          list.onCancel = finish;
          const position = items.findIndex((item) => item.id === selected);
          if (position !== -1) list.setSelectedIndex(position);
          if (items.length) panel.addChild(list);
          else
            panel.addChild(
              new Text(theme.fg("dim", index === 0 && !state.models.length ? "No models added." : "No matches."), 2, 0),
            );
          panel.addChild(new Spacer(1));
          return list;
        });
        panel.addChild(
          new Text(
            rawKeyHint("↑↓", "navigate") +
              " · " +
              keyHint("tui.select.confirm", "open") +
              " · " +
              keyHint("tui.select.cancel", "close") +
              " · Type to search",
            1,
            0,
          ),
        );
        panel.addChild(new DynamicBorder());
      };
      const nativeMouse = panel.handleMouse.bind(panel);
      rebuild();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      Object.defineProperty(panel, "focused", {
        get: () => focused,
        set: (value: boolean) => {
          focused = value;
          search.focused = value;
        },
      });
      return Object.assign(panel, {
        handleInput(data: string) {
          if (busy || closed) return;
          if (kb.matches(data, "tui.select.cancel")) return finish();
          const up = kb.matches(data, "tui.select.up");
          const down = kb.matches(data, "tui.select.down");
          if (up || down) {
            const item = lists[active].getSelectedItem();
            const edge = up ? groups[active][0] : groups[active].at(-1);
            const other = 1 - active;
            if (item?.value === edge?.id && groups[other].length) {
              lists[other].setSelectedIndex(up ? groups[other].length - 1 : 0);
              focus(other);
            } else lists[active].handleInput(data);
          } else if (kb.matches(data, "tui.select.confirm")) lists[active].handleInput(data);
          else {
            const previous = search.getValue();
            search.handleInput(data);
            if (search.getValue() !== previous) {
              selected = undefined;
              active = 0;
              rebuild();
              tui.requestRender();
            }
          }
        },
        handleMouse(event: TuiMouseEvent) {
          if (busy || closed) return undefined;
          const result = nativeMouse(event);
          const index = lists.findIndex((list) => list === result?.target.component);
          if (index !== -1) focus(index);
          return result;
        },
      });
    },
    { overlay: true, overlayOptions: { width: "95%", margin: 1 } },
  );
}
