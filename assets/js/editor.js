/**
 * Elementor Class Lock — editor behaviour (Elementor V4 / atomic).
 *
 * High-level architecture
 * -----------------------
 * 1. Padlock UI — an inline SVG button is injected next to every global kit
 *    class (`g-*******`) in Style → Classes chips and in the Class Manager
 *    list. Clicking the padlock toggles the class's entry in
 *    `state.sessionUnlocked` (an in-memory `Set`).
 *
 * 2. Ephemeral unlock state (v1.0.17) — `state.sessionUnlocked` lives only
 *    for the current editor page load. Every hard refresh starts locked.
 *    `localStorage` is intentionally NOT used; persistent unlocks defeated
 *    the plugin's whole purpose of guarding against accidental global edits.
 *
 * 3. Auto re-lock on context change (v1.0.17) — `syncSessionUnlocksToContext`
 *    watches the currently-selected element id and the active class chip
 *    label. When either changes between two concrete values, the Set is
 *    cleared and padlocks repaint. Transient `null` readings (React
 *    re-renders) do not count as a context change (v1.0.19).
 *
 * 4. Layered edit protection:
 *    - `scheduleStyleGuards` wraps Elementor V2 `global-classes` provider
 *      actions and `editorElements.updateElementStyle` so in-memory
 *      mutations on locked ids are rejected with a throttled toast.
 *    - `rewriteBodyString` rewrites outgoing `PUT /global-classes` bodies
 *      (fetch + XMLHttpRequest/Axios) against frozen snapshots and
 *      re-injects locked entries that were deleted client-side.
 *    - Class Manager DOM is locked down: more-actions menu, drag handle,
 *      dblclick rename, stray `contenteditable="true"` reverted.
 *    - PHP `Class_Save_Guard` returns HTTP 403 without the
 *      `X-ECL-Unlock-Token` nonce as a server-side backstop.
 *
 * Invariants that MUST be preserved (documented here because they have all
 * been broken at least once and produced the "can't unlock" regression
 * chain in 1.0.16 → 1.0.20):
 *
 *   a. `refreshPadlockButton` MUST be idempotent. It sets/checks
 *      `btn.dataset.eclState` and returns early when the DOM already
 *      matches, because the panel `MutationObserver` watches
 *      `childList: true, subtree: true`. Non-idempotent writes feed back
 *      into the observer at ~230×/sec and stomp live user clicks.
 *
 *   b. The panel `MutationObserver` MUST filter out mutations whose
 *      `target` or `addedNodes` are inside our own injected nodes
 *      (`.ecl-padlock`, `[data-ecl-anchor-id]`, `[data-ecl-diag-badge]`).
 *
 *   c. `getActiveChipLabel` MUST skip `.ecl-padlock` elements. Padlock
 *      buttons expose `aria-pressed="true"` to signal locked state; the
 *      same attribute is used by the MUI Autocomplete for the active chip.
 *
 *   d. `syncSessionUnlocksToContext` MUST only relock on transitions
 *      between two concrete (non-null) values, and MUST NOT overwrite the
 *      last known-good cached reading with a transient null.
 *
 *   e. `syncSessionUnlocksToContext` MUST also bail out entirely when
 *      `isAnyRenameActive()` is true, or when we are inside the short
 *      `state.renameGraceUntil` window. Relocking mid-rename would
 *      revert the rename input's `contenteditable` to false and kill the
 *      edit. `isAnyRenameActive()` covers BOTH the Class Manager row
 *      rename (`<li>` → contenteditable) AND the Style → Classes chip
 *      overflow rename (chip → contenteditable).
 *
 *   f. "Rename" menu items (Style → Classes chip overflow menu, or the
 *      Class Manager more-actions menu) MUST auto-unlock the associated
 *      class and extend the rename grace window, not be blocked. The
 *      lock is about preventing accidental *style* edits; renaming only
 *      changes the class label and is a deliberate action (opening the
 *      menu, picking Rename). Other menu items against a locked class
 *      (Delete / Sync to Global Fonts) stay blocked.
 *
 * @package ElementorClassLock
 */
