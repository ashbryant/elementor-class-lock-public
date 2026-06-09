# Changelog

All notable changes to this project will be documented in this file.

## 1.0.27 — 2026-06-09

### Fixed

- Corrected plugin author name from "David Ashby" to "Ash Bryant"

## 1.0.26 — 2026-06-05

### Changed

- Style panel controls (Layout, Spacing, Typography, etc.) are now visually dimmed (`opacity: 0.4`) and non-interactive (`pointer-events: none`) whenever the active class chip is a locked global class. The Classes row (chips and padlock) remains fully interactive so the user can still unlock. Unlocking immediately restores the controls to full opacity and interactivity.
- Added `aria-hidden="true"` to the controls list when locked so screen readers do not announce the dimmed controls as interactive.

## 1.0.25 — 2026-06-05

### Changed

- Padlock button aria-label now uses the full descriptive i18n strings in both locked and unlocked states instead of a bare "Locked: id" / "Unlocked: id" prefix.
- Unlocked padlock button now carries a native `title` attribute so hovering shows a tooltip: "Class is unlocked — switching to another class or element will re-lock it." This makes the auto-relock-on-context-switch behaviour discoverable without any extra UI.

## 1.0.24 — 2026-06-05

### Changed

- Editor boot, request rewrite, and network payload diagnostics now honour debug mode instead of always logging in the browser console.

### Fixed

- Hardened global-class snapshot seeding for Elementor 4.1.1+ by refusing to store label-only preview items as locked snapshots. The plugin now prefers full class objects from Elementor's `global-classes` provider and briefly retries while that provider is still booting, reducing the chance of invalid locked payload rewrites during early editor load.

## 1.0.23 — 2026-04-21

### Changed

- **"Rename" from a class's overflow menu now auto-unlocks the class.** In the Style → Classes chip overflow menu (the three-dots menu with Rename / Remove / Normal / Hover / Focus / Active), and equivalently in the Class Manager more-actions menu, clicking **Rename** on a locked class now behaves as an implicit unlock for that one class, followed by the rename. The lock's purpose is to prevent accidental *style* edits; renaming only changes the class label, is a deliberate action (open menu → pick Rename), and previously either silently failed or was immediately stomped by the context-sync relock. Other menu items (Delete, Sync to Global Fonts) on a locked Class Manager row stay blocked as before.
- Generalised rename-active detection (`isAnyRenameActive()`) to cover both Class Manager `<li>` and Style → Classes chip renames. Context sync freezes for both paths.

### Fixed

