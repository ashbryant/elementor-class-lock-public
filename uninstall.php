<?php
/**
 * Fired when the plugin is uninstalled.
 *
 * @package ElementorClassLock
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'ecl_version' );

global $wpdb;

$like_transient = $wpdb->esc_like( '_transient_ecl_' ) . '%';
$like_timeout   = $wpdb->esc_like( '_transient_timeout_ecl_' ) . '%';

$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$like_transient,
		$like_timeout
	)
);
