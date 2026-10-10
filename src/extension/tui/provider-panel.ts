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
  Text,
  fuzzyFilter,
  getKeybindings,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { Action, ActionChoice, ProviderPage } from "./types";

/** A one-shot picker: the same list, without a wrapper row, so one Enter chooses. */
export async function pickPanel(
  ctx: ExtensionContext,
  title: string,
  choices: ActionChoice[],
  signal?: AbortSignal,
): Promise<ActionChoice | undefined> {
  let chosen: ActionChoice | undefined;
  await providerPanel(
    ctx,
    () => ({ title, sections: [{ heading: "", items: choices }] }),
    async (id) => {
      chosen = choices.find((choice) => choice.id === id);
      return false;
    },
    signal,
  );
  return chosen;
}

/**
 * A sectioned list with one continuous cursor and Pi's search. A row either:
 * - opens a select list inside this panel (`choices`), or
 * - hands the editor area to a dialog or another panel (`screen`), or
 * - is applied in place, so the list only rebuilds and never flashes.
 */
export async function providerPanel(
  ctx: ExtensionContext,
  page: () => ProviderPage,
  onAction: (id: string, value?: any) => Promise<boolean>,
  signal?: AbortSignal,
) {
  let active = Math.max(
    0,
    page().sections.findIndex((section) => section.heading === page().startAt),
  );
  let selected: string | undefined;
  let queued: string | undefined;
  while (!signal?.aborted) {
    // A row that needs a screen reports it here; the list closes so the screen can take the area.
    let wantsScreen: string | undefined;
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      const panel = new Container();
      const search = new Input();
      const standard = getSelectListTheme();
      const kb = getKeybindings();
      let focused = false;
      let closed = false;
      /** A row's select list, rendered in place so choosing a value never leaves the page. */
      let choosing: Action | undefined;
      let busy = false;
      let lists: SelectList[] = [];
      let groups: Action[][] = [];

      const release = () => signal?.removeEventListener("abort", abort);
      const finish = (screen?: string) => {
        if (closed) return;
        closed = true;
        wantsScreen = screen;
        release();
        done();
      };
      const abort = () => finish();
      const focus = (index: number) => {
        active = index;
        tui.requestRender();
      };
      const view = (): ProviderPage =>
        choosing ? { title: choosing.label, sections: [{ heading: "Value", items: choosing.choices ?? [] }] } : page();
      const rebuild = () => {
        const state = view();
        // No section is capped: every item renders. Empty sections are omitted.
        const sections = state.sections
          .map((section) => ({
            heading: section.heading,
            items: fuzzyFilter(section.items, search.getValue(), (item) => item.label),
          }))
          .filter((section) => section.items.length);
        groups = sections.map((section) => section.items);
        // After an action the cursor belongs to the row that was acted on, wherever it lives.
        const owner = selected ? groups.findIndex((items) => items.some((item) => item.id === selected)) : -1;
        if (owner !== -1) active = owner;
        if (!groups[active]?.length) active = 0;
        panel.clear();
        panel.addChild(new DynamicBorder());
        panel.addChild(new Text(theme.fg("accent", theme.bold(state.title)), 1, 1));
        panel.addChild(search);
        lists = groups.map((items, index) => {
          if (sections[index].heading) panel.addChild(new Text(theme.bold(sections[index].heading), 1, 0));
          const list = new SelectList(
            items.map((item) => ({ value: item.id, label: item.label })),
            Math.max(1, items.length),
            {
              ...standard,
              // Only the active list shows the cursor. The inactive list's remembered row is
              // rendered like any other row, never through a theme role: a theme that does not
              // match the terminal background (light theme, dark terminal) makes theme colours
              // unreadable, while unstyled text keeps the terminal's own foreground.
              selectedText: (text) => (active === index ? standard.selectedText(text) : text.replace(/^→ /, "  ")),
            },
          );
          list.onSelect = (item) => void run(item.value);
          list.onCancel = () => finish();
          const position = items.findIndex((item) => item.id === selected);
          if (position !== -1) list.setSelectedIndex(position);
          panel.addChild(list);
          return list;
        });
        panel.addChild(
          new Text(
            rawKeyHint("↑↓", "navigate") +
              " · " +
              keyHint("tui.select.confirm", choosing ? "select" : "open") +
              " · " +
              keyHint("tui.select.cancel", choosing ? "back" : "close") +
              " · Type to search",
            1,
            0,
          ),
        );
        panel.addChild(new DynamicBorder());
      };
      /** A select list starts unfiltered, and returning to the list starts unfiltered too. */
      const show = (reset = false) => {
        if (reset) search.setValue("");
        rebuild();
        tui.requestRender();
      };
      const apply = async (id: string, value?: any) => {
        busy = true;
        try {
          if (!(await onAction(id, value))) return finish();
          choosing = undefined;
          selected = id;
          show();
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Could not complete the action.", "error");
        } finally {
          busy = false;
          const nextId = queued;
          queued = undefined;
          if (nextId && !closed) void run(nextId);
        }
      };
      const run = async (id: string, value?: any) => {
        if (closed) return;
        if (choosing) {
          // A choice answers the row that opened the list.
          const choice = choosing.choices?.find((item) => item.id === id);
          const row = choosing.id;
          choosing = undefined;
          return run(row, choice?.value);
        }
        if (busy) {
          queued = id;
          return;
        }
        const row = groups.flat().find((item) => item.id === id);
        if (row?.choices?.length) {
          choosing = row;
          selected = undefined;
          active = 0;
          return show(true);
        }
        // The editor area is needed: close the list, run the row, and reopen afterwards.
        if (row?.screen) {
          selected = id;
          return finish(id);
        }
        await apply(id, value);
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
          if (closed) return;
          if (kb.matches(data, "tui.select.cancel")) {
            if (!choosing) return finish();
            choosing = undefined;
            selected = undefined;
            active = 0;
            return show(true);
          }
          const up = kb.matches(data, "tui.select.up");
          const down = kb.matches(data, "tui.select.down");
          // With no match left the list is empty, but the query must stay editable.
          const typing = () => {
            const previous = search.getValue();
            search.handleInput(data);
            if (search.getValue() !== previous) {
              selected = undefined;
              active = 0;
              show();
            }
          };
          if (!lists[active]) return typing();
          if (up || down) {
            const item = lists[active].getSelectedItem();
            const edge = up ? groups[active][0] : groups[active].at(-1);
            const count = groups.length;
            const wrap = (index: number) => ((index % count) + count) % count;
            let other = active;
            for (let step = 1; step <= count; step++) {
              const next = wrap(active + (up ? -step : step));
              if (groups[next].length) {
                other = next;
                break;
              }
            }
            if (item?.value === edge?.id && other !== active) {
              lists[other].setSelectedIndex(up ? groups[other].length - 1 : 0);
              focus(other);
            } else lists[active].handleInput(data);
          } else if (kb.matches(data, "tui.select.confirm")) lists[active].handleInput(data);
          else typing();
        },
        handleMouse(event: TuiMouseEvent) {
          if (closed) return undefined;
          const result = nativeMouse(event);
          const index = lists.findIndex((list) => list === result?.target.component);
          if (index !== -1) focus(index);
          return result;
        },
      });
    });
    if (!wantsScreen) return;
    try {
      if (!(await onAction(wantsScreen))) return;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not complete the action.", "error");
    }
  }
}
