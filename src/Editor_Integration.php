<?php
/**
 * Editor scripts, styles, and configuration.
 *
 * @package ElementorClassLock
 */

namespace ElementorClassLock;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Hooks into the Elementor editor when the atomic experiment is active.
 */
final class Editor_Integration {

	private static ?self $instance = null;

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register(): void {
		add_filter( 'elementor/editor/localize_settings', [ $this, 'add_localize_settings' ] );
		add_action( 'elementor/editor/before_enqueue_scripts', [ $this, 'register_rest_header_bridge' ], 1 );
		add_action( 'elementor/editor/after_enqueue_scripts', [ $this, 'enqueue_editor_assets' ] );
	}

	/**
	 * @param array<string,mixed> $settings Editor settings.
	 * @return array<string,mixed>
	 */
	public function add_localize_settings( array $settings ): array {
		$settings['eclSiteId'] = (string) get_current_blog_id();
		return $settings;
	}

	public function register_rest_header_bridge(): void {
		$handle = 'ecl-rest-header-bridge';
		wp_register_script( $handle, false, [], ECL_VERSION, false );
		wp_enqueue_script( $handle );

		$nonce = wp_create_nonce( Class_Save_Guard::NONCE_ACTION );
		$json  = wp_json_encode(
			[
				'nonce'  => $nonce,
				'header' => Class_Save_Guard::HEADER,
			],
			JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
		);

		$inline = <<<JS
( function() {
	if ( window.__eclRestHeaderBridge ) {
		return;
	}
	window.__eclRestHeaderBridge = true;
	var cfg = {$json};
	if ( ! cfg || ! cfg.nonce ) {
		return;
	}
	var HEADER = cfg.header || 'X-ECL-Unlock-Token';
	var nonce = cfg.nonce;
	function shouldAugment( method, url ) {
		var m = String( method || 'GET' ).toUpperCase();
		if ( 'PUT' !== m ) {
			return false;
		}
		var u = String( url || '' );
		return u.indexOf( 'elementor/v1/global-classes' ) !== -1 && u.indexOf( '/usage' ) === -1;
	}
	var xhrOpen = XMLHttpRequest.prototype.open;
	var xhrSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function( method, url ) {
		this.__eclMethod = method;
		this.__eclUrl = url;
		return xhrOpen.apply( this, arguments );
	};
	XMLHttpRequest.prototype.send = function( body ) {
		if ( this.__eclMethod && shouldAugment( this.__eclMethod, this.__eclUrl ) ) {
			try {
				this.setRequestHeader( HEADER, nonce );
			} catch ( e ) {}
		}
		return xhrSend.call( this, body );
	};
	if ( window.fetch ) {
		var nativeFetch = window.fetch;
		window.fetch = function( input, init ) {
			init = init || {};
			var url = ( typeof input === 'string' ) ? input : ( input && input.url ) || '';
			var method = init.method || ( input && input.method ) || 'GET';
			if ( shouldAugment( method, url ) ) {
				var headers = new Headers( init.headers || {} );
				if ( ! headers.has( HEADER ) ) {
					headers.set( HEADER, nonce );
				}
				init.headers = headers;
			}
			return nativeFetch.call( window, input, init );
		};
	}
} )();
JS;

		wp_add_inline_script( $handle, $inline, 'after' );
	}

	public function enqueue_editor_assets(): void {
		wp_enqueue_script(
			'elementor-class-lock-editor',
			ECL_URL . 'assets/js/editor.js',
			[
				'elementor-common',
				'elementor-editor',
				'wp-hooks',
				'ecl-rest-header-bridge',
			],
			ECL_VERSION,
			true
		);

		wp_localize_script(
			'elementor-class-lock-editor',
			'elementorClassLockConfig',
			[
				'atomicActive'     => Plugin::is_atomic_editor_available(),
				'unlockNonce'      => wp_create_nonce( Class_Save_Guard::NONCE_ACTION ),
				'restRoot'         => esc_url_raw( rest_url() ),
				'restNonce'        => wp_create_nonce( 'wp_rest' ),
				'debug'            => ( defined( 'WP_DEBUG' ) && WP_DEBUG ),
				'elementorVersion' => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '',
				'i18n'             => [
					'locked'          => __( 'Class is locked — the kit definition is kept on save. Unlock to edit this class globally.', 'elementor-class-lock' ),
					'unlocked'        => __( 'You are now editing this class globally.', 'elementor-class-lock' ),
					'unlockedAriaHint' => __( 'Class is unlocked — switching to another class or element will re-lock it.', 'elementor-class-lock' ),
					'promote'         => __( 'Promote to Global', 'elementor-class-lock' ),
					'promoteDisabled' => __( 'Select an element with local overrides to promote.', 'elementor-class-lock' ),
					'panelNotFound'   => __( 'Elementor Class Lock could not find the editor panel root (#elementor-panel-inner). The class list UI may have changed in this Elementor version.', 'elementor-class-lock' ),
					'hintToast'       => __( 'Class Lock: padlocks appear on global kit classes (labels that exist in Site Settings → Global Classes). The “Local” chip is not a global class, so it has no lock.', 'elementor-class-lock' ),
					'atomicOffToast'  => __( 'Class Lock: the “Atomic elements” experiment is off in WordPress, so the REST save guard is inactive. Enable it under Elementor → Settings → Features. Padlocks on global class chips still work when the kit list loads.', 'elementor-class-lock' ),
					'kitRewrittenToast' => __( 'Class Lock: a locked global class was reverted in the save request so the kit definition is unchanged. Unlock that class to allow global edits.', 'elementor-class-lock' ),
					'editBlockedToast'  => __( 'This global class is locked. Click the open padlock on its class chip to edit kit styles.', 'elementor-class-lock' ),
				],
			]
		);

		wp_enqueue_style(
			'elementor-class-lock-editor',
			ECL_URL . 'assets/css/editor.css',
			[],
			ECL_VERSION
		);

		wp_add_inline_script(
			'elementor-class-lock-editor',
			'window.ELEMENTOR_CLASS_LOCK_ACTIVE=true;',
			'after'
		);
	}
}
