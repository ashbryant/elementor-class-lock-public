=== Elementor Class Lock ===
Contributors: ashbryant
Tags: elementor, atomic, editor, global-classes, css
Requires at least: 6.4
Tested up to: 6.8
Requires PHP: 8.0
Stable tag: 1.0.27
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Prevents accidental global class edits in the Elementor V4 atomic editor by locking every global class on each editor load until you explicitly unlock it.

== Description ==

Elementor Class Lock targets the Elementor V4 atomic editor (global classes UI). The editor script loads whenever Elementor loads; when the Atomic elements experiment is active, the plugin also:

* Injects a padlock control beside every global kit class (`g-*******`) in the Style → Classes chips and in the Class Manager list.
* Locks every global class by default on every editor load. The unlock Set is held in memory for the current editor session only — it does **not** persist across hard refreshes, and it auto-relocks when you change the selected element or switch active class chip (including clicking `local`), so you never carry an accidental unlock into a different editing context.
* While a class is locked, in-memory style mutations (Elementor V2 `global-classes` provider `updateProps` / `updateCustomCss` / `update`) are blocked with a throttled toast.
* Outgoing `PUT /wp-json/elementor/v1/global-classes` requests (both `fetch` and `XMLHttpRequest`/Axios) have locked-class payloads rewritten back to the frozen kit snapshot before they leave the browser, so the kit meta file is never overwritten with accidental global edits.
* The Class Manager ("Class Manager" button in Style → Classes) is locked down for locked classes: the More actions menu, drag handle, and double-click rename flow are all blocked, and any stray `contenteditable="true"` is reverted. If a locked class is deleted client-side, the network interceptor re-injects it into the outgoing PUT so the kit stays intact.
* Adds a REST safety net: `PUT /wp-json/elementor/v1/global-classes` must include a valid `X-ECL-Unlock-Token` header (nonce issued to the editor). Legitimate editor traffic is patched automatically; direct API calls without the header receive HTTP 403.

This plugin does **not** require Elementor Pro. It is tested against Elementor core with `e_atomic_elements` enabled.

== Installation ==

1. Upload the plugin files to `/wp-content/plugins/elementor-class-lock`, or install the zip from the Plugins screen.
2. Activate through the Plugins menu.
3. Ensure Elementor is installed and active.
4. Enable **Atomic elements** under Elementor → Settings → Features.

== Frequently Asked Questions ==

= Why does nothing happen in the editor? =

Confirm the plugin is active and hard-refresh the editor (cache). In the browser console, `window.ELEMENTOR_CLASS_LOCK_ACTIVE` should be true. Padlocks only appear on chips that match a global kit class (Site Settings → Global Classes), not on the "Local" chip. If the Atomic elements experiment is off, a toast explains that the REST save guard is inactive; enable it under Elementor → Settings → Features for full protection.

= Does the unlock state persist across reloads? =

No, and that is deliberate. As of 1.0.17 the unlock Set is ephemeral — every editor load starts with every global class locked. Earlier versions stored unlocks in `localStorage`, which defeated the point of an accidental-edit guard.

= Does this work across browser tabs? =

No. Each editor tab holds its own in-memory unlock Set. Opening a second tab starts locked again.

= Why did my unlock snap back to locked? =

The plugin auto-relocks any unlocked global class whenever the editing context changes — either you selected a different element in the preview, or you clicked a different class chip in Style → Classes (including `local`). This is intentional: it guarantees an unlock only applies to the class you were just editing.

== Changelog ==

= 1.0.26 =
* Change: style panel controls (Layout, Spacing, Typography, etc.) are now visually dimmed and non-interactive when the active class chip is a locked global class. The Classes row (chips and padlock) stays fully interactive. Unlocking immediately restores the controls.

= 1.0.25 =
* Change: padlock button aria-label now uses full descriptive text in both locked and unlocked states.
* Change: unlocked padlock button now carries a native `title` tooltip — "Class is unlocked — switching to another class or element will re-lock it." — making the auto-relock behaviour discoverable on hover.

= 1.0.24 =
* Fix: hardens global-class snapshot seeding for Elementor 4.1.1+ so the plugin only stores complete class objects with `variants` for locked save rewrites, and briefly retries while Elementor's provider is still booting.
* Change: editor boot, request rewrite, and network payload diagnostics now honour debug mode instead of always logging in the browser console.

= 1.0.23 =
* Change: clicking "Rename" in a class's overflow menu (Style → Classes chip three-dots menu, or Class Manager more-actions menu) on a locked class now auto-unlocks that one class and proceeds with the rename. Renaming only changes the class label, not its style values, and is a deliberate user action. Destructive menu items (Delete / Sync to Global Fonts) on a locked Class Manager row stay blocked.
* Fix: generalised rename-active detection so context sync also freezes during a chip-level rename (not just Class Manager rename).

= 1.0.22 =
* Fix: unlocking a global class to rename it in the Class Manager no longer re-locks the class mid-rename. Context sync now freezes while a Class Manager rename is active, with a 1.5s grace window on double-click intent so the very first tick (before Elementor sets `contenteditable`) is also covered. The "locked class" toast is also suppressed for keystrokes inside rename inputs.

= 1.0.21 =
* Change: swapped the inline padlock SVGs for Font Awesome Free v7.2.0 solid `lock` / `lock-open` icons. Visual size, colour, and behaviour unchanged.

