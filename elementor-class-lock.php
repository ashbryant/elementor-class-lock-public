<?php
/**
 * Plugin Name:       Elementor Class Lock
 * Plugin URI:        https://github.com/ashbryant/elementor-class-lock
 * Description:       Locks global CSS classes in the Elementor V4 atomic editor so style edits stay on the element until you explicitly unlock.
 * Version:           1.0.27
 * Requires at least: 6.4
 * Requires PHP:      8.0
 * Author:            Ash Bryant
 * Author URI:        https://github.com/ashbryant
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       elementor-class-lock
 * Requires Plugins:  elementor
 *
 * @package ElementorClassLock
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ECL_VERSION', '1.0.26' );
define( 'ECL_FILE', __FILE__ );
define( 'ECL_PATH', plugin_dir_path( __FILE__ ) );
define( 'ECL_URL', plugin_dir_url( __FILE__ ) );

spl_autoload_register(
	static function ( string $class ): void {
		$prefix = 'ElementorClassLock\\';
		$len     = strlen( $prefix );
		if ( strncmp( $prefix, $class, $len ) !== 0 ) {
			return;
		}
		$relative = substr( $class, $len );
		$file     = ECL_PATH . 'src/' . str_replace( '\\', '/', $relative ) . '.php';
		if ( is_readable( $file ) ) {
			require_once $file;
		}
	}
);

register_activation_hook(
	ECL_FILE,
	static function (): void {
		if ( ! function_exists( 'deactivate_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! ElementorClassLock\Plugin::is_elementor_plugin_active() ) {
			deactivate_plugins( plugin_basename( ECL_FILE ) );
			set_transient( 'ecl_activation_failed', 'no_elementor', 60 );
			return;
		}
		update_option( 'ecl_version', ECL_VERSION, false );
	}
);

/*
 * Uninstall is handled by uninstall.php (WordPress loads it automatically).
 * Do not use register_uninstall_hook() with a closure — it is persisted in the
 * uninstall_plugins option and closures cannot be serialised, which fatals on activation.
 */

add_action(
	'elementor/loaded',
	static function (): void {
		ElementorClassLock\Plugin::instance()->init();
	},
	20
);