( function () {
	'use strict';

	const cfg = window.elementorClassLockConfig || {};
	const i18n = cfg.i18n || {};

	const warn = ( ...args ) => {
		if ( cfg.debug && typeof console !== 'undefined' && console.warn ) {
			console.warn( '[ECL]', ...args ); // eslint-disable-line no-console
		}
	};

	const info = ( ...args ) => {
		if ( cfg.debug && typeof console !== 'undefined' && console.info ) {
			console.info( ...args ); // eslint-disable-line no-console
		}
	};

	try {
		info( '[ECL] editor.js loaded', { cfg } );
	} catch ( e ) {}
	window.ELEMENTOR_CLASS_LOCK_LOADED = true;

	// Diagnostic scanner is opt-in only (set window.__eclDiag = true in console
	// before the script loads, or call window.__eclDiagScan manually later).
	// It is no longer installed by default because the MutationObserver on
	// document.body combined with our own DOM inserts caused a feedback loop
	// that froze the editor tab.
	const DIAG_ENABLED = window.__eclDiag === true;

	const installDiagnosticScanner = () => {
		if ( window.__eclDiagInstalled ) {
			return;
		}
		window.__eclDiagInstalled = true;

		const findPanels = () =>
			[
				document.getElementById( 'elementor-panel-inner' ),
				document.getElementById( 'elementor-panel' ),
				document.getElementById( 'elementor-editor-wrapper-v2' ),
				document.body,
			].filter( Boolean );

		const MUI_SELECTORS = [
			'.MuiChip-root',
			'[class*="MuiChip-root"]',
			'[class*="Chip-root"]',
			'.MuiAutocomplete-tag',
			'[class*="Autocomplete-tag"]',
		].join( ', ' );

		const isChipLike = ( el ) => {
			if ( ! el || el.nodeType !== 1 ) {
				return false;
			}
			const txt = ( el.textContent || '' ).trim();
			if ( ! txt || txt.length > 80 ) {
				return false;
			}
			const rect = el.getBoundingClientRect();
			if ( rect.height < 14 || rect.height > 60 || rect.width < 12 ) {
				return false;
			}
			const children = el.children ? el.children.length : 0;
			if ( children > 8 ) {
				return false;
			}
			return true;
		};

		const candidatesByText = ( panel ) => {
			const out = [];
			const walker = document.createTreeWalker(
				panel,
				NodeFilter.SHOW_ELEMENT,
				null
			);
			let current = walker.nextNode();
			let guard = 0;
			while ( current && guard++ < 5000 ) {
				const t = ( current.textContent || '' ).trim().toLowerCase();
				if (
					t &&
					( /^local$/.test( t ) ||
						t.startsWith( 'converted-' ) ||
						/^g-[a-f0-9]{7}/.test( t ) )
				) {
					if ( isChipLike( current ) ) {
						out.push( current );
					}
				}
				current = walker.nextNode();
			}
			return out;
		};

		const reported = { firstScan: false, hitsLogged: false };

		const runScan = () => {
			try {
				const panels = findPanels();
				let muiFound = 0;
				let textFound = 0;
				let tagged = 0;
				const samples = [];

				panels.forEach( ( panel ) => {
					panel.querySelectorAll( MUI_SELECTORS ).forEach( ( chip ) => {
						muiFound += 1;
					} );

					candidatesByText( panel ).forEach( ( chip ) => {
						textFound += 1;
						const label = ( chip.textContent || '' ).trim().toLowerCase();
						if ( ! label || /^local$/i.test( label ) ) {
							return;
						}
						if ( chip.getAttribute( 'data-ecl-diag' ) === '1' ) {
							return;
						}
						chip.setAttribute( 'data-ecl-diag', '1' );
						if ( samples.length < 3 ) {
							samples.push( {
								label,
								tag: chip.tagName,
								className: chip.className,
								outer: ( chip.outerHTML || '' ).slice( 0, 400 ),
							} );
						}
						const badge = document.createElement( 'span' );
						badge.textContent = 'LOCK';
						badge.setAttribute( 'data-ecl-diag-badge', '1' );
						badge.style.cssText = [
							'display:inline-block',
							'margin-inline-start:4px',
							'padding:2px 5px',
							'font:700 9px/1 system-ui,sans-serif',
							'color:#fff',
							'background:#e91e63',
							'border-radius:999px',
							'letter-spacing:0.5px',
							'vertical-align:middle',
							'z-index:2147483647',
							'pointer-events:auto',
							'position:relative',
						].join( ';' );
						if ( chip.parentElement ) {
							chip.insertAdjacentElement( 'afterend', badge );
							tagged += 1;
						}
					} );
				} );

				if ( ! reported.firstScan ) {
					reported.firstScan = true;
					info(
						'[ECL][diag] first scan — muiChips:',
						muiFound,
						'textChips:',
						textFound,
						'tagged:',
						tagged
					);
				}
				if ( ( muiFound > 0 || textFound > 0 ) && ! reported.hitsLogged ) {
					reported.hitsLogged = true;
					info(
						'[ECL][diag] found chips — muiChips:',
						muiFound,
						'textChips:',
						textFound,
						'samples:',
						samples
					);
				}
			} catch ( e ) {
				// eslint-disable-next-line no-console
				console.warn( '[ECL][diag] scan error', e );
			}
		};

		window.__eclDiagScan = runScan;

		runScan();
		window.setInterval( runScan, 3000 );
	};

	if ( DIAG_ENABLED ) {
		try {
			if ( document.readyState === 'loading' ) {
				document.addEventListener( 'DOMContentLoaded', installDiagnosticScanner );
			} else {
				installDiagnosticScanner();
			}
		} catch ( e ) {}
	} else {
		window.__eclDiagEnable = () => {
			window.__eclDiag = true;
			try {
				installDiagnosticScanner();
			} catch ( e ) {}
		};
	}

	const getSiteId = () => {
		const cfgRoot = window.elementor?.config?.eclSiteId;
		if ( cfgRoot !== undefined && cfgRoot !== null && cfgRoot !== '' ) {
			return String( cfgRoot );
		}
		const fromNested = window.elementor?.config?.settings?.eclSiteId;
		if ( fromNested !== undefined && fromNested !== null && fromNested !== '' ) {
			return String( fromNested );
		}
		return '0';
	};

	/**
	 * Class chips can mount under the legacy panel inner, the panel shell, or the V2 wrapper.
	 * We scan/observe every present root so padlocks are not missed when `#elementor-panel-inner` exists but is empty.
	 */
	const getScanRoots = () => {
		const ids = [
			'elementor-panel-inner',
			'elementor-panel',
			'elementor-editor-wrapper-v2',
		];
		const seen = new Set();
		const roots = [];
		ids.forEach( ( id ) => {
			const el = document.getElementById( id );
			if ( el && ! seen.has( el ) ) {
				seen.add( el );
				roots.push( el );
			}
		} );
		return roots;
	};

	const getScanRoot = () => getScanRoots()[ 0 ] || null;

	const getPromoteMountRoot = () =>
		document.getElementById( 'elementor-panel-inner' ) ||
		document.getElementById( 'elementor-panel' );

	/**
	 * Lock state is ephemeral per editor load: every class starts locked on
	 * every page load, and the user's unlocks live only in this in-memory Set
	 * for the current editor session. This matches the plugin's intent — the
	 * lock exists to prevent accidental edits, so unlocks should never silently
	 * survive a refresh or leak between editing contexts. (Old versions used
	 * localStorage and persisted unlocks, which made the lock feel broken.)
	 *
	 * We clear the Set whenever the active editing element or the active class
	 * chip changes, so switching element / clicking `local` re-locks the
	 * previously unlocked global class automatically.
	 */
	const state = {
		items: {},
		labelToId: new Map(),
		/** @type {Set<string>} class ids currently unlocked for this session. */
		sessionUnlocked: new Set(),
		/** @type {string|null} last seen active editing element id, for relock detection. */
		lastEditingElementId: null,
		/** @type {string|null} last seen active class chip aria-label. */
		lastActiveChipLabel: null,
		/** @type {boolean} true once we've captured the initial context. */
		contextInitialized: false,
		/**
		 * Timestamp (ms) up to which auto re-lock is suppressed. Bumped when
		 * the user signals intent to rename a class in the Class Manager
		 * (double-click on the class row / sortable trigger). Covers the
		 * short window between the dblclick and Elementor flipping the label
		 * to `contenteditable="true"`, during which `isClassManagerRenameActive()`
		 * would otherwise return false and a context sync could relock the
		 * class and strip the rename input before it even appears.
		 */
		renameGraceUntil: 0,
		/** @type {Record<string, object>} Frozen kit payloads per class id while locked (deep clones). */
		lockedSnapshots: {},
		/** @type {MutationObserver[]} */
		panelObservers: [],
		bodyObserver: null,
		panelWarned: false,
		refreshLabelMapRetryT: 0,
		refreshLabelMapRetryCount: 0,
		scanDebounceT: 0,
		scanIntervalT: 0,
		anchorSeq: 0,
	};

	const isLocked = ( classId ) =>
		!! classId && ! state.sessionUnlocked.has( classId );

	const hasCompleteGlobalClassItem = ( item ) =>
		!! item &&
		typeof item === 'object' &&
		typeof item.id === 'string' &&
		Array.isArray( item.variants );

	const setLocked = ( classId, locked ) => {
		if ( ! classId ) {
			return;
		}
		if ( locked ) {
			state.sessionUnlocked.delete( classId );
		} else {
			state.sessionUnlocked.add( classId );
		}
	};

	const relockAll = () => {
		if ( state.sessionUnlocked.size === 0 ) {
			return false;
		}
		state.sessionUnlocked.clear();
		return true;
	};

	/**
	 * True when the user is actively renaming a class — either in the
	 * Class Manager (a `<li>` with a `[contenteditable="true"]` inside)
	 * or from the Style → Classes chip overflow menu (the chip label is
	 * flipped to contenteditable). While this is true we must NOT
	 * auto-relock — a relock would revert the contenteditable back to
	 * `false`, blurring the rename input the user just opened.
	 */
	const isAnyRenameActive = () => {
		try {
			const editables = document.querySelectorAll(
				'[contenteditable="true"]'
			);
			for ( const ed of editables ) {
				if ( ! ed.closest ) {
					continue;
				}
				const li = ed.closest( 'li' );
				if ( li && isClassManagerItem( li ) ) {
					return true;
				}
				const chipRoot = ed.closest(
					'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]'
				);
				if ( chipRoot ) {
					return true;
				}
			}
		} catch ( e ) {
			/* ignore */
		}
		return false;
	};

	const markRenameIntent = () => {
		state.renameGraceUntil = Date.now() + 1500;
	};

	const deepClone = ( obj ) => JSON.parse( JSON.stringify( obj ) );

	const captureSnapshotForClass = ( classId ) => {
		if ( state.items[ classId ] ) {
			state.lockedSnapshots[ classId ] = deepClone( state.items[ classId ] );
		}
	};

	const pruneSnapshots = () => {
		Object.keys( state.lockedSnapshots ).forEach( ( id ) => {
			if ( ! state.items[ id ] || ! isLocked( id ) ) {
				delete state.lockedSnapshots[ id ];
			}
		} );
	};

	const seedSnapshotsForLockedClasses = () => {
		Object.keys( state.items ).forEach( ( id ) => {
			if ( isLocked( id ) && ! state.lockedSnapshots[ id ] ) {
				state.lockedSnapshots[ id ] = deepClone( state.items[ id ] );
			}
		} );
		pruneSnapshots();
	};

	let lastKitMergeToastAt = 0;
	const showKitMergeToast = () => {
		const now = Date.now();
		if ( now - lastKitMergeToastAt < 8000 ) {
			return;
		}
		lastKitMergeToastAt = now;
		if ( window.elementor?.notifications?.showToast ) {
			window.elementor.notifications.showToast( {
				message:
					i18n.kitRewrittenToast ||
					'Class Lock reverted a locked class in the save request so the kit file is unchanged.',
			} );
		}
	};

	const isElementorApiWrite = ( method, url ) => {
		const m = String( method || '' ).toUpperCase();
		if ( m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ) {
			return false;
		}
		const u = String( url || '' );
		return u.indexOf( 'elementor/v' ) !== -1 && u.indexOf( '/usage' ) === -1;
	};

	const LOCKED_ID_RE = /^g-[a-f0-9]{7}$/i;

	const revertLockedInObject = ( node ) => {
		if ( ! node || typeof node !== 'object' ) {
			return false;
		}
		let changed = false;

		if ( Array.isArray( node ) ) {
			for ( let i = 0; i < node.length; i++ ) {
				if ( revertLockedInObject( node[ i ] ) ) {
					changed = true;
				}
			}
			return changed;
		}

		if ( typeof node.id === 'string' && LOCKED_ID_RE.test( node.id ) ) {
			const id = node.id.toLowerCase();
			if ( isLocked( id ) && state.lockedSnapshots[ id ] ) {
				const snap = deepClone( state.lockedSnapshots[ id ] );
				for ( const k of Object.keys( node ) ) {
					delete node[ k ];
				}
				Object.assign( node, snap );
				return true;
			}
		}

		if ( node.items && typeof node.items === 'object' && ! Array.isArray( node.items ) ) {
			for ( const key of Object.keys( node.items ) ) {
				if ( LOCKED_ID_RE.test( key ) ) {
					const id = key.toLowerCase();
					if ( isLocked( id ) && state.lockedSnapshots[ id ] ) {
						const current = JSON.stringify( node.items[ key ] );
						const snap = JSON.stringify( state.lockedSnapshots[ id ] );
						if ( current !== snap ) {
							node.items[ key ] = deepClone( state.lockedSnapshots[ id ] );
							changed = true;
						}
					}
				}
			}
		}

		for ( const key of Object.keys( node ) ) {
			const val = node[ key ];
			if ( val && typeof val === 'object' ) {
				if ( revertLockedInObject( val ) ) {
					changed = true;
				}
			}
		}

		return changed;
	};

	/**
	 * Re-add locked classes that were removed from an outbound payload entirely
	 * (for example when the user clicked "Delete" in the Class Manager). The
	 * existing `revertLockedInObject` only patches keys that are still present
	 * in `items`; this pass restores snapshots that have vanished and re-adds
	 * them to any sibling `order` array.
	 */
	const reinjectDeletedLocked = ( node ) => {
		if ( ! node || typeof node !== 'object' || Array.isArray( node ) ) {
			return false;
		}
		let changed = false;
		if (
			node.items &&
			typeof node.items === 'object' &&
			! Array.isArray( node.items )
		) {
			Object.keys( state.lockedSnapshots ).forEach( ( id ) => {
				if ( ! isLocked( id ) ) {
					return;
				}
				if ( node.items[ id ] ) {
					return;
				}
				node.items[ id ] = deepClone( state.lockedSnapshots[ id ] );
				if ( Array.isArray( node.order ) && node.order.indexOf( id ) === -1 ) {
					node.order.push( id );
				}
				changed = true;
			} );
		}
		for ( const key of Object.keys( node ) ) {
			const val = node[ key ];
			if ( val && typeof val === 'object' ) {
				if ( reinjectDeletedLocked( val ) ) {
					changed = true;
				}
			}
		}
		return changed;
	};

	const rewriteBodyString = ( bodyStr ) => {
		try {
			const parsed = JSON.parse( bodyStr );
			const reverted = revertLockedInObject( parsed );
			const reinjected = reinjectDeletedLocked( parsed );
			const changed = reverted || reinjected;
			if ( ! changed ) {
				return { body: bodyStr, changed: false };
			}
			return { body: JSON.stringify( parsed ), changed: true };
		} catch ( e ) {
			return { body: bodyStr, changed: false };
		}
	};

	const prepareGlobalClassesPut = ( input, init ) => {
		const nextInit = init && typeof init === 'object' ? { ...init } : {};
		const method = String(
			nextInit.method || ( typeof input !== 'string' && input && input.method ) || 'GET'
		).toUpperCase();
		const url = typeof input === 'string' ? input : input && input.url ? String( input.url ) : '';
		if ( ! isElementorApiWrite( method, url ) ) {
			return { input, init: nextInit };
		}
		if ( typeof nextInit.body !== 'string' ) {
			return { input, init: nextInit };
		}
		const { body, changed } = rewriteBodyString( nextInit.body );
		if ( ! changed ) {
			return { input, init: nextInit };
		}
		info( '[ECL] rewrote locked class in outbound fetch', method, url );
		showKitMergeToast();
		return { input, init: { ...nextInit, body } };
	};

	const installFetchInterceptor = () => {
		if ( window.__eclFetchLockMerge ) {
			return;
		}
		window.__eclFetchLockMerge = true;
		const downstream = window.fetch.bind( window );
		window.fetch = function ( input, init ) {
			try {
				const url =
					typeof input === 'string' ? input : input && input.url ? String( input.url ) : '';
				const method = String(
					( init && init.method ) || ( input && input.method ) || 'GET'
				).toUpperCase();
				if ( url && /elementor|wp-json/i.test( url ) && method !== 'GET' ) {
					const b = init && init.body;
					info(
						'[ECL][net] fetch',
						method,
						url,
						'body-type:',
						b && b.constructor ? b.constructor.name : typeof b,
						'body-preview:',
						typeof b === 'string' ? b.slice( 0, 200 ) : '<non-string>'
					);
				}
			} catch ( e ) {}
			const prepared = prepareGlobalClassesPut( input, init );
			return downstream( prepared.input, prepared.init );
		};
	};

	const installXhrInterceptor = () => {
		if ( window.__eclXhrLockMerge ) {
			return;
		}
		window.__eclXhrLockMerge = true;
		const proto = XMLHttpRequest.prototype;
		const innerOpen = proto.open;
		proto.open = function ( method, url ) {
			this.__eclMethod = method;
			this.__eclUrl = url;
			return innerOpen.apply( this, arguments );
		};
		const innerSend = proto.send;
		proto.send = function ( body ) {
			try {
				const method = String( this.__eclMethod || '' ).toUpperCase();
				const url = String( this.__eclUrl || '' );
				if ( url && /elementor|wp-json/i.test( url ) && method && method !== 'GET' ) {
					info(
						'[ECL][net] xhr',
						method,
						url,
						'body-type:',
						body && body.constructor ? body.constructor.name : typeof body,
						'body-preview:',
						typeof body === 'string' ? body.slice( 0, 200 ) : '<non-string>'
					);
				}
			} catch ( e ) {}
			if (
				typeof body === 'string' &&
				isElementorApiWrite( this.__eclMethod, this.__eclUrl )
			) {
				const { body: nextBody, changed } = rewriteBodyString( body );
				if ( changed ) {
					info(
						'[ECL] rewrote locked class in outbound XHR',
						this.__eclMethod,
						this.__eclUrl
					);
					showKitMergeToast();
					body = nextBody;
				}
			}
			return innerSend.call( this, body );
		};
	};

	const GLOBAL_CLASSES_PROVIDER_KEY = 'global-classes';

	const normalizeKitClassId = ( id ) =>
		typeof id === 'string' ? id.trim().toLowerCase() : '';

	const isKitClassIdShape = ( id ) => {
		const n = normalizeKitClassId( id );
		return n.length > 0 && /^g-[a-f0-9]{7}$/.test( n );
	};

	const shouldBlockKitClassId = ( id ) => {
		const n = normalizeKitClassId( id );
		return isKitClassIdShape( id ) && isLocked( n );
	};

	const getEditingElementId = () => {
		try {
			const cur = window.elementor?.getCurrentElement?.();
			const m = cur?.model;
			if ( m && typeof m.get === 'function' ) {
				const id = m.get( 'id' );
				if ( id != null && String( id ).length > 0 ) {
					return String( id );
				}
			}
		} catch ( e ) {
			/* ignore */
		}
		return null;
	};

	const readClassesSettingValue = ( ee, elementId ) => {
		try {
			if ( typeof ee.getElementSetting === 'function' ) {
				const raw = ee.getElementSetting( elementId, 'classes' );
				let val = null;
				if ( raw && typeof raw.get === 'function' ) {
					const v = raw.get( 'value' );
					val = Array.isArray( v ) ? v : null;
				}
				if ( ! val && raw && typeof raw === 'object' && Array.isArray( raw.value ) ) {
					val = raw.value;
				}
				if ( ! val && Array.isArray( raw ) ) {
					val = raw;
				}
				if ( Array.isArray( val ) ) {
					return val;
				}
			}
		} catch ( e ) {
			/* ignore */
		}
		try {
			if ( typeof ee.getElement === 'function' ) {
				const elModel = ee.getElement( elementId );
				const s = elModel?.settings?.get?.( 'classes' );
				let val = null;
				if ( s && typeof s.get === 'function' ) {
					const v = s.get( 'value' );
					val = Array.isArray( v ) ? v : null;
				}
				if ( ! val && s && typeof s === 'object' && Array.isArray( s.value ) ) {
					val = s.value;
				}
				if ( ! val && Array.isArray( s ) ) {
					val = s;
				}
				if ( Array.isArray( val ) ) {
					return val;
				}
			}
		} catch ( e ) {
			/* ignore */
		}
		return [];
	};

	const getAppliedClassIdsOrdered = () => {
		const ee = window.elementorV2?.editorElements;
		if ( ! ee ) {
			return [];
		}
		const elementId = getEditingElementId();
		if ( ! elementId ) {
			return [];
		}
		const rawList = readClassesSettingValue( ee, elementId );
		const out = [];
		rawList.forEach( ( x ) => {
			if ( typeof x === 'string' ) {
				const n = normalizeKitClassId( x );
				if ( n ) {
					out.push( n );
				}
				return;
			}
			if ( x && typeof x === 'object' && typeof x.value === 'string' ) {
				const n = normalizeKitClassId( x.value );
				if ( n ) {
					out.push( n );
				}
			}
		} );
		return out;
	};

	const findOrderedClassChipsInRoots = ( roots, appliedLen ) => {
		const CHIP_SEL = [
			'.MuiAutocomplete-tag',
			'[class*="Autocomplete-tag"]',
			'.MuiInputBase-root .MuiChip-root',
			'.MuiInputBase-root [class*="MuiChip-root"]',
			'.MuiInputBase-root [class*="Chip-root"]',
			'[role="group"] .MuiChip-root',
			'[role="group"] [class*="Chip-root"]',
			'.MuiChip-root',
			'[class*="MuiChip-root"]',
			'[class*="Chip-root"]',
		].join( ', ' );

		const score = ( chips, len ) => {
			if ( ! chips.length ) {
				return -999;
			}
			if ( len > 0 && chips.length === len ) {
				return 100;
			}
			if ( len > 0 && Math.abs( chips.length - len ) === 1 ) {
				return 50 - Math.abs( chips.length - len );
			}
			return Math.min( chips.length, 20 );
		};

		const INNER_CHIP_SEL =
			'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]';
		let best = [];
		let bestScore = -1000;
		for ( const root of roots ) {
			root
				.querySelectorAll( '.MuiAutocomplete-root, [class*="MuiAutocomplete-root"]' )
				.forEach( ( ac ) => {
					const chips = [ ...ac.querySelectorAll( CHIP_SEL ) ].filter(
						( el ) => {
							if ( ! ac.contains( el ) ) {
								return false;
							}
							// Exclude MUI chip-group wrappers (MuiChipGroup-root /
							// MuiAutocomplete-tag) that hold the real chip as a
							// descendant — otherwise both the wrapper and the
							// inner chip get their own padlock.
							if (
								el.matches(
									'.MuiChipGroup-root, [class*="ChipGroup-root"]'
								)
							) {
								return false;
							}
							return ! el.querySelector( INNER_CHIP_SEL );
						}
					);
					const sc = score( chips, appliedLen );
					if ( sc > bestScore ) {
						bestScore = sc;
						best = chips;
					}
				} );
		}
		if ( appliedLen > 0 && bestScore < 50 ) {
			return [];
		}
		return best;
	};

	const syncPadlocksFromAppliedModel = () => {
		const applied = getAppliedClassIdsOrdered();
		if ( ! applied.length ) {
			return;
		}
		const roots = getScanRoots();
		const chips = findOrderedClassChipsInRoots( roots, applied.length );
		if ( ! chips.length ) {
			return;
		}
		const limit = Math.min( chips.length, applied.length );
		for ( let i = 0; i < limit; i++ ) {
			const cid = applied[ i ];
			if ( ! isKitClassIdShape( cid ) ) {
				continue;
			}
			const norm = normalizeKitClassId( cid );
			upsertPadlock( chips[ i ], norm );
		}
	};

	let lastEditBlockToastAt = 0;
	const showLockedEditBlockedToast = () => {
		const now = Date.now();
		if ( now - lastEditBlockToastAt < 2000 ) {
			return;
		}
		lastEditBlockToastAt = now;
		if ( window.elementor?.notifications?.showToast ) {
			window.elementor.notifications.showToast( {
				message:
					i18n.editBlockedToast ||
					'This global class is locked. Unlock it on the class chip to edit kit styles.',
			} );
		}
	};

	const installGlobalClassActionsGuard = () => {
		if ( window.__eclGlobalClassActionsGuard ) {
			return true;
		}
		const repo = window.elementorV2?.editorStylesRepository?.stylesRepository;
		const actions = repo?.getProviderByKey?.( GLOBAL_CLASSES_PROVIDER_KEY )?.actions;
		if (
			! actions ||
			typeof actions.updateProps !== 'function' ||
			typeof actions.updateCustomCss !== 'function' ||
			typeof actions.update !== 'function'
		) {
			return false;
		}
		if ( actions.updateProps.__eclWrapped ) {
			window.__eclGlobalClassActionsGuard = true;
			return true;
		}
		const origUpdateProps = actions.updateProps.bind( actions );
		const origUpdateCustomCss = actions.updateCustomCss.bind( actions );
		const origUpdate = actions.update.bind( actions );
		const safeAssign = ( obj, key, value ) => {
			try {
				obj[ key ] = value;
				return true;
			} catch ( e ) {
				try {
					Object.defineProperty( obj, key, {
						configurable: true,
						enumerable: true,
						writable: true,
						value,
					} );
					return true;
				} catch ( e2 ) {
					warn( '[ECL] could not wrap', key, e2 );
					return false;
				}
			}
		};
		const wrappedUpdateProps = ( payload ) => {
			if ( shouldBlockKitClassId( payload?.id ) ) {
				showLockedEditBlockedToast();
				return;
			}
			return origUpdateProps( payload );
		};
		const wrappedUpdateCustomCss = ( payload ) => {
			if ( shouldBlockKitClassId( payload?.id ) ) {
				showLockedEditBlockedToast();
				return;
			}
			return origUpdateCustomCss( payload );
		};
		const wrappedUpdate = ( payload ) => {
			const id = payload?.style?.id ?? payload?.id;
			if ( shouldBlockKitClassId( id ) ) {
				showLockedEditBlockedToast();
				return;
			}
			return origUpdate( payload );
		};
		wrappedUpdateProps.__eclWrapped = true;
		safeAssign( actions, 'updateProps', wrappedUpdateProps );
		safeAssign( actions, 'updateCustomCss', wrappedUpdateCustomCss );
		safeAssign( actions, 'update', wrappedUpdate );
		window.__eclGlobalClassActionsGuard = true;
		return true;
	};

	const installElementStyleUpdateGuard = () => {
		if ( window.__eclElementStyleUpdateGuard ) {
			return true;
		}
		const mod = window.elementorV2?.editorElements;
		if ( typeof mod?.updateElementStyle !== 'function' ) {
			return false;
		}
		if ( mod.updateElementStyle.__eclWrapped ) {
			window.__eclElementStyleUpdateGuard = true;
			return true;
		}
		const orig = mod.updateElementStyle.bind( mod );
		const wrapped = ( payload ) => {
			if ( shouldBlockKitClassId( payload?.styleId ) ) {
				showLockedEditBlockedToast();
				return;
			}
			return orig( payload );
		};
		wrapped.__eclWrapped = true;
		try {
			mod.updateElementStyle = wrapped;
		} catch ( e ) {
			try {
				Object.defineProperty( mod, 'updateElementStyle', {
					configurable: true,
					enumerable: true,
					writable: true,
					value: wrapped,
				} );
			} catch ( e2 ) {
				warn(
					'[ECL] updateElementStyle is read-only; skipping in-memory element style guard.',
					e2
				);
				window.__eclElementStyleUpdateGuard = true;
				return true;
			}
		}
		window.__eclElementStyleUpdateGuard = true;
		return true;
	};

	let eclGuardInstallAttempts = 0;
	const scheduleStyleGuards = () => {
		if ( installGlobalClassActionsGuard() && installElementStyleUpdateGuard() ) {
			return;
		}
		if ( eclGuardInstallAttempts++ > 50 ) {
			warn( 'ECL: could not attach in-memory style guards (elementorV2 modules missing?).' );
			return;
		}
		window.setTimeout( scheduleStyleGuards, 250 );
	};

	const NS = 'http://www.w3.org/2000/svg';

	const makeSvgIcon = ( pathD ) => {
		const svg = document.createElementNS( NS, 'svg' );
		svg.setAttribute( 'class', 'ecl-padlock__svg' );
		svg.setAttribute( 'width', '16' );
		svg.setAttribute( 'height', '16' );
		svg.setAttribute( 'viewBox', '0 0 640 640' );
		svg.setAttribute( 'aria-hidden', 'true' );
		const path = document.createElementNS( NS, 'path' );
		path.setAttribute( 'fill', 'currentColor' );
		path.setAttribute( 'd', pathD );
		svg.appendChild( path );
		return svg;
	};

	// Icons from Font Awesome Free v7.2.0 (https://fontawesome.com/license/free)
	const iconLocked = () =>
		makeSvgIcon(
			'M256 160L256 224L384 224L384 160C384 124.7 355.3 96 320 96C284.7 96 256 124.7 256 160zM192 224L192 160C192 89.3 249.3 32 320 32C390.7 32 448 89.3 448 160L448 224C483.3 224 512 252.7 512 288L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 288C128 252.7 156.7 224 192 224z'
		);

	const iconUnlocked = () =>
		makeSvgIcon(
			'M416 160C416 124.7 444.7 96 480 96C515.3 96 544 124.7 544 160L544 192C544 209.7 558.3 224 576 224C593.7 224 608 209.7 608 192L608 160C608 89.3 550.7 32 480 32C409.3 32 352 89.3 352 160L352 224L192 224C156.7 224 128 252.7 128 288L128 512C128 547.3 156.7 576 192 576L448 576C483.3 576 512 547.3 512 512L512 288C512 252.7 483.3 224 448 224L416 224L416 160z'
		);

	const fetchGlobalClasses = async () => {
		const root = ( cfg.restRoot || '' ).replace( /\/$/, '' );
		const headers = { Accept: 'application/json' };
		if ( cfg.restNonce ) {
			headers[ 'X-WP-Nonce' ] = cfg.restNonce;
		}
		const res = await fetch( root + '/elementor/v1/global-classes?context=preview', {
			credentials: 'same-origin',
			headers,
		} );
		if ( ! res.ok ) {
			throw new Error( 'HTTP ' + res.status );
		}
		const body = await res.json();
		const provider = window.elementorV2?.editorStylesRepository?.stylesRepository?.getProviderByKey?.(
			GLOBAL_CLASSES_PROVIDER_KEY
		);
		const rawData = body.data;
		const items = {};
		const labelToId = new Map();
		const order = [];

		const addLabel = ( id, label ) => {
			if ( ! id || ! label || labelToId.has( label.trim() ) ) {
				return;
			}
			labelToId.set( label.trim(), id );
		};

		const getCompleteProviderItem = ( id ) => {
			try {
				const item = provider?.actions?.get?.( id ) || null;
				return hasCompleteGlobalClassItem( item ) ? item : null;
			} catch ( e ) {
				return null;
			}
		};

		if ( Array.isArray( rawData ) ) {
			rawData.forEach( ( item ) => {
				const id = normalizeKitClassId( item?.id );
				if ( ! id ) {
					return;
				}
				addLabel( id, item?.label );
				const fullItem = getCompleteProviderItem( id );
				if ( fullItem ) {
					items[ id ] = deepClone( fullItem );
				}
				order.push( id );
			} );
		} else if ( rawData && typeof rawData === 'object' ) {
			Object.keys( rawData ).forEach( ( key ) => {
				const rawItem = rawData[ key ];
				const id = normalizeKitClassId( rawItem?.id || key );
				if ( ! id ) {
					return;
				}
				addLabel( id, rawItem?.label );
				if ( hasCompleteGlobalClassItem( rawItem ) ) {
					items[ id ] = deepClone( rawItem );
				} else {
					const fullItem = getCompleteProviderItem( id );
					if ( fullItem ) {
						items[ id ] = deepClone( fullItem );
					}
				}
				order.push( id );
			} );
		}

		if ( Array.isArray( body.meta?.order ) && body.meta.order.length ) {
			return {
				items,
				labelToId,
				order: body.meta.order
					.map( normalizeKitClassId )
					.filter( Boolean ),
			};
		}
		return { items, labelToId, order };

	};

	const buildLabelToId = ( items ) => {
		const map = new Map();
		Object.keys( items ).forEach( ( id ) => {
			const label = ( items[ id ] && items[ id ].label ) || '';
			if ( label && ! map.has( label.trim() ) ) {
				map.set( label.trim(), id );
			}
		} );
		return map;
	};

	const resolveTruncatedLabel = ( normalized ) => {
		const n = normalized.toLowerCase();
		if ( n.length < 3 ) {
			return null;
		}
		const matches = [];
		for ( const [ label, id ] of state.labelToId.entries() ) {
			if ( label.toLowerCase().startsWith( n ) ) {
				matches.push( { id, label } );
			}
		}
		if ( matches.length === 1 ) {
			return matches[ 0 ].id;
		}
		if ( matches.length > 1 ) {
			// Fallback for heavily truncated chips like "converted-...":
			// prefer a deterministic id instead of returning null forever.
			matches.sort( ( a, b ) => a.label.localeCompare( b.label ) || a.id.localeCompare( b.id ) );
			return matches[ 0 ].id;
		}
		return null;
	};

	const resolveClassId = ( raw ) => {
		const t = ( raw || '' ).trim();
		if ( ! t || /^local$/i.test( t ) ) {
			return null;
		}
		const idMatch = t.match( /^g-[a-f0-9]{7}$/i );
		if ( idMatch ) {
			return t.trim().toLowerCase();
		}
		const direct = state.labelToId.get( t );
		if ( direct ) {
			return direct;
		}
		const stripped = t.replace( /\u2026|…/g, '' ).replace( /\.{2,}$/g, '' ).trim();
		if ( stripped && stripped !== t ) {
			const byTrunc = resolveTruncatedLabel( stripped );
			if ( byTrunc ) {
				return byTrunc;
			}
		}
		return resolveTruncatedLabel( stripped || t );
	};

	const rowLabelText = ( row ) => {
		const el = row.querySelector( '.MuiTypography-root, .MuiListItemText-primary, [class*="Typography"]' );
		if ( el && el.textContent ) {
			return el.textContent.trim();
		}
		const text = row.textContent || '';
		return text.trim().split( '\n' )[ 0 ].trim();
	};

	const chipLabelText = ( chip ) => {
		const lab =
			chip.querySelector( '.MuiChip-label' ) ||
			chip.querySelector( '[class*="Chip-label"]' );
		if ( lab && lab.textContent ) {
			return lab.textContent.trim();
		}
		const aria = chip.getAttribute( 'aria-label' ) || '';
		if ( aria ) {
			const m = aria.match( /Edit\s+(.+)/i );
			if ( m && m[ 1 ] ) {
				return m[ 1 ].trim();
			}
			return aria.trim();
		}
		return ( chip.textContent || '' ).trim();
	};

	const isClassChipElement = ( el ) =>
		!! el?.matches?.(
			'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"], .MuiAutocomplete-tag, [class*="Autocomplete-tag"]'
		);

	const getAnchorId = ( el ) => {
		const d = el.dataset || {};
		if ( d.eclAnchorId ) {
			return d.eclAnchorId;
		}
		state.anchorSeq += 1;
		const id = 'ecl-anchor-' + state.anchorSeq;
		el.setAttribute( 'data-ecl-anchor-id', id );
		return id;
	};

	const padlockAria = ( classId ) => {
		if ( isLocked( classId ) ) {
			return ( i18n.locked || 'Class is locked' ) + ' (' + classId + ')';
		}
		return ( i18n.unlockedAriaHint || 'Class is unlocked — switching to another class or element will re-lock it.' ) + ' (' + classId + ')';
	};

	const refreshPadlockButton = ( btn, classId ) => {
		const locked = isLocked( classId );
		const desiredState = locked ? 'locked' : 'unlocked';
		// Idempotent: bail out when the DOM already matches the current
		// state. Writing attributes unconditionally creates a feedback loop
		// with our own panel MutationObserver (childList/subtree) because
		// swapping the SVG child fires mutations that schedule a rescan,
		// which calls refreshPadlockButton again — at ~230 writes/sec.
		if ( btn.dataset.eclState === desiredState ) {
			return;
		}
		btn.dataset.eclState = desiredState;
		while ( btn.firstChild ) {
			btn.removeChild( btn.firstChild );
		}
		btn.appendChild( locked ? iconLocked() : iconUnlocked() );
		btn.classList.toggle( 'is-locked', locked );
		btn.classList.toggle( 'is-unlocked', ! locked );
		btn.setAttribute( 'aria-pressed', locked ? 'true' : 'false' );
		btn.setAttribute( 'aria-label', padlockAria( classId ) );
		// Native hover tooltip — only on the unlocked state where the
		// auto-relock behaviour may surprise users.
		if ( locked ) {
			btn.removeAttribute( 'title' );
		} else {
			btn.setAttribute(
				'title',
				i18n.unlockedAriaHint ||
					'Class is unlocked — switching to another class or element will re-lock it.'
			);
		}
	};

	let tooltipEl = null;
	const showTooltip = ( anchor, message ) => {
		if ( tooltipEl ) {
			tooltipEl.remove();
		}
		tooltipEl = document.createElement( 'div' );
		tooltipEl.className = 'ecl-tooltip';
		tooltipEl.setAttribute( 'role', 'status' );
		tooltipEl.textContent = message;
		document.body.appendChild( tooltipEl );
		const rect = anchor.getBoundingClientRect();
		tooltipEl.style.left = rect.left + window.scrollX + 'px';
		tooltipEl.style.top = rect.bottom + window.scrollY + 6 + 'px';
		window.setTimeout( () => {
			if ( tooltipEl ) {
				tooltipEl.remove();
				tooltipEl = null;
			}
		}, 3200 );
	};

	/**
	 * Detect list items rendered by the Elementor V4 Class Manager. These have
	 * the `class-item-more-actions` / `class-item-sortable-trigger` internals
	 * and need different padlock placement (next to the overflow menu button
	 * instead of covering it) plus extra interaction guards.
	 */
	const isClassManagerItem = ( row ) => {
		if ( ! row || typeof row.querySelector !== 'function' ) {
			return false;
		}
		return !! (
			row.querySelector( '.class-item-more-actions' ) ||
			row.querySelector( '.class-item-sortable-trigger' )
		);
	};

	const upsertPadlock = ( row, classId ) => {
		if ( ! classId ) {
			return;
		}
		const isChip = isClassChipElement( row );
		const isCmItem = ! isChip && isClassManagerItem( row );
		const anchorId = isChip ? getAnchorId( row ) : null;
		let existing = null;
		if ( isChip && row.parentElement ) {
			existing = row.parentElement.querySelector(
				'.ecl-padlock[data-ecl-anchor-id="' + anchorId + '"]'
			);
		} else {
			existing = row.querySelector( '.ecl-padlock' );
		}
		if ( existing ) {
			const prev = existing.getAttribute( 'data-ecl-class-id' );
			if ( prev === classId ) {
				refreshPadlockButton( existing, classId );
				refreshClassManagerItemLockState( row );
				return;
			}
			existing.remove();
		}
		if ( isChip ) {
			row.querySelectorAll( '.ecl-padlock' ).forEach( ( n ) => n.remove() );
		}
		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.className = 'ecl-padlock' + ( isLocked( classId ) ? ' is-locked' : ' is-unlocked' );
		btn.setAttribute( 'data-ecl-class-id', classId );
		if ( anchorId ) {
			btn.setAttribute( 'data-ecl-anchor-id', anchorId );
		}
		refreshPadlockButton( btn, classId );
		btn.addEventListener( 'click', ( ev ) => {
			ev.preventDefault();
			ev.stopPropagation();
			const locked = isLocked( classId );
			if ( locked ) {
				setLocked( classId, false );
				delete state.lockedSnapshots[ classId ];
				refreshPadlockButton( btn, classId );
				refreshClassManagerItemLockState( row );
				refreshControlsLockState();
				showTooltip( btn, i18n.unlocked || 'Unlocked' );
			} else {
				setLocked( classId, true );
				refreshPadlockButton( btn, classId );
				refreshClassManagerItemLockState( row );
				refreshControlsLockState();
				void refreshLabelMap().then( () => {
					captureSnapshotForClass( classId );
				} );
			}
		} );
		if ( isChip && row.parentElement ) {
			btn.classList.add( 'ecl-padlock--inline' );
			row.insertAdjacentElement( 'afterend', btn );
			return;
		}
		if ( isCmItem ) {
			btn.classList.add( 'ecl-padlock--cm' );
			const moreActions = row.querySelector( '.class-item-more-actions' );
			if ( moreActions && moreActions.parentElement ) {
				moreActions.insertAdjacentElement( 'afterend', btn );
			} else {
				row.appendChild( btn );
			}
			refreshClassManagerItemLockState( row );
			return;
		}
		const target =
			row.querySelector( '.MuiListItemSecondaryAction-root' ) ||
			row.querySelector( '[class*="ListItemSecondaryAction"]' ) ||
			row;
		if ( target === row ) {
			row.style.position = 'relative';
			btn.classList.add( 'ecl-padlock--floating' );
		}
		target.appendChild( btn );
	};

	const refreshClassManagerItemLockState = ( el ) => {
		if ( ! el || typeof el.closest !== 'function' ) {
			return;
		}
		const li = el.tagName === 'LI' ? el : el.closest( 'li' );
		if ( ! li || ! isClassManagerItem( li ) ) {
			return;
		}
		const padlock = li.querySelector( '.ecl-padlock' );
		const classId = padlock && padlock.getAttribute( 'data-ecl-class-id' );
		const locked = !! ( classId && isLocked( classId ) );
		li.classList.toggle( 'ecl-cm-item', true );
		li.classList.toggle( 'ecl-cm-locked', locked );
		if ( locked ) {
			const editable = li.querySelector( '[contenteditable="true"]' );
			if ( editable ) {
				try {
					editable.setAttribute( 'contenteditable', 'false' );
				} catch ( e ) {
					/* ignore */
				}
				try {
					editable.blur();
				} catch ( e ) {
					/* ignore */
				}
				showLockedEditBlockedToast();
			}
		}
	};

	const scanListRows = ( root ) => {
		const rows = root.querySelectorAll(
			'.MuiListItemButton-root, [class*="ListItemButton"], li.MuiListItem-root'
		);
		rows.forEach( ( row ) => {
			const label = rowLabelText( row );
			if ( ! label ) {
				return;
			}
			const classId = resolveClassId( label );
			if ( ! classId ) {
				return;
			}
			upsertPadlock( row, classId );
		} );
	};

	const pruneOrphanChipPadlocks = ( root ) => {
		// Drop any inline chip padlock whose neighboring element is no longer
		// a real chip (e.g. stale padlocks placed next to chip-group wrappers
		// before we tightened the scan). Without this, two padlocks can linger
		// for the same class and clicking one looks like nothing happened.
		root.querySelectorAll( '.ecl-padlock--inline' ).forEach( ( pad ) => {
			const prev = pad.previousElementSibling;
			if ( ! prev || ! isClassChipElement( prev ) ) {
				pad.remove();
				return;
			}
			if (
				prev.matches(
					'.MuiChipGroup-root, [class*="ChipGroup-root"]'
				) ||
				prev.querySelector(
					'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]'
				)
			) {
				pad.remove();
			}
		} );
	};

	const scanChips = ( root ) => {
		pruneOrphanChipPadlocks( root );
		const ac = [ '.MuiAutocomplete-root', '[class*="MuiAutocomplete-root"]' ];
		const selector = ac
			.flatMap( ( p ) => [
				p + ' .MuiChip-root',
				p + ' [class*="MuiChip-root"]',
				p + ' [class*="Chip-root"]',
				p + ' .MuiAutocomplete-tag',
				p + ' [class*="Autocomplete-tag"]',
			] )
			.join( ', ' );
		const seen = new Set();
		root.querySelectorAll( selector ).forEach( ( chip ) => {
			if ( seen.has( chip ) ) {
				return;
			}
			seen.add( chip );
			// Skip chip-group wrappers (e.g. MuiChipGroup-root MuiAutocomplete-tag)
			// that contain actual chips inside. Otherwise we end up attaching a
			// second padlock as a sibling of the group in addition to the one
			// next to the real chip, which makes it look like the padlock click
			// "did nothing" because only one of the two visible padlocks flips.
			if (
				chip.matches( '.MuiChipGroup-root, [class*="ChipGroup-root"]' ) ||
				chip.querySelector(
					'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]'
				)
			) {
				return;
			}
			const label = chipLabelText( chip );
			const classId = resolveClassId( label );
			if ( ! classId ) {
				return;
			}
			upsertPadlock( chip, classId );
		} );
	};

	const scanClassesFieldFallback = ( root ) => {
		const blocks = root.querySelectorAll(
			'[class*="Control"], [class*="Panel"], [class*="panel"], .MuiBox-root, .MuiFormControl-root'
		);
		blocks.forEach( ( block ) => {
			const txt = ( block.textContent || '' ).toLowerCase();
			if ( txt.indexOf( 'classes' ) === -1 ) {
				return;
			}
			const tokens = block.querySelectorAll(
				'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"], [role="button"]'
			);
			tokens.forEach( ( token ) => {
				if ( token.querySelector( '.ecl-padlock' ) ) {
					return;
				}
				const label = chipLabelText( token );
				if ( ! label || /^local$/i.test( label ) ) {
					return;
				}
				const classId = resolveClassId( label );
				if ( classId ) {
					upsertPadlock( token, classId );
				}
			} );
		} );
	};

	/**
	 * Returns the aria-label of the currently "pressed" class chip in the
	 * Style → Classes field (the one whose styles are being edited). Falls
	 * back to null when nothing is active. Used to detect context changes so
	 * we can auto re-lock previously unlocked global classes when the user
	 * moves focus to another chip (or back to `local`).
	 */
	const getActiveChipLabel = () => {
		const roots = getScanRoots();
		for ( const root of roots ) {
			const candidates = root.querySelectorAll(
				'.MuiAutocomplete-root [aria-pressed="true"], [class*="MuiAutocomplete-root"] [aria-pressed="true"]'
			);
			for ( const pressed of candidates ) {
				// Skip our own padlock buttons — they also use aria-pressed
				// to indicate locked state and must not be mistaken for the
				// active class chip.
				if (
					pressed.classList &&
					pressed.classList.contains( 'ecl-padlock' )
				) {
					continue;
				}
				const txt =
					( pressed.getAttribute( 'aria-label' ) || '' ).trim() ||
					( pressed.textContent || '' ).trim();
				if ( txt ) {
					return txt;
				}
			}
		}
		return null;
	};

	/**
	 * Clears the session unlock Set when the editing context changes:
	 *   - The user selects a different element in the preview.
	 *   - The user clicks a different class chip (including `local`) in the
	 *     Style → Classes field.
	 *
	 * Returns true when state was actually cleared, so callers know to
	 * refresh padlock icons.
	 *
	 * Robustness rules:
	 *   - We only relock on *real* transitions (both the previous and current
	 *     values were observed at least once). The first time this runs we
	 *     simply record the context without touching the unlock Set.
	 *   - Transient `null` readings (element id or chip label briefly missing
	 *     during a React re-render, which happens every time the user clicks
	 *     our own padlock because Elementor re-renders the chip row) are
	 *     ignored. We only relock when the context transitions to a
	 *     *different, non-null* value, and we never overwrite a known-good
	 *     cached reading with a transient null.
	 */
	const syncSessionUnlocksToContext = () => {
		// If the user is actively renaming (or has just signalled intent to
		// rename) a class in the Class Manager, freeze the context entirely:
		// do not relock, do not update cached readings. A relock mid-rename
		// would cause `refreshClassManagerItemLockState` to revert the
		// rename input's `contenteditable` to false, killing the edit before
		// the user can type a single character.
		if (
			isAnyRenameActive() ||
			Date.now() < state.renameGraceUntil
		) {
			return false;
		}

		const currentElementId = getEditingElementId();
		const currentChipLabel = getActiveChipLabel();
		const firstSync = ! state.contextInitialized;

		const elementChanged =
			currentElementId !== null &&
			state.lastEditingElementId !== null &&
			currentElementId !== state.lastEditingElementId;
		const chipChanged =
			currentChipLabel !== null &&
			state.lastActiveChipLabel !== null &&
			currentChipLabel !== state.lastActiveChipLabel;

		let changed = false;
		if ( ! firstSync && ( elementChanged || chipChanged ) ) {
			if ( relockAll() ) {
				changed = true;
			}
		}

		if ( currentElementId !== null ) {
			state.lastEditingElementId = currentElementId;
		}
		if ( currentChipLabel !== null ) {
			state.lastActiveChipLabel = currentChipLabel;
		}
		state.contextInitialized = true;
		return changed;
	};

	const refreshAllPadlockIcons = () => {
		document.querySelectorAll( '.ecl-padlock' ).forEach( ( btn ) => {
			const cid = btn.getAttribute( 'data-ecl-class-id' );
			if ( cid ) {
				refreshPadlockButton( btn, cid );
			}
		} );
	};

	/**
	 * Dim and block pointer events on the style accordion controls when the
	 * currently-active class chip is a locked global class.
	 *
	 * We find the controls list by looking for the MuiList-root sibling of
	 * the Classes autocomplete row inside the active style tabpanel. This is
	 * version-sensitive (Elementor's MUI class names can change); the toggle
	 * is best-effort and the network interceptor + event guards remain the
	 * authoritative protection layers.
	 */
	const refreshControlsLockState = () => {
		// Determine whether the active chip is a locked global class.
		const activeLabel = getActiveChipLabel();
		const activeId = activeLabel ? resolveClassId( activeLabel ) : null;
		const shouldLock = !! ( activeId && isLocked( activeId ) );

		// Find the controls list inside the style tabpanel — it is the
		// MuiList-root sibling of the Classes (MuiStack-root) container.
		// We search all style-tab tabpanels and pick the first one that has
		// both a MuiAutocomplete (Classes row) and a MuiList (controls).
		const tabpanels = document.querySelectorAll( '[role="tabpanel"]' );
		for ( const tp of tabpanels ) {
			const controlsList = tp.querySelector( '.MuiList-root, [class*="MuiList-root"]' );
			if ( ! controlsList ) {
				continue;
			}
			// Only operate on the panel that also contains our chips.
			if ( ! tp.querySelector( '.ecl-padlock' ) ) {
				continue;
			}
			controlsList.classList.toggle( 'ecl-controls-locked', shouldLock );
			// aria-hidden keeps screen readers from announcing the dimmed
			// controls as interactive; remove it when unlocked.
			if ( shouldLock ) {
				controlsList.setAttribute( 'aria-hidden', 'true' );
			} else {
				controlsList.removeAttribute( 'aria-hidden' );
			}
			break;
		}
	};

	const scanDom = () => {
		const roots = getScanRoots();
		if ( ! roots.length ) {
			if ( ! state.panelWarned && cfg.debug ) {
				state.panelWarned = true;
				warn( i18n.panelNotFound || 'Panel inner not found' );
			}
			return false;
		}
		const contextChanged = syncSessionUnlocksToContext();
		roots.forEach( ( root ) => {
			scanListRows( root );
			scanChips( root );
			scanClassesFieldFallback( root );
		} );
		syncPadlocksFromAppliedModel();
		if ( contextChanged ) {
			refreshAllPadlockIcons();
		}
		refreshControlsLockState();
		return true;
	};

	const disconnectObservers = () => {
		if ( state.panelObservers.length ) {
			state.panelObservers.forEach( ( o ) => o.disconnect() );
			state.panelObservers = [];
		}
		if ( state.bodyObserver ) {
			state.bodyObserver.disconnect();
			state.bodyObserver = null;
		}
	};

	const scheduleScanDebounced = () => {
		window.clearTimeout( state.scanDebounceT );
		state.scanDebounceT = window.setTimeout( () => {
			scanDom();
		}, 60 );
	};

	const installStyleChangeRescan = () => {
		if ( window.__eclStyleChangeRescan ) {
			return;
		}
		window.__eclStyleChangeRescan = true;
		window.addEventListener( 'elementor/editor-v2/editor-elements/style', scheduleScanDebounced );
	};

	const attachPanelObserver = () => {
		disconnectObservers();
		const roots = getScanRoots();
		if ( ! roots.length ) {
			state.bodyObserver = new MutationObserver( () => {
				if ( getScanRoots().length ) {
					attachPanelObserver();
				}
			} );
			state.bodyObserver.observe( document.body, { childList: true, subtree: true } );
			return;
		}
	roots.forEach( ( root ) => {
		const obs = new MutationObserver( ( mutations ) => {
			// Filter out mutations that originated inside our own injected
			// UI (padlocks, anchors, diag badges). Any childList/subtree
			// change whose target or added nodes are ours is an artefact of
			// our own DOM writes, not a signal from Elementor, and must not
			// schedule another rescan — otherwise we feedback-loop with
			// refreshPadlockButton and the observer fires hundreds of times
			// a second.
			const isOwnNode = ( node ) =>
				node &&
				node.nodeType === 1 &&
				( ( node.classList?.contains( 'ecl-padlock' ) ) ||
					node.closest?.( '.ecl-padlock' ) ||
					node.hasAttribute?.( 'data-ecl-anchor-id' ) ||
					node.hasAttribute?.( 'data-ecl-diag-badge' ) );
			let relevant = false;
			for ( const m of mutations ) {
				if ( isOwnNode( m.target ) ) {
					continue;
				}
				let ownOnly = true;
				for ( const node of m.addedNodes ) {
					if ( ! isOwnNode( node ) ) {
						ownOnly = false;
						break;
					}
				}
				if ( ownOnly && m.addedNodes.length ) {
					continue;
				}
				relevant = true;
				break;
			}
			if ( ! relevant ) {
				return;
			}
			scheduleScanDebounced();
		} );
		obs.observe( root, { childList: true, subtree: true } );
		state.panelObservers.push( obs );
	} );
		installStyleChangeRescan();
		scanDom();
	};

	const refreshLabelMap = async () => {
		try {
			const { items, labelToId } = await fetchGlobalClasses();
			state.items = items;
			state.labelToId = labelToId.size ? labelToId : buildLabelToId( items );
			seedSnapshotsForLockedClasses();
			window.clearTimeout( state.refreshLabelMapRetryT );
			if (
				state.labelToId.size > 0 &&
				Object.keys( items ).length < state.labelToId.size &&
				state.refreshLabelMapRetryCount < 12
			) {
				state.refreshLabelMapRetryCount += 1;
				state.refreshLabelMapRetryT = window.setTimeout( () => {
					void refreshLabelMap();
				}, 250 );
				warn(
					'Global class snapshots deferred until the Elementor provider is ready.',
					state.refreshLabelMapRetryCount,
					'of 12'
				);
				return;
			}
			state.refreshLabelMapRetryCount = 0;
		} catch ( e ) {
			warn( 'Could not prefetch global classes', e );
			window.clearTimeout( state.refreshLabelMapRetryT );
			state.refreshLabelMapRetryCount = 0;
			state.items = {};
			state.labelToId = new Map();
			state.lockedSnapshots = {};
		}
	};

	const maybeInjectPromote = () => {
		const root = getPromoteMountRoot();
		if ( ! root || root.querySelector( '.ecl-promote-bar' ) ) {
			return;
		}
		const bar = document.createElement( 'div' );
		bar.className = 'ecl-promote-bar';
		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.className = 'ecl-promote';
		btn.textContent = i18n.promote || 'Promote to Global';
		btn.addEventListener( 'click', () => {
			warn( 'Promote merge is not fully automated in v1.0.0.' );
			if ( window.elementor?.notifications?.showToast ) {
				window.elementor.notifications.showToast( {
					message:
						i18n.promoteDisabled ||
						'Promote will merge local element styles in a future update. For now, unlock the class and edit globally, or duplicate styles manually.',
				} );
			}
		} );
		bar.appendChild( btn );
		root.appendChild( bar );
	};

	const maybeShowUiHint = () => {
		if ( ! i18n.hintToast || sessionStorage.getItem( 'ecl_ui_hint' ) === '1' ) {
			return;
		}
		if ( ! window.elementor?.notifications?.showToast ) {
			return;
		}
		window.setTimeout( () => {
			if ( sessionStorage.getItem( 'ecl_ui_hint' ) === '1' ) {
				return;
			}
			window.elementor.notifications.showToast( { message: i18n.hintToast } );
			sessionStorage.setItem( 'ecl_ui_hint', '1' );
		}, 2200 );
	};

	const bindElementorEvents = () => {
		if ( typeof window.elementor?.on !== 'function' ) {
			return;
		}
		window.elementor.on(
			'document:loaded',
			function () {
				void refreshLabelMap().then( () => {
					seedSnapshotsForLockedClasses();
					scanDom();
				} );
				window.setTimeout( scheduleStyleGuards, 100 );
			}
		);
		window.elementor.on( 'panel:init', function () {
			scanDom();
		} );
	};

	/**
	 * Guard Class Manager actions for locked class items. The manager exposes
	 * a "More actions" menu (Rename / Sync to Global Fonts / Delete) plus a
	 * drag handle — none of which route through the style repository actions
	 * we already wrap — so we must block them at the DOM event layer.
	 *
	 * Menus portal outside the source `<li>`, so we remember the most recently
	 * clicked source and reject menu item clicks when that source is locked.
	 */
	const installClassManagerGuards = () => {
		if ( window.__eclClassManagerGuards ) {
			return;
		}
		window.__eclClassManagerGuards = true;

		/** @type {HTMLElement|null} Last Class Manager `<li>` whose more-actions menu was opened. */
		let lastMenuSourceItem = null;
		/** @type {string|null} Last class id whose Style → Classes chip overflow menu was opened. */
		let lastChipMenuSourceClassId = null;

		const findOwningCmItem = ( el ) => {
			if ( ! el || ! el.closest ) {
				return null;
			}
			const li = el.closest( 'li' );
			if ( li && isClassManagerItem( li ) ) {
				return li;
			}
			return null;
		};

		/**
		 * Resolve the class id for any event target inside a Style →
		 * Classes chip. Prefers the authoritative `data-ecl-class-id`
		 * stored on the adjacent padlock (keyed by anchor id), and falls
		 * back to label resolution so truncated chips still work.
		 */
		const resolveChipClassIdFromTarget = ( el ) => {
			if ( ! el || ! el.closest ) {
				return null;
			}
			const chipRoot = el.closest(
				'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]'
			);
			if ( ! chipRoot ) {
				return null;
			}
			if (
				chipRoot.matches &&
				chipRoot.matches(
					'.MuiChipGroup-root, [class*="ChipGroup-root"]'
				)
			) {
				return null;
			}
			const anchorId =
				( chipRoot.dataset && chipRoot.dataset.eclAnchorId ) || null;
			if ( anchorId && chipRoot.parentElement ) {
				const pad = chipRoot.parentElement.querySelector(
					'.ecl-padlock[data-ecl-anchor-id="' + anchorId + '"]'
				);
				if ( pad ) {
					const id = pad.getAttribute( 'data-ecl-class-id' );
					if ( id ) {
						return id;
					}
				}
			}
			try {
				const label = chipLabelText( chipRoot );
				return resolveClassId( label );
			} catch ( e ) {
				return null;
			}
		};

		const blockEvent = ( ev ) => {
			ev.preventDefault();
			ev.stopImmediatePropagation();
			ev.stopPropagation();
		};

		const menuItemLabel = ( menuitem ) =>
			( menuitem.getAttribute( 'aria-label' ) || menuitem.textContent || '' )
				.trim()
				.toLowerCase();

		const trap = ( ev ) => {
			const target = ev.target;
			if ( ! target || target.nodeType !== 1 ) {
				return;
			}
			if ( target.closest && target.closest( '.ecl-padlock' ) ) {
				return;
			}

			const li = findOwningCmItem( target );

			// Track chip overflow menu source. Any pointerdown / mousedown
			// / click inside a Style → Classes chip is a candidate — the
			// menu itself portals outside the chip, so we must remember
			// which class it belongs to before the menu opens. We set the
			// source even when resolution returns null (e.g. the `local`
			// chip) so a prior global-chip click does not bleed through
			// to a subsequent menuitem click on a different chip. We also
			// clear any CM source in the same breath, so a stale CM
			// locked state cannot bleed into chip menu handling.
			if (
				ev.type === 'pointerdown' ||
				ev.type === 'mousedown' ||
				ev.type === 'click'
			) {
				const chipRoot =
					target.closest &&
					target.closest(
						'.MuiChip-root, [class*="MuiChip-root"], [class*="Chip-root"]'
					);
				const isRealChip =
					chipRoot &&
					( ! chipRoot.matches ||
						! chipRoot.matches(
							'.MuiChipGroup-root, [class*="ChipGroup-root"]'
						) );
				if ( isRealChip ) {
					lastChipMenuSourceClassId =
						resolveChipClassIdFromTarget( target );
					lastMenuSourceItem = null;
				}
			}

			if ( target.closest && target.closest( '.class-item-more-actions' ) ) {
				lastMenuSourceItem = li;
				lastChipMenuSourceClassId = null;
				if ( li && li.classList.contains( 'ecl-cm-locked' ) ) {
					blockEvent( ev );
					showLockedEditBlockedToast();
					return;
				}
			}

			if ( li && li.classList.contains( 'ecl-cm-locked' ) ) {
				if ( target.closest( '.class-item-sortable-trigger' ) ) {
					blockEvent( ev );
					return;
				}
				if ( ev.type === 'dblclick' ) {
					blockEvent( ev );
					showLockedEditBlockedToast();
					return;
				}
			}

			// User is signalling intent to rename an unlocked class: a
			// dblclick anywhere inside an unlocked Class Manager row. Open
			// a short grace window so that any context sync that fires
			// before Elementor flips the label to contenteditable cannot
			// relock the class and cancel the rename.
			if (
				li &&
				! li.classList.contains( 'ecl-cm-locked' ) &&
				ev.type === 'dblclick'
			) {
				markRenameIntent();
			}

			// Menu item handling. Runs for both the Class Manager overflow
			// menu and the chip overflow menu (same portal-style menu).
			const menuitem =
				target.closest && target.closest( '[role="menuitem"]' );
			if ( menuitem ) {
				const label = menuItemLabel( menuitem );
				const isRename = label === 'rename';

				// "Rename" is intentionally treated as a low-impact action:
				// it changes the class label only, not its style values.
				// Clicking "Rename" from either menu (for a locked class)
				// behaves as an implicit unlock for that one class, and
				// opens a rename grace window so the subsequent
				// contenteditable flip survives any context sync.
				if ( isRename ) {
					let classIdToUnlock = null;
					if ( lastChipMenuSourceClassId ) {
						classIdToUnlock = lastChipMenuSourceClassId;
					} else if (
						lastMenuSourceItem &&
						lastMenuSourceItem.classList.contains( 'ecl-cm-locked' )
					) {
						const pad =
							lastMenuSourceItem.querySelector( '.ecl-padlock' );
						if ( pad ) {
							classIdToUnlock =
								pad.getAttribute( 'data-ecl-class-id' );
						}
					}
					if (
						classIdToUnlock &&
						isLocked( classIdToUnlock )
					) {
						setLocked( classIdToUnlock, false );
						delete state.lockedSnapshots[ classIdToUnlock ];
						refreshAllPadlockIcons();
						if ( lastMenuSourceItem ) {
							refreshClassManagerItemLockState(
								lastMenuSourceItem
							);
						}
					}
					markRenameIntent();
					return;
				}

				// Any non-rename menuitem click against a locked CM source
				// (Delete / Sync to Global Fonts) stays blocked as before.
				if (
					lastMenuSourceItem &&
					lastMenuSourceItem.classList &&
					lastMenuSourceItem.classList.contains( 'ecl-cm-locked' )
				) {
					blockEvent( ev );
					showLockedEditBlockedToast();
				}
			}
		};

		const clearSourceAfterMenuClick = ( ev ) => {
			const target = ev.target;
			if ( target && target.closest && target.closest( '[role="menuitem"]' ) ) {
				window.setTimeout( () => {
					lastMenuSourceItem = null;
					lastChipMenuSourceClassId = null;
				}, 0 );
			}
		};

		[ 'pointerdown', 'mousedown', 'click', 'dblclick' ].forEach( ( evt ) => {
			document.addEventListener( evt, trap, true );
		} );
		document.addEventListener( 'click', clearSourceAfterMenuClick, false );

		const refreshAll = () => {
			const roots = getScanRoots();
			const seen = new Set();
			roots.forEach( ( root ) => {
				root.querySelectorAll( 'li' ).forEach( ( li ) => {
					if ( seen.has( li ) ) {
						return;
					}
					seen.add( li );
					if ( isClassManagerItem( li ) ) {
						refreshClassManagerItemLockState( li );
					}
				} );
			} );
		};

		try {
			const obs = new MutationObserver( () => {
				refreshAll();
			} );
			obs.observe( document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: [ 'contenteditable' ],
			} );
		} catch ( e ) {
			/* ignore */
		}

		refreshAll();
	};

	const installStyleEditBlockerUi = () => {
		if ( window.__eclStyleEditBlockerUi ) {
			return;
		}
		window.__eclStyleEditBlockerUi = true;

		const hasLockedAppliedClass = () => {
			try {
				const applied = getAppliedClassIdsOrdered();
				for ( const id of applied ) {
					if ( isLocked( id ) ) {
						return true;
					}
				}
			} catch ( e ) {
				/* ignore */
			}
			return false;
		};

		const isInStylePanel = ( t ) => {
			if ( ! t || ! t.closest ) {
				return false;
			}
			return !! (
				t.closest( '#elementor-panel-inner' ) ||
				t.closest( '#elementor-panel' ) ||
				t.closest( '#elementor-editor-wrapper-v2' )
			);
		};

		const handler = ( ev ) => {
			const t = ev.target;
			if ( ! t || t.nodeType !== 1 ) {
				return;
			}
			if ( t.closest && t.closest( '.ecl-padlock' ) ) {
				return;
			}
			// Class Manager rename inputs live inside the panel but are a
			// separate flow with its own guards — typing into a rename
			// field must not surface the "locked class" toast.
			if (
				t.closest &&
				( t.closest( '.class-item-sortable-trigger' ) ||
					t.closest( '[contenteditable="true"]' ) )
			) {
				const li = t.closest( 'li' );
				if ( li && isClassManagerItem( li ) ) {
					return;
				}
			}
			if ( ! isInStylePanel( t ) ) {
				return;
			}
			if ( ! hasLockedAppliedClass() ) {
				return;
			}
			showLockedEditBlockedToast();
		};

		document.addEventListener( 'input', handler, true );
		document.addEventListener( 'change', handler, true );
		document.addEventListener( 'pointerdown', handler, true );
		document.addEventListener( 'keydown', handler, true );
	};

	const init = async () => {
		if ( ! window.elementor ) {
			return;
		}
		installFetchInterceptor();
		installXhrInterceptor();
		scheduleStyleGuards();
		installStyleEditBlockerUi();
		installClassManagerGuards();
		if ( cfg.elementorVersion ) {
			warn( 'Elementor', cfg.elementorVersion, '— class list DOM is version-sensitive.' );
		}
		await refreshLabelMap();
		if ( cfg.debug ) {
			warn(
				'[ECL] ready',
				'atomicActive=',
				!! cfg.atomicActive,
				'globalClassLabels=',
				state.labelToId.size
			);
		}
		if ( ! cfg.atomicActive && window.elementor?.notifications?.showToast ) {
			window.setTimeout( () => {
				window.elementor.notifications.showToast( {
					message:
						i18n.atomicOffToast ||
						'Class Lock: enable “Atomic elements” under Elementor → Settings → Features to activate the global-classes save guard. Padlocks still appear on kit classes when the list loads.',
				} );
			}, 1200 );
		}
		attachPanelObserver();
		bindElementorEvents();
		window.setInterval( () => maybeInjectPromote(), 8000 );
		if ( ! state.scanIntervalT ) {
			state.scanIntervalT = window.setInterval( () => {
				scanDom();
			}, 2000 );
		}
		maybeShowUiHint();
	};

	const startEcl = () => {
		if ( window.__eclEditorStarted ) {
			return;
		}
		window.__eclEditorStarted = true;
		void init();
	};

	const boot = () => {
		window.addEventListener(
			'elementor/init',
			() => {
				startEcl();
			},
			{ once: true }
		);
		const $w = window.elementorCommon?.elements?.$window;
		if ( $w && typeof $w.on === 'function' ) {
			$w.on( 'elementor:init', startEcl );
		}
		if ( window.elementor ) {
			startEcl();
		}
		window.setTimeout( () => {
			if ( ! window.__eclEditorStarted && window.elementor ) {
				startEcl();
			}
		}, 1500 );
		window.setTimeout( () => {
			if ( ! window.__eclEditorStarted && window.elementor ) {
				startEcl();
			}
		}, 5000 );
	};

	if ( document.readyState === 'complete' || document.readyState === 'interactive' ) {
		boot();
	} else {
		document.addEventListener( 'DOMContentLoaded', boot );
	}
} )();