= 1.0.20 =
* Fix: "can't unlock" regression caused by a self-inflicted DOM feedback loop. `refreshPadlockButton()` re-appended the SVG on every call, which fired `childList` mutations the panel MutationObserver treated as signal, scheduling another scan → another refresh → ~230 DOM writes per second. Real mouse clicks were flipping the state briefly then getting stomped back before rendering. `refreshPadlockButton()` is now idempotent (tagged with `data-ecl-state`), and the observer now also skips mutations whose target is inside our own padlocks / anchors.

= 1.0.19 =
* Fix: a native click on the padlock triggers Elementor to re-render the chip row, during which `aria-pressed="true"` disappears for one observer tick. The 1.0.17 context sync treated that transient `null` as a context change and called `relockAll()`. The sync now only relocks on transitions between two concrete (non-null) values, and never overwrites a known-good cached reading with a transient null.

= 1.0.18 =
* Fix: the padlock button itself uses `aria-pressed="true"` to indicate the locked state, and `getActiveChipLabel()` was matching it as the "active chip", causing spurious relocks. Chip selector now skips `.ecl-padlock`, and the very first context sync no longer counts as a transition.

= 1.0.17 =
* Change: lock state is now ephemeral per editor load. Previous behaviour stored unlock preference in `localStorage`, so a once-unlocked class stayed unlocked across hard refreshes — the opposite of the plugin's intent. Every page load now starts with every class locked by default.
* Change: auto-relock on context change. Switching element in the preview, or clicking a different class chip in Style → Classes (including `local`), clears the in-memory unlock Set and repaints padlocks.

= 1.0.16 =
* Fix: duplicate padlock on Style → Classes chips. Chip scanning matched both the `MuiChip-root` and its `MuiChipGroup-root MuiAutocomplete-tag` wrapper, so clicking one padlock flipped its icon while the stale sibling still showed "Locked". Wrapper elements are now filtered out, and orphan padlocks left next to wrappers are pruned.

= 1.0.15 =
* Fix: Class Manager allowed renaming / deleting / reordering locked classes because those actions do not route through the `global-classes` style provider we already wrap. The Class Manager is now UI-locked for locked classes: More actions menu, drag handle, and double-click-to-rename are blocked; menu item clicks (Rename / Delete) are rejected when the source item is locked; stray `contenteditable="true"` is reverted to false.
* Fix: network interceptor now re-injects locked classes that were deleted client-side, so the outgoing PUT never removes them from the kit.
* Fix: padlock in Class Manager rows renders inline after More actions instead of over it.

= 1.0.9 =
* Fix: fallback mapping for truncated labels (for example `converted-...`) now picks a deterministic global class id when multiple labels share the prefix, instead of dropping the padlock.
* Fix: additional Classes field fallback scan attaches padlocks in the Style panel even when chip structure differs from expected MUI internals.

= 1.0.8 =
* Fix: padlock on class chips is rendered adjacent to the chip (not inside), preventing MUI overflow clipping that could hide the icon on narrow/truncated tags.
* Fix: chip padlocks are keyed by a persistent anchor id so React remounts/class-id swaps refresh correctly.

= 1.0.7 =
* Fix: padlocks on Style → Classes use the element's applied class ids from Elementor V2 (`getElementSetting` / settings fallback), aligned by index with MUI autocomplete chips, so truncated labels like `converted-…` still show the lock control.
* Fix: updating a chip's resolved class id replaces the previous padlock instead of leaving the first one stuck.
* Change: label-only chip scan runs only under autocomplete roots (reduces attaching to unrelated chips).

= 1.0.6 =
* Fix: padlock injection scans and observes `#elementor-panel-inner`, `#elementor-panel`, and `#elementor-editor-wrapper-v2` together (V2 can render chips outside the inner node while it still exists).
* Fix: periodic `scanDom` every 2s and a debounced listener on `elementor/editor-v2/editor-elements/style` so padlocks re-attach after React re-renders the class chips.

= 1.0.5 =
* Feature: block in-memory edits to locked global classes by wrapping Elementor's `global-classes` style provider (`updateProps`, `updateCustomCss`, `update`) and `editorElements.updateElementStyle` when the target id is a locked `g-*******` kit class.

= 1.0.4 =
* Feature: while a class is locked, `PUT` requests to `elementor/v1/global-classes` merge the frozen kit snapshot for that class so global definitions are not persisted (fetch + XMLHttpRequest, for Axios).
* UX: toast when a save body is rewritten; padlock "lock" action refreshes the snapshot from the server.

= 1.0.3 =
* Fix: editor integration always registers with Elementor; only the REST save guard stays gated on the Atomic elements experiment (so the UI still loads if PHP cannot detect the experiment).
* Fix: read `eclSiteId` from `elementor.config` root (matches `elementor/editor/localize_settings` placement).
* Feature: truncated class chip labels (ellipsis) resolve to a unique global class by prefix when possible; broader MUI chip selectors and panel scan fallbacks (`#elementor-panel`, `#elementor-editor-wrapper-v2`).
* Dev: `window.ELEMENTOR_CLASS_LOCK_ACTIVE` flag after script load; optional `WP_DEBUG` console diagnostics.

= 1.0.2 =
* Fix: editor script now boots on `elementor/init` / `elementor:init` (the old `elementor.on('init')` hook never fired, so nothing ran).
* Feature: padlocks also attach to global-class chips in Style → Classes (MUI chips), not only the global class manager list.
* One-time toast explains that "Local" is not a global kit class.

= 1.0.1 =
* Fix: activation no longer registers an uninstall hook with a closure (serialization fatal). Uninstall still uses uninstall.php.

= 1.0.0 =
* Initial public release.