- Chip overflow menu source tracking: `lastChipMenuSourceClassId` is now set on any real-chip interaction (even when the chip doesn't resolve to a global class, e.g. `local`), preventing a prior global-chip click from bleeding through to a subsequent menuitem click on a different chip.

## 1.0.22 — 2026-04-21

### Fixed

- **Renaming an unlocked class re-locked it mid-rename, blocking the edit.** Flow: user clicks the padlock to unlock a global class, then double-clicks the class row in the Class Manager to rename it. Something in the rename interaction (likely a transient selection/active-chip shuffle inside Elementor) caused `syncSessionUnlocksToContext()` to see a context change and call `relockAll()`. The next `refreshClassManagerItemLockState()` tick saw the row was locked again, found the `[contenteditable="true"]` Elementor had just set on the label, and reverted it to `false` — killing the rename input before the user could type.
- Context sync now freezes (no relock, no cached-value update) while `isClassManagerRenameActive()` is true — i.e. any Class Manager `<li>` contains a `[contenteditable="true"]` descendant.
- Added a 1.5s rename grace window, bumped on every `dblclick` inside an unlocked Class Manager row, to cover the short gap between the user's dblclick and Elementor actually flipping the label to contenteditable.
- The "locked class" toast in `installStyleEditBlockerUi` no longer fires for keystrokes / pointer events inside a Class Manager rename input, even when the currently-selected preview element has a locked applied class.

## 1.0.21 — 2026-04-21

### Changed

- Swapped the inline padlock SVGs for the Font Awesome Free v7.2.0 solid `lock` and `lock-open` icons. Render size, color, and behaviour are unchanged — the SVGs now use a `0 0 640 640` viewBox internally but are still sized at 16×16 via the wrapper.

## 1.0.20 — 2026-04-21

### Fixed

- **Real mouse clicks on the padlock were being swallowed by a self-inflicted feedback loop (the actual root cause of the "can't unlock" reports).** Live DOM instrumentation in the running editor showed the padlock's `aria-label` was being rewritten roughly 230 times per second with no user input. `refreshPadlockButton()` unconditionally removed and re-appended the SVG icon on every call, which fired `childList` mutations inside the padlock. Our panel `MutationObserver` watched `childList: true, subtree: true` and only filtered out *added nodes* that were padlocks — the SVG children don't match that filter, so every refresh scheduled another debounced scan, which called `refreshPadlockButton` again, and so on. A human click landed in the middle of this loop, briefly flipped the state to unlocked, and the very next loop iteration stomped the state back before the pixels were visible.
- `refreshPadlockButton()` is now idempotent: it records a `data-ecl-state` of `locked` / `unlocked` and returns early when the DOM already matches, so repeated calls with the same state perform zero DOM writes.
- The panel `MutationObserver` now also ignores mutations whose `target` is inside our own padlocks (plus anchor placeholders and diag badges), so any internal re-render we might still do never triggers a rescan.

## 1.0.19 — 2026-04-21

### Fixed

- **Padlock still re-locked itself on a real mouse click (follow-up to 1.0.18).** A native click on the padlock triggers Elementor to re-render the chip row, during which the active chip's `aria-pressed="true"` disappears for one MutationObserver tick. `syncSessionUnlocksToContext()` saw the chip label transition `"converted-class-1" → null` and treated that as a context change, calling `relockAll()` and wiping the unlock the user just made. (Synthetic `dispatchEvent` clicks never reproduced this because they don't flow through React's event system the same way a real pointer click does.)
- We now ignore transient `null` readings entirely: the context sync only relocks on transitions *between two concrete values*, and a momentarily-missing element id or chip label never overwrites the last known-good cached reading.

## 1.0.18 — 2026-04-21

### Fixed

- **Padlock could re-lock itself immediately after an unlock click.** Two subtle race conditions in the new session-unlock logic (1.0.17) could wipe an unlock the user just made:
  1. `getActiveChipLabel()` queried for any `[aria-pressed="true"]` inside the Classes autocomplete, and our own padlock button also exposes `aria-pressed="true"` to signal the locked state. When DOM order happened to put the padlock before the chip, the "active chip" was reported as `Locked: g-xxxxxx`, which then flipped back to the chip label after the unlock click — that counted as a context change and tripped `relockAll()`.
  2. The very first scan after the editor booted compared `null → "<chip>"` and treated that as a context change too. If a padlock click landed in the same scan window, the unlock was wiped before it was even rendered.
- The chip selector now explicitly skips `.ecl-padlock` elements, and the context sync only relocks on *real* transitions (ignoring the initial `null → …` capture).

## 1.0.17 — 2026-04-21

### Changed

- **Lock state is now ephemeral per editor load.** Previously, unlocking a global class wrote `0` to `localStorage` (`ecl_lock_{siteId}_{classId}`) and that value persisted across hard refreshes, so users who had once unlocked a class saw it still unlocked the next time they opened the editor. This made the lock feel broken — the whole point of the plugin is to prevent *accidental* global edits, and a persistent unlock is the opposite of that. The lock Set now lives only in the editor's in-memory state. Every page load starts with **every class locked by default**, and the user must re-click the padlock to edit globally.
- **Auto re-lock on context change.** The session unlock Set is cleared automatically whenever the editing context changes — either the selected element in the preview, or the active class chip in Style → Classes (e.g. clicking `local` after editing a global class). Padlocks immediately repaint to the locked icon, so you never carry an accidental unlock over to a different element or class.

## 1.0.16 — 2026-04-21

### Fixed

- **Duplicate padlock on Style → Classes chips.** Chip scanning picked up both the inner `MuiChip-root` and its `MuiChipGroup-root MuiAutocomplete-tag` wrapper, so two padlocks were rendered per global class. Clicking one only flipped that padlock's icon; the stale sibling still showed "Locked", making it look like the padlock was unresponsive and preventing the user from unlocking the class. We now ignore chip-group wrappers (and any element that contains another chip) in both `scanChips` and `findOrderedClassChipsInRoots`, and prune any orphaned inline padlocks left next to wrappers on subsequent scans.

## 1.0.15 — 2026-04-21

### Fixed

- **Class Manager allowed editing locked classes.** The V4 Class Manager (opened from Style → Classes → "Class Manager") exposes a "More actions" menu with Rename / Delete / Sync to Global Fonts plus a drag handle. None of those paths route through the `global-classes` style provider actions we already wrap, so locked classes could still be renamed, deleted, or reordered from the manager. We now:
  - Detect Class Manager list items (`.class-item-more-actions`, `.class-item-sortable-trigger`) and tag locked ones with `ecl-cm-locked` so CSS can dim the drag handle and overflow button.
  - Block `pointerdown` / `mousedown` / `click` / `dblclick` on the More actions button, the drag handle, and double-click-to-rename for locked items, emitting the throttled "locked" toast.
  - Track the source list item when the More actions menu opens (menus are portaled outside the `<li>`) and reject menu item clicks that belong to a locked source, so Rename / Delete never dispatch.
  - Neutralize any `[contenteditable="true"]` rename input that slips through by flipping it back to `false` and blurring.
- **Network interceptor now re-adds deleted locked classes.** `rewriteBodyString` previously only patched entries still present in `items`; if a locked class was removed from the PUT body, the delete went through. We now also re-inject any missing locked snapshots (and put their id back into sibling `order` arrays) before the request leaves the browser.
- **Padlock no longer overlaps "More actions".** In Class Manager rows the padlock now renders inline after `.class-item-more-actions` instead of absolutely positioned over it, so the overflow menu is always clickable when the class is unlocked.

## 1.0.9 — 2026-04-21

### Fixed

- Truncated class chips (e.g. `converted-...`) now use a deterministic prefix fallback when multiple global class labels share the same prefix, so padlocks still render.
- Added a second Style panel "Classes" scan path that can attach padlocks even when the chip DOM differs from expected MUI autocomplete internals.

## 1.0.8 — 2026-04-20

### Fixed

- Padlock visibility on MUI chips: the control now mounts adjacent to the chip and uses an anchor id, avoiding overflow clipping on truncated tags and keeping padlocks in sync across remounts.

## 1.0.7 — 2026-04-20

### Fixed

- **Padlock missing on truncated class chips:** Style → Classes now pairs chips with the real `classes` list from `elementorV2.editorElements.getElementSetting( elementId, 'classes' )` (and a `settings.get( 'classes' )` fallback), so kit ids like `g-*******` get a padlock even when the chip label is shortened (for example `converted-…`).
- **Padlock refresh:** `upsertPadlock` replaces an existing padlock when the resolved class id changes instead of skipping forever.
- **Fewer false targets:** chip scanning is limited to nodes under MUI autocomplete roots (plus `MuiAutocomplete-root` classname variants).

## 1.0.6 — 2026-04-20

### Fixed

- Padlocks disappearing after style guards: class chips are now scanned under **all** of `#elementor-panel-inner`, `#elementor-panel`, and `#elementor-editor-wrapper-v2`, with a `MutationObserver` on each.
- Re-scan padlocks on a short interval and when Elementor emits `elementor/editor-v2/editor-elements/style` (debounced), so React chip re-mounts do not leave the panel without padlocks.

## 1.0.5 — 2026-04-20

### Added

- In-memory edit blocking for locked kit class ids (`g-*******`): wrap Elementor V2 `window.elementorV2.editorStylesRepository.stylesRepository` provider `global-classes` actions (`updateProps`, `updateCustomCss`, `update`) and `window.elementorV2.editorElements.updateElementStyle` so locked classes cannot be mutated in the Redux/editor state (with throttled toast `i18n.editBlockedToast`).
- Retries `scheduleStyleGuards()` until V2 modules exist; re-runs shortly after `document:loaded`.

## 1.0.4 — 2026-04-20

### Added

- **Kit save protection:** for each locked global class id, store a deep clone of the class payload from `GET …/global-classes?context=preview`. Outgoing `PUT` bodies (via `fetch` or `XMLHttpRequest` / Axios) are rewritten so locked ids match the snapshot again before they reach WordPress, so the kit meta file does not receive accidental global edits.
- Throttled Elementor toast (`i18n.kitRewrittenToast`) when a body is rewritten.

### Changed

- Padlock tooltip copy for the locked state now describes kit protection rather than implying in-panel controls are disabled.

## 1.0.3 — 2026-04-20

### Fixed

- Editor PHP gate: `Editor_Integration` now always registers when Elementor loads. Only `Class_Save_Guard` remains behind the `e_atomic_elements` experiment (avoids false negatives where the UI never loaded).
- Site ID for `localStorage` keys: read `elementor.config.eclSiteId` first (filter adds the key on the editor config root, not under `settings`).

### Changed

- Broader chip discovery (`MuiChip-root` / `Chip-root` variants), panel scan fallbacks (`#elementor-panel-inner` → `#elementor-panel` → `#elementor-editor-wrapper-v2`), and prefix resolution for truncated chip labels.
- Script dependency: `elementor-common` enqueued before the editor bundle.
- Admin copy: experiment-off notice now refers to REST protection rather than claiming the UI will not load.

### Added

- `window.ELEMENTOR_CLASS_LOCK_ACTIVE` inline flag for quick verification in DevTools.
- Localized `atomicActive` and a one-time toast when the experiment is off (`i18n.atomicOffToast`).

## 1.0.2 — 2026-04-20

### Fixed

- Editor script never initialised: Elementor dispatches `elementor/init` on `window` (and `elementor:init` on jQuery), not `elementor.on('init')`.

### Added

- Padlock injection for **MUI class chips** in the right-hand panel (e.g. Style → **Classes**), resolving kit class IDs by label or `g-*******` pattern.
- One-time Elementor toast (`sessionStorage` key `ecl_ui_hint`) clarifying that the **Local** chip is not a global class.

## 1.0.1 — 2026-04-20

### Fixed

- Activation fatal: removed `register_uninstall_hook()` with a closure (WordPress stores uninstall callbacks in the database; closures cannot be serialised). Cleanup continues to run via `uninstall.php` only.
- Hardened activation: require `wp-admin/includes/plugin.php` before calling `deactivate_plugins()`.
- Admin notices: fall back to classic markup when `wp_admin_notice()` is unavailable (older WordPress).

## 1.0.0 — 2026-04-20

### Added

- WordPress plugin bootstrap with PSR-4-style `src/` layout and Composer-free autoloader.
- Elementor `e_atomic_elements` experiment gate: editor integration and REST guard load only when the experiment is active.
- Admin notice when Elementor is missing on activation, and when the experiment is off while the plugin remains active.
- Editor REST header bridge (runs early) so legitimate `PUT /elementor/v1/global-classes` requests include the unlock nonce.
- `Class_Save_Guard` returning HTTP 403 when the nonce header is missing or invalid.
- Editor script: fetches global classes, maps labels to IDs, injects padlock buttons (MutationObserver on `#elementor-panel-inner`).
- `localStorage` keys `ecl_lock_{siteId}_{classId}` with locked-as-default semantics.
- Optional “Promote to Global” placeholder control (toast explains v1 limitation).
- `readme.txt`, `TESTING.md`, `uninstall.php`, and `Logger` gated on `WP_DEBUG`.
