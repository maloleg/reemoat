/**
 * How wide a pane somebody can drag is, and the two numbers that stop it being
 * useless — for **both** panes that have one.
 *
 * ⚠ **This is `rail.ts` generalised rather than a new idea**, and every paragraph
 * below was measured on the rail before the background panel needed the same
 * thing. `rail.ts` keeps its filename, its four constants and all four of its
 * exported function names, spelled as one-line instantiations of what is here —
 * which is not tidiness: `webcheck` drives `clampRailWidth`, `railWidth`,
 * `setRailWidth` and `subscribeRail` by name and behaviourally, and a rename would
 * have turned an extraction into a rewrite of nine assertions that are about the
 * rail rather than about where the code lives.
 *
 * **Module state seeded from `localStorage`, not `useState`** — the same rule
 * `groups.ts` states about the collapse set and the selected machine tab, for the
 * same reason: this is a preference about the app rather than about a screen, and
 * a component that unmounts must not take it with it. The background panel is the
 * case that makes it load-bearing rather than tidy — it unmounts every time it is
 * closed, and a width held in its own state would last exactly one visit.
 *
 * **What is deliberately NOT here is the DOM.** This file is imported by
 * `webcheck`, which stubs `window.location` and `window.localStorage` and nothing
 * else — so a `document.documentElement` touch anywhere in a module body, or in
 * anything a check calls, throws before a single case runs. The same ⚠ `overlay.ts`
 * carries about its listener. The impure shell is `AppShell`, which writes both
 * custom properties, and `PaneHandle`, which writes one per `pointermove`.
 *
 * **The width travels as a CSS custom property rather than as a React prop**, and
 * that is a correctness fix rather than a performance one — though it is both.
 * `store` publishes on a four-second poll and on every streamed event, so the shell
 * re-renders throughout a drag; with the width on `style={{ width }}` every one of
 * those renders would overwrite the pointer's own value and snap the pane back to
 * where the drag started. Writing the property on `documentElement` puts it
 * somewhere React does not reconcile. That it also costs **no** render per
 * `pointermove` — against a transcript that draws all 5000 events it holds, with no
 * render window — is the second reason and would have been enough on its own.
 */

/**
 * One pane's width, as the four ways in and the one bound they all pass through.
 *
 * ⚠ **`width()` answers `null`, and that is a state rather than a missing value.**
 * The rail has one width at every size and its stored value is the whole answer.
 * The background panel does not: `index.css` declares 20rem and steps to 26rem at
 * `xl`, because the conversation's width is not monotonic in the window's — at `lg`
 * the rail arrives and takes 384px of it. `null` is *nobody has chosen*, so the
 * stylesheet's two answers stand; a number is a reader's own, and an inline
 * declaration on `documentElement` beats both media blocks, so one dragged width
 * then applies at every width the pane is docked at. {@link PaneWidth.reset} is
 * what hands the breakpoints back, and it is what makes this honest rather than
 * merely convenient.
 */
export interface PaneWidth {
  /** The floor and the ceiling, exposed for the separator's `aria-valuemin`/`max`. */
  readonly min: number;
  readonly max: number;
  /**
   * The custom property the shell writes this into, carried as **data** — naming
   * it here is what lets one `PaneHandle` serve two panes without a branch, and
   * this module still touches no DOM.
   */
  readonly prop: string;
  /**
   * The one place a width is bounded, and every path goes through it.
   *
   * Pure, and exported for that reason: the drag, the keyboard, the stored value
   * and the reset are four ways in, and a clamp applied at three of them is the
   * fourth one shipping a 12px pane. Non-finite in as well as out of range —
   * `Number.parseInt` answers `NaN` for a hand-edited storage value, and `NaN`
   * compared against a bound is `false` in **both** directions, so a bare
   * `Math.min`/`Math.max` pair would pass it straight through and the pane would
   * mount at `NaN` pixels, which computes to no visible pane at all.
   */
  clamp(px: number): number;
  /** The committed width, or `null` where nobody has chosen and none is declared here. */
  width(): number | null;
  setWidth(px: number): void;
  /** Drops the stored key and goes back to whatever `unset` is for this pane. */
  reset(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * @param key The `localStorage` key. Per device, which is this app's standing
 *   answer for a preference the control plane has nowhere to put.
 * @param unset What {@link PaneWidth.width} answers with nothing stored, and what
 *   {@link PaneWidth.reset} goes back to. ⚠ **This is the one field the two panes
 *   disagree about, and it is the whole of their difference.** The rail has a
 *   single width at every size, so unset and default are the same rail and it
 *   passes a number — which is also what keeps `aria-valuenow` on its separator
 *   from disappearing until somebody drags. The panel has two declared widths and a
 *   breakpoint between them, so it passes `null`: *the stylesheet decides*, and
 *   there is no one number a separator could honestly announce.
 * @param fallback What {@link PaneWidth.clamp} answers for a value that is not a
 *   number, which is a different question from `unset`. Reached from a hand-edited
 *   storage entry and from a computed property that did not parse, so it lands on
 *   what a reader who had never dragged would have seen rather than on the floor.
 */
export function createPaneWidth(spec: {
  key: string;
  min: number;
  max: number;
  unset: number | null;
  fallback: number;
  prop: string;
}): PaneWidth {
  const clamp = (px: number): number => {
    if (!Number.isFinite(px)) return spec.fallback;
    return Math.min(spec.max, Math.max(spec.min, Math.round(px)));
  };

  const read = (): number | null => {
    try {
      const raw = window.localStorage.getItem(spec.key);
      if (raw === null) return spec.unset;
      return clamp(Number.parseInt(raw, 10));
    } catch {
      // Private mode, a quota, or somebody's hand-edited value. A pane width is
      // not worth failing a render for; this pane's unset state is a working app.
      return spec.unset;
    }
  };

  let committed = read();
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    min: spec.min,
    max: spec.max,
    prop: spec.prop,
    clamp,
    /** `useSyncExternalStore` compares it by `Object.is`, so a number or `null`. */
    width: (): number | null => committed,
    setWidth: (px: number): void => {
      const next = clamp(px);
      if (next === committed) return;
      committed = next;
      try {
        window.localStorage.setItem(spec.key, String(next));
      } catch {
        // Same reasoning as `read`: the in-memory value still works this session.
      }
      announce();
    },
    /*
     * ⚠ **Removes the key rather than writing the default into it.** For the panel
     * a stored default is still a *chosen* width and would go on beating both
     * media blocks, so the `xl` step would be present, declared, correct and
     * unreachable. For the rail the two are indistinguishable from outside, and it
     * is spelled the same way so there is one behaviour to reason about.
     */
    reset: (): void => {
      if (committed === spec.unset) return;
      committed = spec.unset;
      try {
        window.localStorage.removeItem(spec.key);
      } catch {
        // As above. The in-memory value is what the shell reads.
      }
      announce();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
