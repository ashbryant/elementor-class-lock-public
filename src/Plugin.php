<?php
/**
 * Core plugin bootstrap.
 *
 * @package ElementorClassLock
 */

namespace ElementorClassLock;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Singleton plugin entry.
 */
final class Plugin {

	private static ?self $instance = null;

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function init(): void {
		add_action( 'admin_init', [ $this, 'maybe_show_activation_error' ] );
		add_action( 'admin_notices', [ $this, 'maybe_notice_atomic_experiment_off' ] );

		Editor_Integration::instance()->register();

		if ( self::is_atomic_editor_available() ) {
			Class_Save_Guard::instance()->register();
		}
	}

	public static function is_elementor_plugin_active(): bool {
		if ( ! function_exists( 'is_plugin_active' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		return is_plugin_active( 'elementor/elementor.php' );
	}

	public static function is_atomic_editor_available(): bool {
		if ( ! class_exists( '\Elementor\Plugin', false ) ) {
			return false;
		}
		$experiments = \Elementor\Plugin::$instance->experiments ?? null;
		if ( ! $experiments ) {
			return false;
		}
		return $experiments->is_feature_active( 'e_atomic_elements' );
	}

	public function maybe_show_activation_error(): void {
		$error = get_transient( 'ecl_activation_failed' );
		if ( ! $error ) {
			return;
		}
		delete_transient( 'ecl_activation_failed' );
		if ( 'no_elementor' !== $error ) {
			return;
		}
		self::render_admin_notice(
			esc_html__( 'Elementor Class Lock was deactivated because Elementor is not active. Install and activate Elementor first.', 'elementor-class-lock' ),
			'error',
			true
		);
	}

	public function maybe_notice_atomic_experiment_off(): void {
		if ( ! is_admin() || ! self::is_elementor_plugin_active() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		if ( self::is_atomic_editor_available() ) {
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		$allowed_ids = [
			'dashboard',
			'plugins',
			'toplevel_page_elementor',
			'elementor_page_elementor-settings',
			'edit-elementor_library',
		];
		if ( $screen && ! in_array( $screen->id, $allowed_ids, true ) ) {
			return;
		}
		self::render_admin_notice(
			esc_html__( 'Elementor Class Lock is active, but the “Atomic elements” experiment is off. Enable it under Elementor → Settings → Features to use REST protection for global class kit saves.', 'elementor-class-lock' ),
			'warning',
			true
		);
	}

	/**
	 * @param string $message     Escaped message (pass through esc_html__ before calling).
	 * @param string $type        notice type: error|warning|success|info
	 * @param bool   $dismissible Whether the notice is dismissible.
	 */
	private static function render_admin_notice( string $message, string $type, bool $dismissible ): void {
		if ( function_exists( 'wp_admin_notice' ) ) {
			wp_admin_notice(
				$message,
				[
					'type'        => $type,
					'dismissible' => $dismissible,
				]
			);
			return;
		}
		$class = 'notice notice-' . $type;
		if ( $dismissible ) {
			$class .= ' is-dismissible';
		}
		printf(
			'<div class="%1$s"><p>%2$s</p></div>',
			esc_attr( $class ),
			wp_kses_post( $message )
		);
	}
}
