<?php
/**
 * WP_DEBUG-gated logging.
 *
 * @package ElementorClassLock
 */

namespace ElementorClassLock;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Lightweight debug logger (no-op unless WP_DEBUG is true).
 */
final class Logger {

	public static function log( string $message, array $context = [] ): void {
		if ( ! defined( 'WP_DEBUG' ) || ! WP_DEBUG ) {
			return;
		}
		if ( ! function_exists( 'wp_debug_log' ) ) {
			return;
		}
		$line = '[ECL] ' . $message;
		if ( $context ) {
			$line .= ' ' . wp_json_encode( $context, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		}
		wp_debug_log( $line );
	}
}
